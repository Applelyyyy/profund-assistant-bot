import { spawn, ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { db } from "../../../packages/database/src/index";
import { env, logger } from "../../../packages/config/src/index";
import { databaseBackup } from "../../../packages/config/src/backup";
import { locked, event } from "../../../packages/queue-engine/src/index";
if (env().SERVICE_CONTROL_ENABLED !== "true")
  throw new Error("Service control is disabled.");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const services = {
  bot: "apps/bot/src/index.ts",
  worker: "apps/worker/src/index.ts",
} as const;
const children = new Map<string, ChildProcess>();
let stopping = false,
  busy = false;
function start(name: keyof typeof services) {
  const child = spawn(process.execPath, ["--import", "tsx", services[name]], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  children.set(name, child);
  child.on("exit", () => {
    if (!stopping && children.get(name) === child)
      setTimeout(() => {
        if (!stopping) start(name);
      }, 3000);
  });
}
async function restart(name: keyof typeof services) {
  const child = children.get(name);
  children.delete(name);
  if (child && child.exitCode === null) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new Error(
              "Graceful shutdown exceeded 30 seconds. Process was not forcibly killed.",
            ),
          ),
        30000,
      );
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
  start(name);
}
for (const name of ["bot", "worker"] as const) start(name);
async function tick() {
  if (stopping || busy) return;
  busy = true;
  try {
    await db.serviceHeartbeat.upsert({
      where: { service: "ops-agent" },
      create: { service: "ops-agent", status: "online" },
      update: { status: "online" },
    });
    for (const op of await db.serviceOperation.findMany({
      where: {
        guildId: env().DISCORD_GUILD_ID,
        status: "PENDING",
        action: { in: ["restart_bot", "restart_worker", "backup"] },
      },
      orderBy: { createdAt: "asc" },
      take: 1,
    })) {
      const claimed = await db.serviceOperation.updateMany({
        where: { id: op.id, status: "PENDING" },
        data: { status: "RUNNING" },
      });
      if (!claimed.count) continue;
      try {
        const admin = await db.adminUser.findUnique({
          where: { id: op.actorId },
        });
        if (!admin || admin.disabled || admin.role !== "OWNER")
          throw new Error("An active owner account is required.");
        if (op.action === "backup") {
          await databaseBackup(
            env().DATABASE_URL,
            `${root}/backups/ta-${Date.now()}.dump`,
          );
        } else await restart(op.action === "restart_bot" ? "bot" : "worker");
        await db.serviceOperation.update({
          where: { id: op.id },
          data: { status: "COMPLETED", completedAt: new Date() },
        });
        await locked(op.guildId, (tx) =>
          event(
            tx,
            op.guildId,
            op.actorId,
            "service.completed",
            `${op.action} completed.`,
            { operationId: op.id },
          ),
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Supervisor operation failed.";
        await db.serviceOperation.update({
          where: { id: op.id },
          data: { status: "FAILED", error: message },
        });
        logger.error({ err: error }, "Supervisor operation failed");
      }
    }
  } catch (error) {
    logger.error({ err: error }, "Supervisor poll failed");
  } finally {
    busy = false;
  }
}
const timer = setInterval(() => void tick(), 2000);
async function shutdown() {
  stopping = true;
  clearInterval(timer);
  for (const child of children.values()) child.kill("SIGTERM");
  while (
    busy ||
    [...children.values()].some(
      (c) => c.exitCode === null && c.signalCode === null,
    )
  )
    await new Promise((r) => setTimeout(r, 100));
  await db.$disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
