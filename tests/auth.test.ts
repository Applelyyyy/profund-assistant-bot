import { test, expect, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { db } from "../packages/database/src/index";
import {
  passwordHash,
  login,
  authenticate,
  sessionCookie,
  secureEqual,
  tokenHash,
  resetAdministrator,
  bootstrap,
} from "../packages/shared/src/auth";
import { env } from "../packages/config/src/index";
afterAll(() => db.$disconnect());
test("Argon2 login, CSRF, role enforcement, session revocation and rate limit", async () => {
  if (!process.env.TEST_DATABASE_URL)
    throw new Error("Use a dedicated test database.");
  const username = `auth-${Date.now()}`;
  const password = randomBytes(20).toString("hex");
  const user = await db.adminUser.create({
    data: {
      username,
      passwordHash: await passwordHash(password),
      role: "VIEWER",
    },
  });
  expect(user.passwordHash).toMatch(/^\$argon2id\$/);
  const signed = await login(username, password, "test");
  const cookie = sessionCookie(signed.token);
  const request = (headers: Record<string, string> = {}) =>
    new Request(`${env().APP_BASE_URL}/api/settings`, {
      headers: { cookie, ...headers },
    });
  expect((await authenticate(request())).admin.id).toBe(user.id);
  await expect(authenticate(request(), true, "ADMIN")).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(authenticate(request(), true, "VIEWER")).rejects.toMatchObject({
    code: "ORIGIN",
  });
  await expect(
    authenticate(request({ origin: env().APP_BASE_URL }), true, "VIEWER"),
  ).rejects.toMatchObject({ code: "CSRF" });
  expect(
    (
      await authenticate(
        request({
          origin: env().APP_BASE_URL,
          "x-csrf-token": signed.session.csrf,
        }),
        true,
      )
    ).admin.id,
  ).toBe(user.id);
  const { POST, GET } = await import("../apps/web/app/api/[...path]/route");
  const { NextRequest } = await import("next/server");
  const diagnostics = await GET(
    new NextRequest(`${env().APP_BASE_URL}/api/logs/runtime`, {
      headers: { cookie },
    }),
    { params: Promise.resolve({ path: ["logs", "runtime"] }) },
  );
  expect(diagnostics.status).toBe(403);
  const logout = await POST(
    new NextRequest(`${env().APP_BASE_URL}/api/logout`, {
      method: "POST",
      headers: {
        cookie,
        origin: env().APP_BASE_URL,
        "x-csrf-token": signed.session.csrf,
      },
    }),
    { params: Promise.resolve({ path: ["logout"] }) },
  );
  expect(logout.status).toBe(200);
  expect(
    await db.adminSession.findUnique({
      where: { id: tokenHash(signed.token) },
    }),
  ).toBeNull();
  await expect(authenticate(request())).rejects.toMatchObject({ code: "AUTH" });
  for (let i = 0; i < 5; i++)
    await expect(
      login(username, "wrong", "rate-limit-test"),
    ).rejects.toMatchObject({ code: "LOGIN" });
  await expect(
    login(username, password, "rate-limit-test"),
  ).rejects.toMatchObject({ code: "RATE_LIMIT" });
  expect(secureEqual("abc", "abc")).toBe(true);
  expect(secureEqual("abc", "def")).toBe(false);
  expect(secureEqual("abc", "ééé")).toBe(false);
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("SameSite=Strict");
});

test("explicit administrator reset preserves role, revokes sessions and audits without plaintext", async () => {
  if (!process.env.TEST_DATABASE_URL)
    throw new Error("Use a dedicated test database.");
  await db.guild.upsert({
    where: { id: env().DISCORD_GUILD_ID },
    create: { id: env().DISCORD_GUILD_ID, name: "Test" },
    update: {},
  });
  const username = `reset-${Date.now()}`;
  const oldPassword = randomBytes(20).toString("hex");
  const password = randomBytes(20).toString("hex");
  const user = await db.adminUser.create({
    data: {
      username,
      passwordHash: await passwordHash(oldPassword),
      role: "ADMIN",
    },
  });
  const signed = await login(username, oldPassword, "reset-test");
  await expect(bootstrap(username, password)).rejects.toThrow("already exists");
  expect(
    (await db.adminUser.findUniqueOrThrow({ where: { id: user.id } }))
      .passwordHash,
  ).toBe(user.passwordHash);
  await resetAdministrator(username, password);
  const updated = await db.adminUser.findUniqueOrThrow({
    where: { id: user.id },
  });
  expect(updated.role).toBe("ADMIN");
  expect(updated.passwordHash).toMatch(/^\$argon2id\$/);
  expect(updated.passwordHash).not.toBe(user.passwordHash);
  expect(await db.adminSession.count({ where: { adminId: user.id } })).toBe(0);
  await expect(
    authenticate(
      new Request(env().APP_BASE_URL, {
        headers: { cookie: sessionCookie(signed.token) },
      }),
    ),
  ).rejects.toMatchObject({ code: "AUTH" });
  await expect(
    login(username, oldPassword, "old-reset-test"),
  ).rejects.toMatchObject({ code: "LOGIN" });
  expect((await login(username, password, "new-reset-test")).user.id).toBe(
    user.id,
  );
  const audit = await db.systemEvent.findFirstOrThrow({
    where: { actorId: user.id, type: "admin.password_reset" },
  });
  expect(JSON.stringify(audit)).not.toContain(password);
  await expect(
    resetAdministrator("nonexistent-reset-user", password),
  ).rejects.toThrow("not found");
  await expect(resetAdministrator(username, "short")).rejects.toThrow("14–256");
});
