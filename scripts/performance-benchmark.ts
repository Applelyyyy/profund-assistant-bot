/** Isolated synthetic workload. Never points at production or calls Discord. */
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
async function main() {
  const url = process.env.TEST_DATABASE_URL;
  if (
    !url ||
    !new URL(url).pathname.endsWith("_test") ||
    process.env.DATABASE_URL !== url
  )
    throw new Error(
      "Set identical DATABASE_URL/TEST_DATABASE_URL to a dedicated database ending in _test.",
    );
  const profiler = new PrismaClient({
    datasourceUrl: url,
    log: [{ level: "query", emit: "event" }],
  });
  (globalThis as unknown as { taDb: PrismaClient }).taDb = profiler;
  let current: string | undefined;
  const counts: Record<string, number> = {},
    sqlTimes: number[] = [];
  profiler.$on("query", (e) => {
    if (current) {
      counts[current] = (counts[current] || 0) + 1;
      sqlTimes.push(e.duration);
    }
  });
  const { db } = await import("../packages/database/src/index");
  const engine = await import("../packages/queue-engine/src/index");
  const { settingsSchema } = await import("../packages/shared/src/index");
  const { GET } = await import("../apps/web/app/api/[...path]/route");
  const { NextRequest } = await import("next/server");
  const { tokenHash } = await import("../packages/shared/src/auth");
  const guildId = process.env.DISCORD_GUILD_ID!;
  const prefix = randomUUID();
  const settings = settingsSchema.parse({
    minCapacity: 1,
    maxCapacity: 200,
    defaultCapacity: 7,
  });
  await db.guild.upsert({
    where: { id: guildId },
    create: { id: guildId, name: "Performance workload", settings },
    update: { settings },
  });
  if (
    await db.queueTicket.count({
      where: { guildId },
    })
  )
    throw new Error(
      "Benchmark requires a fresh dedicated test guild without historical or active tickets.",
    );
  const course = await db.coursework.create({
    data: { guildId, name: "Synthetic coursework" },
  });
  const students = Array.from({ length: 200 }, (_, i) => ({
    id: prefix + "-student-" + i,
    guildId,
    studentId: "00" + prefix + "-" + i,
    discordId: prefix + "-discord-" + i,
    name: "Synthetic",
    lastname: "Student",
    registration: "REGISTERED",
  }));
  await db.student.createMany({ data: students });
  const tas = Array.from({ length: 10 }, (_, i) => prefix + "-ta-" + i);
  const inputs = tas.map((_, i) => ({
    taName: "Synthetic TA " + i,
    voiceChannelId: prefix + "-voice-" + i,
    capacity: 7,
    courseworkIds: [],
    roleIds: [],
    note: "",
  }));
  for (let i = 0; i < 10; i++)
    await engine.startSession(guildId, tas[i], randomUUID(), inputs[i]);
  const admin = await db.adminUser.create({
    data: {
      username: "perf-" + prefix,
      passwordHash: "unusable-test-hash",
      role: "OWNER",
    },
  });
  const raw = randomUUID();
  await db.adminSession.create({
    data: {
      id: tokenHash(raw),
      adminId: admin.id,
      csrf: randomUUID(),
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  const req = (resource: string) =>
    new NextRequest(process.env.APP_BASE_URL + "/api/" + resource, {
      headers: { cookie: "ta_session=" + raw },
    });
  const summaries: Record<string, unknown> = {};
  function stats(values: number[]) {
    const sorted = [...values].sort((a, b) => a - b);
    const q = (p: number) =>
      sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
    return {
      samples: values.length,
      p50Ms: q(0.5),
      p95Ms: values.length >= 20 ? q(0.95) : null,
      p99Ms: values.length >= 100 ? q(0.99) : null,
    };
  }
  async function run(
    name: string,
    work: (n: number) => Promise<unknown>,
    samples = 100,
    cleanup?: (value: unknown) => Promise<unknown>,
    setup?: () => Promise<unknown>,
  ) {
    const times = [];
    const before = counts[name] || 0;
    for (let i = 0; i < samples; i++) {
      if (setup) await setup();
      current = name;
      const begin = performance.now();
      const result = await work(i);
      times.push(performance.now() - begin);
      current = undefined;
      if (cleanup) await cleanup(result);
    }
    summaries[name] = {
      ...stats(times),
      sqlQueries: (counts[name] || 0) - before,
      queriesPerOperation: ((counts[name] || 0) - before) / samples,
    };
  }
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  const utilization = performance.eventLoopUtilization(),
    cpu = process.cpuUsage(),
    begin = performance.now();
  await run(
    "admission",
    () =>
      engine.admission(guildId, students[0].discordId, randomUUID(), course.id),
    100,
    async (value) =>
      engine.cancelTicket(
        guildId,
        students[0].discordId,
        randomUUID(),
        (value as { id: string }).id,
      ),
  );
  await run(
    "claim",
    () => engine.claimNext(guildId, tas[0], randomUUID()),
    100,
    async (value) => {
      const op = (value as { operationId: string }).operationId;
      const lease = await engine.leaseTransfer(op);
      await engine.finalizeTransfer(
        op,
        lease!.leaseToken!,
        inputs[0].voiceChannelId,
      );
      await engine.completeInspection(guildId, tas[0], randomUUID());
    },
    () =>
      engine.admission(guildId, students[0].discordId, randomUUID(), course.id),
  );
  await run(
    "stop",
    () => engine.stopSession(guildId, tas[0], randomUUID()),
    100,
    async () => engine.startSession(guildId, tas[0], randomUUID(), inputs[0]),
  );
  await run(
    "start",
    () => engine.startSession(guildId, tas[0], randomUUID(), inputs[0]),
    100,
    undefined,
    () => engine.stopSession(guildId, tas[0], randomUUID()),
  );
  const history = Number(process.env.PERFORMANCE_HISTORY_ROWS || 5000);
  const guild = await db.guild.update({
    where: { id: guildId },
    data: { nextSequence: { increment: history } },
  });
  const session = await db.tASession.findFirstOrThrow({
    where: { guildId, taId: tas[0], status: "ACCEPTING" },
  });
  for (let offset = 0; offset < history; offset += 500) {
    const batch = Array.from(
      { length: Math.min(500, history - offset) },
      (_, i) => ({
        id: prefix + "-history-" + (offset + i),
        guildId,
        sequence: guild.nextSequence - history + offset + i + 1,
        studentId: students[i % 70].id,
        courseworkId: course.id,
        sessionId: session.id,
        status: "COMPLETED" as const,
      }),
    );
    await db.queueTicket.createMany({ data: batch });
    await db.inspection.createMany({
      data: batch.map((t) => ({
        ticketId: t.id,
        taId: tas[0],
        voiceChannelId: inputs[0].voiceChannelId,
        status: "COMPLETED",
        completedAt: new Date(),
        durationSeconds: 60,
      })),
    });
  }
  current = "admission70";
  const starts = students.slice(0, 70).map(() => performance.now());
  const admitted = await Promise.all(
    students.slice(0, 70).map(async (s, i) => {
      const result = await engine.admission(
        guildId,
        s.discordId,
        randomUUID(),
        course.id,
      );
      return { result, ms: performance.now() - starts[i] };
    }),
  );
  current = undefined;
  if (
    admitted.length !== 70 ||
    new Set(admitted.map((t) => t.result.sequence)).size !== 70
  )
    throw new Error("Admission invariant failed");
  summaries.admission70 = {
    ...stats(admitted.map((t) => t.ms)),
    sqlQueries: counts.admission70,
    queriesPerOperation: counts.admission70 / 70,
  };
  await run("snapshot", () => engine.snapshot(guildId));
  await run("overviewAPI", async () => {
    const response = await GET(req("overview"), {
      params: Promise.resolve({ path: ["overview"] }),
    });
    if (response.status !== 200) throw new Error("Overview failed");
    return response.text();
  });
  await run(
    "analyticsAPI",
    async () => {
      const response = await GET(req("analytics"), {
        params: Promise.resolve({ path: ["analytics"] }),
      });
      if (response.status !== 200) throw new Error("Analytics failed");
      return response.text();
    },
    50,
  );
  const state = await engine.integrity(guildId);
  if (!state.ok) throw new Error("Queue invariant failed");
  loop.disable();
  summaries.database = { ...stats(sqlTimes), sqlQueries: sqlTimes.length };
  const report = {
    workload: {
      students: 70,
      tas: 10,
      historyRows: history,
      synthetic: true,
      discordNetwork: false,
    },
    operations: summaries,
    runtime: {
      elapsedMs: performance.now() - begin,
      cpu: process.cpuUsage(cpu),
      memory: process.memoryUsage(),
      eventLoopUtilization:
        performance.eventLoopUtilization(utilization).utilization,
      eventLoopDelayP95Ms: loop.percentile(95) / 1e6,
    },
    integrity: state,
  };
  writeFileSync(
    process.env.PERFORMANCE_OUTPUT || "artifacts/performance-benchmark.json",
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ operations: summaries, integrity: state.ok }));
  // Only synthetic live tickets created by this run are cancelled; historical fixture remains in this disposable database.
  for (const { result } of admitted)
    await engine.cancelTicket(
      guildId,
      result.student.discordId!,
      randomUUID(),
      result.id,
    );
  await db.adminSession.deleteMany({ where: { adminId: admin.id } });
  await db.$disconnect();
}
main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : "Benchmark failed");
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode || 0));
