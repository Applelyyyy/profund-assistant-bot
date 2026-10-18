import { test, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { db } from "../packages/database/src/index";
import { settingsSchema } from "../packages/shared/src/index";
import {
  admission,
  startSession,
  integrity,
} from "../packages/queue-engine/src/index";
import { reconcileGuild } from "../apps/worker/src/recovery";

beforeAll(() => {
  const url = process.env.TEST_DATABASE_URL;
  if (
    !url ||
    url !== process.env.DATABASE_URL ||
    !new URL(url).pathname.endsWith("_test")
  )
    throw new Error("Dedicated test database required");
});

async function fixture(noShowTimeoutSeconds = 1) {
  const guildId = randomUUID();
  await db.guild.create({
    data: {
      id: guildId,
      name: "Synthetic recovery load",
      settings: settingsSchema.parse({
        minCapacity: 1,
        maxCapacity: 200,
        noShowTimeoutSeconds,
        staleWarningSeconds: 30,
      }),
    },
  });
  const coursework = await db.coursework.create({
    data: { guildId, name: "Synthetic" },
  });
  const sessions = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      startSession(guildId, `ta-${i}`, randomUUID(), {
        taName: `TA ${i}`,
        voiceChannelId: `room-${i}`,
        capacity: 7,
        courseworkIds: [],
        roleIds: [],
        note: "",
      }),
    ),
  );
  await db.student.createMany({
    data: Array.from({ length: 70 }, (_, i) => ({
      guildId,
      studentId: `00${i}`,
      discordId: `student-${i}`,
      name: "Synthetic",
      lastname: "Student",
      registration: "REGISTERED",
    })),
  });
  const tickets = await Promise.all(
    Array.from({ length: 70 }, (_, i) =>
      admission(guildId, `student-${i}`, randomUUID(), coursework.id),
    ),
  );
  await db.queueTicket.updateMany({
    where: { guildId },
    data: {
      updatedAt: new Date(Date.now() - 120000),
      createdAt: new Date(Date.now() - 120000),
    },
  });
  for (let i = 0; i < 10; i++)
    await db.queueTicket.update({
      where: { id: tickets[i].id },
      data: {
        status: "MOVE_FAILED",
        sessionId: sessions[i].id,
        updatedAt: new Date(Date.now() - 120000),
      },
    });
  return { guildId, tickets };
}

test("70 waiting tickets with ten stale moves reconcile repeatedly without duplicate warnings or reservation loss", async () => {
  const { guildId } = await fixture();
  const trace = (
    globalThis as unknown as {
      performanceTrace?: { phase: string; counts: Record<string, number> };
    }
  ).performanceTrace;
  const samples: number[] = [];
  const begin = performance.now(),
    cpu = process.cpuUsage();
  if (trace) trace.phase = "recovery70";
  try {
    for (
      let i = 0;
      i < (process.env.CONCURRENT_BENCHMARK_OUTPUT ? 100 : 3);
      i++
    ) {
      const start = performance.now();
      await reconcileGuild(guildId);
      samples.push(performance.now() - start);
    }
  } finally {
    if (trace) trace.phase = "";
  }
  expect(
    await db.systemEvent.count({ where: { guildId, type: "queue.stale" } }),
  ).toBe(10);
  expect(
    await db.queueReservation.count({ where: { ticket: { guildId } } }),
  ).toBe(70);
  expect(await integrity(guildId)).toMatchObject({ ok: true });
  if (process.env.CONCURRENT_BENCHMARK_OUTPUT) {
    const sorted = [...samples].sort((a, b) => a - b);
    const percentile = (p: number) => sorted[Math.ceil(sorted.length * p) - 1];
    writeFileSync(
      process.env.CONCURRENT_BENCHMARK_OUTPUT,
      JSON.stringify(
        {
          samples: samples.length,
          p50Ms: percentile(0.5),
          p95Ms: percentile(0.95),
          p99Ms: percentile(0.99),
          sqlQueries: trace?.counts.recovery70,
          elapsedMs: performance.now() - begin,
          cpu: process.cpuUsage(cpu),
          memory: process.memoryUsage(),
          synthetic: true,
          discordNetwork: false,
        },
        null,
        2,
      ),
    );
  }
});

test("concurrent recovery uses durable keys for no-show checks and resolves the same abandoned incident", async () => {
  const { guildId } = await fixture(1);
  await db.tASession.updateMany({
    where: { guildId },
    data: { present: false },
  });
  await Promise.all([reconcileGuild(guildId), reconcileGuild(guildId)]);
  const first = await db.queueIncident.findUniqueOrThrow({
    where: { guildId },
  });
  expect(first.resolvedAt).toBeNull();
  const operations = await db.serviceOperation.findMany({
    where: { guildId, action: "check_no_show" },
  });
  const records = await db.idempotencyRecord.findMany({
    where: { guildId, action: "check_no_show" },
  });
  expect(operations).toHaveLength(records.length);
  expect(operations.length).toBeGreaterThanOrEqual(70);
  expect(
    await db.systemEvent.count({ where: { guildId, type: "queue.stale" } }),
  ).toBe(10);
  await db.tASession.updateMany({
    where: { guildId },
    data: { present: true },
  });
  await Promise.all([reconcileGuild(guildId), reconcileGuild(guildId)]);
  expect(
    await db.queueIncident.findUniqueOrThrow({ where: { guildId } }),
  ).toMatchObject({ startedAt: first.startedAt, resolvedAt: expect.any(Date) });
  expect(
    await db.systemEvent.count({ where: { guildId, type: "queue.recovered" } }),
  ).toBe(1);
  expect(await integrity(guildId)).toMatchObject({ ok: true });
});
