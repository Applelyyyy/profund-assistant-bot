import { refreshForEvents } from "../../../packages/shared/src/live-updates";
import {
  measure,
  stopPerformanceMonitor,
} from "../../../packages/config/src/performance";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { db } from "../../../packages/database/src/index";
import { env, logger } from "../../../packages/config/src/index";
import { reconcileGuild } from "./recovery";
const connection = new Redis(env().REDIS_URL, { maxRetriesPerRequest: null });
connection.on("error", (e) =>
  logger.warn(
    { message: e.message },
    "Redis unavailable; durable reconciliation will resume",
  ),
);
const jobs = new Queue("discord-sync", {
  connection,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 100,
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
  },
});
let stopping = false,
  busy = false;
async function tick() {
  return measure("worker.tick", runTick);
}
async function runTick() {
  if (stopping || busy) return;
  busy = true;
  try {
    const guildId = env().DISCORD_GUILD_ID;
    await db.serviceHeartbeat.upsert({
      where: { service: "worker" },
      create: {
        service: "worker",
        status: "online",
        detail: "Outbox and recovery scheduler",
      },
      update: { status: "online" },
    });
    await reconcileGuild(guildId);
    await db.adminSession.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    await db.draftSelection.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    await db.loginAttempt.deleteMany({
      where: { windowAt: { lt: new Date(Date.now() - 86400000) } },
    });
    const events = await db.systemEvent.findMany({
      where: { guildId, dispatchedAt: null },
      orderBy: { id: "asc" },
      take: 1000,
      select: { id: true, type: true },
    });
    if (events.length) {
      await jobs.add(
        "synchronize",
        {
          lastEvent: events.at(-1)!.id,
          panels: refreshForEvents(events.map((e) => e.type)).panels,
        },
        { jobId: `events-${events.at(-1)!.id}` },
      );
      await db.systemEvent.updateMany({
        where: { id: { in: events.map((e) => e.id) } },
        data: { dispatchedAt: new Date() },
      });
    }
  } catch (error) {
    logger.error({ err: error }, "Queue worker tick failed");
  } finally {
    busy = false;
  }
}
const timer = setInterval(() => void tick(), 2000);
void tick();
async function shutdown() {
  stopping = true;
  clearInterval(timer);
  while (busy) await new Promise((r) => setTimeout(r, 100));
  stopPerformanceMonitor();
  await jobs.close();
  await connection.quit();
  await db.serviceHeartbeat.updateMany({
    where: { service: "worker" },
    data: { status: "offline" },
  });
  await db.$disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
