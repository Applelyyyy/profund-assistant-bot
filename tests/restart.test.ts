import { test, expect, afterAll } from "vitest";
import { spawn, ChildProcess } from "node:child_process";
import { db } from "../packages/database/src/index";
import { env } from "../packages/config/src/index";
import { settingsSchema } from "../packages/shared/src/index";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { randomUUID } from "node:crypto";
import {
  startSession,
  admission,
  setPresence,
} from "../packages/queue-engine/src/index";
async function stop(child: ChildProcess) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Worker did not exit gracefully.")),
      15000,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
async function heartbeatAfter(time: number) {
  for (let n = 0; n < 100; n++) {
    const heartbeat = await db.serviceHeartbeat.findUnique({
      where: { service: "worker" },
    });
    if (
      heartbeat &&
      heartbeat.status === "online" &&
      heartbeat.updatedAt.getTime() > time
    )
      return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Worker heartbeat did not become ready.");
}
afterAll(() => db.$disconnect());
test("actual worker shutdown and restart preserve ticket, sequence, reservation and mappings", async () => {
  if (!process.env.TEST_DATABASE_URL)
    throw new Error("Dedicated test database required.");
  const guildId = `9${Date.now()}0001`;
  const course = await db.guild.create({
    data: {
      id: guildId,
      name: "Restart test",
      settings: settingsSchema.parse({ minCapacity: 1, defaultCapacity: 1 }),
      coursework: { create: { name: "Restart course" } },
    },
    include: { coursework: true },
  });
  await startSession(guildId, "restart-ta", "start", {
    taName: "Restart TA",
    voiceChannelId: "restart-room",
    capacity: 1,
    courseworkIds: [],
    roleIds: [],
    note: "",
  });
  await db.student.create({
    data: {
      guildId,
      studentId: "001",
      name: "Restart",
      lastname: "Student",
      discordId: "restart-student",
      registration: "REGISTERED",
    },
  });
  const ticket = await admission(
    guildId,
    "restart-student",
    "admit",
    course.coursework[0].id,
  );
  const before = JSON.stringify(
    await db.queueTicket.findUniqueOrThrow({
      where: { id: ticket.id },
      include: { reservation: true, student: true },
    }),
  );
  const draft = await db.draftSelection.create({
    data: {
      guildId,
      discordId: "restart-student",
      courseworkId: course.coursework[0].id,
      expiresAt: new Date(Date.now() + 1800000),
    },
  });
  const template = await db.embedTemplate.create({
    data: {
      guildId,
      feature: "ta_room_queue_panel",
      name: "Restart room",
      document: (await import("../packages/discord-ui/src/index")).defaults
        .ta_room_queue_panel,
    },
  });
  const panel = await db.publishedPanel.create({
    data: {
      guildId,
      templateId: template.id,
      channelId: "restart-room",
      messageId: "persistent-restart-message",
    },
  });
  const visibility = [
    {
      channelId: "100000000000000088",
      policy: "UNVERIFIED_ONLY",
      roleIds: [],
      deniedRoleIds: [],
      autoSync: true,
    },
  ];
  const beforeSettings = settingsSchema.parse(course.settings);
  await db.guild.update({
    where: { id: guildId },
    data: { settings: { ...beforeSettings, channelVisibility: visibility } },
  });
  const redis = new URL(env().REDIS_URL);
  redis.pathname = "/15";
  const redisConnection = new Redis(redis.toString(), {
    maxRetriesPerRequest: null,
  });
  const jobs = new Queue("discord-sync", { connection: redisConnection });
  // Database 15 is reserved for this test's queue; fresh PostgreSQL fixtures reuse event IDs.
  await jobs.obliterate({ force: true });
  const start = () =>
    spawn(process.execPath, ["--import", "tsx", "apps/worker/src/index.ts"], {
      env: {
        ...process.env,
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        DISCORD_GUILD_ID: guildId,
        REDIS_URL: redis.toString(),
        LOG_LEVEL: "fatal",
      },
      stdio: "ignore",
    });
  const waitingObservation = await db.waitingPresence.create({
    data: {
      guildId,
      discordId: "unqueued-restart-student",
      voiceChannelId: "restart-waiting-room",
    },
  });
  const waitingIncident = await db.waitingRoomAlert.create({
    data: {
      guildId,
      scope: "all",
      notifiedAt: new Date(),
      lastNotifiedAt: new Date(),
      channelId: "restart-alert-room",
      messageId: "persistent-waiting-alert",
      mentionAttempted: true,
    },
  });
  const t1 = Date.now();
  await db.systemEvent.createMany({
    data: Array.from({ length: 200 }, () => ({
      guildId,
      actorId: "synthetic",
      type: "inspection.note",
      message: "Synthetic outbox burst",
      correlationId: randomUUID(),
    })),
  });
  const first = start();
  await heartbeatAfter(t1);
  let delivered = false;
  for (let i = 0; i < 100; i++) {
    delivered =
      (await db.systemEvent.count({
        where: {
          guildId,
          type: "inspection.note",
          dispatchedAt: { not: null },
        },
      })) === 200;
    if (delivered) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await stop(first);
  expect(delivered).toBe(true);
  const deliveredEvents = await db.systemEvent.findMany({
    where: { guildId, type: "inspection.note" },
    orderBy: { id: "asc" },
  });
  const burstJobs = async () =>
    (
      await jobs.getJobs(
        ["wait", "active", "completed", "failed", "delayed"],
        0,
        -1,
      )
    )
      .filter(
        (j) =>
          j.data.lastEvent >= deliveredEvents[0].id &&
          j.data.lastEvent <= deliveredEvents.at(-1)!.id,
      )
      .map((j) => j.id)
      .sort();
  const beforeJobs = await burstJobs();
  expect(beforeJobs).toHaveLength(1);
  if (process.env.CONCURRENT_OUTBOX_OUTPUT) {
    const { writeFileSync } = await import("node:fs");
    const times = deliveredEvents
      .map((e) => e.dispatchedAt!.getTime() - e.createdAt.getTime())
      .sort((a, b) => a - b);
    writeFileSync(
      process.env.CONCURRENT_OUTBOX_OUTPUT,
      JSON.stringify(
        {
          samples: 200,
          p50Ms: times[99],
          p95Ms: times[189],
          p99Ms: times[197],
          jobs: beforeJobs.length,
          redisReal: true,
          botConsumer: false,
        },
        null,
        2,
      ),
    );
  }
  await setPresence(guildId, "restart-ta", null);
  await db.queueIncident.create({
    data: {
      guildId,
      startedAt: new Date(Date.now() - 120000),
      unresolvedCount: 1,
    },
  });
  const previousAlert = await db.systemEvent.create({
    data: {
      guildId,
      actorId: "system",
      type: "queue.abandoned",
      message: "Earlier incident",
      correlationId: "restart-alert-test",
    },
  });
  expect(
    await db.waitingPresence.findUniqueOrThrow({
      where: {
        guildId_discordId: { guildId, discordId: waitingObservation.discordId },
      },
    }),
  ).toEqual(waitingObservation);
  expect(
    await db.waitingRoomAlert.findUniqueOrThrow({
      where: { guildId_scope: { guildId, scope: "all" } },
    }),
  ).toEqual(waitingIncident);
  const t2 = Date.now();
  const second = start();
  await heartbeatAfter(t2);
  await stop(second);
  try {
    expect(await burstJobs()).toEqual(beforeJobs);
  } finally {
    await jobs.close();
    await redisConnection.quit();
  }
  expect(
    await db.serviceOperation.count({
      where: { guildId, action: "abandoned_alert" },
    }),
  ).toBe(0);
  await db.systemEvent.update({
    where: { id: previousAlert.id },
    data: { createdAt: new Date(Date.now() - 700000) },
  });
  const taRole = "100000000000000066";
  const settings = settingsSchema.parse(
    (await db.guild.findUniqueOrThrow({ where: { id: guildId } })).settings,
  );
  await db.guild.update({
    where: { id: guildId },
    data: { settings: { ...settings, taRole } },
  });
  await db.channelBinding.create({
    data: { guildId, feature: "ta_voice", channelIds: ["never-started-room"] },
  });
  await db.tAPresence.create({
    data: {
      guildId,
      taId: "never-started-ta",
      taName: "Available without admission session",
      voiceChannelId: "never-started-room",
      roleIds: [taRole],
    },
  });
  const availableAt = Date.now();
  const available = start();
  await heartbeatAfter(availableAt);
  await stop(available);
  expect(
    await db.serviceOperation.count({
      where: { guildId, action: "abandoned_alert" },
    }),
  ).toBe(0);
  expect(
    (await db.queueIncident.findUniqueOrThrow({ where: { guildId } }))
      .resolvedAt,
  ).not.toBeNull();
  await db.tAPresence.deleteMany({ where: { guildId } });
  await db.queueIncident.update({
    where: { guildId },
    data: {
      resolvedAt: null,
      notifiedAt: null,
      startedAt: new Date(Date.now() - 120000),
    },
  });
  const thirdTime = Date.now();
  const third = start();
  await heartbeatAfter(thirdTime);
  await stop(third);
  expect(
    await db.serviceOperation.count({
      where: { guildId, action: "abandoned_alert" },
    }),
  ).toBe(1);
  expect(
    JSON.stringify(
      await db.queueTicket.findUniqueOrThrow({
        where: { id: ticket.id },
        include: { reservation: true, student: true },
      }),
    ),
  ).toBe(before);
  expect(
    (await db.guild.findUniqueOrThrow({ where: { id: guildId } })).nextSequence,
  ).toBe(ticket.sequence);
  expect(
    await db.draftSelection.findUniqueOrThrow({
      where: { guildId_discordId: { guildId, discordId: "restart-student" } },
    }),
  ).toEqual(draft);
  expect(
    (await db.publishedPanel.findUniqueOrThrow({ where: { id: panel.id } }))
      .messageId,
  ).toBe("persistent-restart-message");
  expect(await db.publishedPanel.count({ where: { guildId } })).toBe(1);
  expect(
    settingsSchema.parse(
      (await db.guild.findUniqueOrThrow({ where: { id: guildId } })).settings,
    ).channelVisibility,
  ).toEqual(visibility);
});
