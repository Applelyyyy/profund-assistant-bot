import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { hash, verify, argon2id } from "argon2";
import { db } from "../../database/src/index";
import { env } from "../../config/src/index";
import { DomainError } from "./index";
export const tokenHash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const passwordHash = (password: string) =>
  hash(password, {
    type: argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  });
export const secureEqual = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
function validateAdminCredentials(username: string, password: string) {
  if (
    !/^[a-zA-Z0-9_.-]{3,64}$/.test(username) ||
    password.length < 14 ||
    password.length > 256
  )
    throw new Error(
      "Bootstrap needs a username and a password of 14–256 characters.",
    );
}
export async function bootstrap(username: string, password: string) {
  validateAdminCredentials(username, password);
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(1800541)::text`;
    if (await tx.adminUser.count())
      throw new Error("Administrator already exists. Bootstrap is disabled.");
    return tx.adminUser.create({
      data: {
        username,
        passwordHash: await passwordHash(password),
        role: "OWNER",
      },
    });
  });
}
export async function resetAdministrator(username: string, password: string) {
  validateAdminCredentials(username, password);
  const hashed = await passwordHash(password);
  await db.$transaction(async (tx) => {
    const user = await tx.adminUser.findUnique({ where: { username } });
    if (!user)
      throw new Error(
        "Administrator not found. Check ADMIN_BOOTSTRAP_USERNAME in root .env.",
      );
    await tx.adminUser.update({
      where: { id: user.id },
      data: { passwordHash: hashed, disabled: false },
    });
    await tx.adminSession.deleteMany({ where: { adminId: user.id } });
    await tx.systemEvent.create({
      data: {
        guildId: env().DISCORD_GUILD_ID,
        actorId: user.id,
        type: "admin.password_reset",
        message:
          "Administrator password reset by the local recovery command; sessions revoked.",
        correlationId: randomUUID(),
      },
    });
  });
}
export async function login(
  username: string,
  password: string,
  remote: string,
) {
  const limitKey = tokenHash(remote + ":" + username.toLowerCase());
  const blocked = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${limitKey}, 0))::text`;
    const old = await tx.loginAttempt.findUnique({ where: { key: limitKey } });
    if (old && old.windowAt.getTime() > Date.now() - 900000) {
      if (old.count >= 5) return true;
      await tx.loginAttempt.update({
        where: { key: limitKey },
        data: { count: { increment: 1 } },
      });
    } else
      await tx.loginAttempt.upsert({
        where: { key: limitKey },
        create: { key: limitKey, count: 1 },
        update: { count: 1, windowAt: new Date() },
      });
    return false;
  });
  if (blocked)
    throw new DomainError(
      "RATE_LIMIT",
      "Too many login attempts. Try again in 15 minutes.",
      429,
    );
  const user = await db.adminUser.findUnique({ where: { username } });
  const dummy =
    "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$1qXZqYl0cz8x3sTcCJW3oqv4Ub3qQyUmfeHhZHTzqwc";
  const good = await verify(user?.passwordHash ?? dummy, password).catch(
    () => false,
  );
  if (!user || user.disabled || !good)
    throw new DomainError("LOGIN", "Incorrect username or password.", 401);
  const token = randomBytes(32).toString("hex");
  const session = await db.adminSession.create({
    data: {
      id: tokenHash(token),
      adminId: user.id,
      csrf: randomBytes(32).toString("hex"),
      expiresAt: new Date(Date.now() + 8 * 3600000),
    },
  });
  return { user, session, token };
}
export async function authenticate(
  request: Request,
  write = false,
  required = "VIEWER",
) {
  const raw = request.headers
    .get("cookie")
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("ta_session="))
    ?.slice(11);
  if (!raw) throw new DomainError("AUTH", "Sign in to continue.", 401);
  const session = await db.adminSession.findUnique({
    where: { id: tokenHash(raw) },
    include: { admin: true },
  });
  if (!session || session.expiresAt <= new Date() || session.admin.disabled)
    throw new DomainError("AUTH", "Session expired. Sign in again.", 401);
  const roles: Record<string, number> = {
    VIEWER: 0,
    OPERATOR: 1,
    ADMIN: 2,
    OWNER: 3,
  };
  if ((roles[session.admin.role] ?? -1) < roles[required])
    throw new DomainError(
      "FORBIDDEN",
      "Your account cannot perform this action.",
      403,
    );
  if (write) {
    if (request.headers.get("origin") !== new URL(env().APP_BASE_URL).origin)
      throw new DomainError("ORIGIN", "Request origin is not allowed.", 403);
    if (!secureEqual(session.csrf, request.headers.get("x-csrf-token") || ""))
      throw new DomainError("CSRF", "Refresh the page and try again.", 403);
  }
  return session;
}
export function sessionCookie(token: string, maxAge = 28800) {
  const secure = new URL(env().APP_BASE_URL).protocol === "https:";
  return `ta_session=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
