import { test, expect, vi } from "vitest";
import {
  refreshForEvents,
  panelAffected,
} from "../packages/shared/src/live-updates";
import { PanelSyncScheduler } from "../apps/bot/src/panel-sync";
import { settingsSchema } from "../packages/shared/src/index";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { GET } from "../apps/web/app/api/[...path]/route";
import { db } from "../packages/database/src/index";
import { tokenHash } from "../packages/shared/src/auth";

test("event scopes preserve custom dynamic panels, terminal rankings and unknown-event fallback", () => {
  expect(refreshForEvents(["inspection.note"]).panels).toEqual([]);
  expect(
    refreshForEvents(["inspection.no_show_dm_sent"]).queries,
  ).not.toContain("analytics");
  expect(refreshForEvents(["inspection.no_show"]).panels).toEqual([
    "queue",
    "ranking",
  ]);
  expect(refreshForEvents(["support.claimed"]).panels).toEqual(["support"]);
  expect(refreshForEvents(["new.event"]).panels).toBeNull();
  expect(
    panelAffected("registration", { description: "{queue.waiting}" }, [
      "queue",
    ]),
  ).toBe(true);
  expect(panelAffected("ta_room_queue_panel", {}, ["queue"])).toBe(true);
  expect(
    panelAffected("ranking", { description: "{ranking.ta}" }, ["queue"]),
  ).toBe(false);
});
test("dispatch and presence bursts refresh live state without rerunning unchanged historical analytics", () => {
  for (const type of [
    "queue.claimed",
    "queue.dispatched",
    "transfer.succeeded",
    "transfer.failed",
    "transfer.retry",
    "inspection.completion_requested",
    "inspection.disconnect_failed",
    "session.presence",
    "session.draining",
  ]) {
    const refresh = refreshForEvents([type]);
    expect(refresh.queries).toContain("overview");
    expect(refresh.queries).not.toContain("analytics");
    expect(refresh.panels).toContain("queue");
  }
  for (const type of [
    "queue.admitted",
    "queue.cancelled",
    "queue.no_show",
    "inspection.completed",
    "inspection.no_show",
    "inspection.corrected",
    "session.settings_updated",
    "queue.unknown",
    "unknown.event",
  ])
    expect(refreshForEvents([type]).queries).toContain("analytics");
  expect(
    refreshForEvents(["queue.claimed", "inspection.completed"]).queries,
  ).toContain("analytics");
});
test("scoped panel bursts merge pending work without resetting the deadline and retain requests during publication", async () => {
  const sync = vi.fn(async () => {}),
    scheduler = new PanelSyncScheduler(sync);
  const settings = settingsSchema.parse({ embedAutoRefreshEnabled: false });
  for (let n = 0; n < 200; n++)
    scheduler.request(n, 300, n % 2 ? ["queue"] : ["support"]);
  await scheduler.tick(settings, 0, 300);
  expect(sync).toHaveBeenCalledExactlyOnceWith(false, ["support", "queue"]);
  scheduler.request(400, 100, ["queue"]);
  scheduler.request(450, 100);
  await scheduler.tick(settings, 0, 500);
  expect(sync).toHaveBeenLastCalledWith(false);
});
test("optional telemetry bounds storage, omits low-sample percentiles and preserves thrown errors", () => {
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    const module=await import('./packages/config/src/performance.ts'); const m=module.default || module;
    for(let i=0;i<5000;i++)m.recordDuration('queue.admission',i);
    m.recordDuration('one',1);
    for(let i=0;i<200;i++)m.recordDuration('metric.'+i,1);
    for(let i=0;i<40;i++)m.incrementCounter('counter.'+i);
    const s=m.performanceSnapshot();
    assert.equal(s.metrics['queue.admission'].samples,2048);
    assert.equal(s.metrics['queue.admission'].count,5000);
    assert.equal(s.metrics.one.p95Ms,null);
    assert.equal(Object.keys(s.metrics).length,128);
    assert.equal(Object.keys(s.counters).length,32);
    const err=new Error('private');
    await assert.rejects(m.measure('queue.admission',async()=>{throw err}),e=>e===err);
    assert.equal(m.performanceSnapshot().metrics['queue.admission'].errors,1);
    assert(!JSON.stringify(m.performanceSnapshot()).includes('private'));
    m.stopPerformanceMonitor();
  `,
    ],
    {
      env: { ...process.env, PERFORMANCE_METRICS_ENABLED: "true" },
      stdio: "pipe",
    },
  );
});
test("SSE starts at current durable cursor, replays missed events on reconnect, and closes on abort", async () => {
  const guildId = process.env.DISCORD_GUILD_ID!;
  await db.guild.upsert({
    where: { id: guildId },
    create: {
      id: guildId,
      name: "SSE test",
      settings: settingsSchema.parse({}),
    },
    update: {},
  });
  const token = randomUUID();
  const admin = await db.adminUser.create({
    data: { username: token, passwordHash: "unusable", role: "VIEWER" },
  });
  await db.adminSession.create({
    data: {
      id: tokenHash(token),
      adminId: admin.id,
      csrf: token,
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  const old = await db.systemEvent.create({
    data: {
      guildId,
      actorId: "test",
      correlationId: randomUUID(),
      type: "inspection.note",
      message: "Old event",
    },
  });
  const request = (headers = {}) => {
    const abort = new AbortController();
    return {
      abort,
      req: new NextRequest(process.env.APP_BASE_URL! + "/api/events", {
        signal: abort.signal,
        headers: { cookie: `ta_session=${token}`, ...headers },
      }),
    };
  };
  const fresh = request();
  const response = await GET(fresh.req, {
    params: Promise.resolve({ path: ["events"] }),
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toContain(`id: ${old.id}`);
  expect(first).toContain('"count":0');
  await reader.read();
  fresh.abort.abort();
  expect((await reader.read()).done).toBe(true);
  await db.systemEvent.createMany({
    data: Array.from({ length: 200 }, () => ({
      guildId,
      actorId: "test",
      correlationId: randomUUID(),
      type: "inspection.note",
      message: "Missed event",
    })),
  });
  const resumed = request({ "last-event-id": String(old.id) });
  const replay = await GET(resumed.req, {
    params: Promise.resolve({ path: ["events"] }),
  });
  const resumedReader = replay.body!.getReader();
  await resumedReader.read();
  const event = new TextDecoder().decode((await resumedReader.read()).value);
  expect(event).toContain('"count":200');
  expect(event).toContain('"session-history"');
  expect(event).not.toContain('"analytics"');
  await resumedReader.cancel();
  resumed.abort.abort();
});

test("session history keeps exact totals and pages recorded work without leaking another guild", async () => {
  const guildId = process.env.DISCORD_GUILD_ID!,
    unique = randomUUID();
  const student = await db.student.create({
    data: { guildId, studentId: unique, name: "Paged", lastname: "History" },
  });
  const course = await db.coursework.create({
    data: { guildId, name: unique },
  });
  const session = await db.tASession.create({
    data: {
      guildId,
      taId: unique,
      taName: unique,
      voiceChannelId: unique,
      capacity: 1,
      status: "ACCEPTING",
    },
  });
  const guild = await db.guild.update({
    where: { id: guildId },
    data: { nextSequence: { increment: 62 } },
  });
  const tickets = Array.from({ length: 62 }, (_, n) => ({
    id: unique + n,
    guildId,
    studentId: student.id,
    courseworkId: course.id,
    sessionId: session.id,
    sequence: guild.nextSequence - n,
    status: "COMPLETED" as const,
  }));
  await db.queueTicket.createMany({ data: tickets });
  await db.inspection.createMany({
    data: tickets.map((t) => ({
      ticketId: t.id,
      taId: unique,
      voiceChannelId: unique,
      status: "COMPLETED",
      completedAt: new Date(),
      note: "Preserved note",
    })),
  });
  await db.tASession.update({
    where: { id: session.id },
    data: { status: "COMPLETED" },
  });
  const token = randomUUID(),
    admin = await db.adminUser.create({
      data: { username: token, passwordHash: "unusable", role: "VIEWER" },
    });
  await db.adminSession.create({
    data: {
      id: tokenHash(token),
      adminId: admin.id,
      csrf: token,
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  const get = async (path: string[], query = "") => {
    const r = await GET(
      new NextRequest(
        process.env.APP_BASE_URL! + "/api/" + path.join("/") + query,
        { headers: { cookie: `ta_session=${token}` } },
      ),
      { params: Promise.resolve({ path }) },
    );
    expect(r.status).toBe(200);
    return r.json();
  };
  const summaries = await get(["sessions"]);
  const summary = summaries.find((s: { id: string }) => s.id === session.id);
  expect(summary).toMatchObject({
    _count: { tickets: 62 },
    completedCount: 62,
  });
  expect(summary.tickets).toBeUndefined();
  const first = await get(["sessions", session.id]);
  expect(first.tickets).toHaveLength(50);
  expect(first.tickets[0].inspection.note).toBe("Preserved note");
  const older = await get(["sessions", session.id], `?before=${first.next}`);
  expect(older.tickets).toHaveLength(12);
  expect(older.next).toBeNull();
  const foreignGuild = await db.guild.create({
    data: {
      id: randomUUID(),
      name: "Other guild",
      settings: settingsSchema.parse({}),
    },
  });
  const foreignSession = await db.tASession.create({
    data: {
      guildId: foreignGuild.id,
      taId: unique,
      taName: unique,
      voiceChannelId: unique,
      capacity: 1,
      status: "COMPLETED",
    },
  });
  const forbidden = await GET(
    new NextRequest(
      process.env.APP_BASE_URL! + "/api/sessions/" + foreignSession.id,
      { headers: { cookie: `ta_session=${token}` } },
    ),
    { params: Promise.resolve({ path: ["sessions", foreignSession.id] }) },
  );
  expect(forbidden.status).toBe(404);

  expect(
    new Set([...first.tickets, ...older.tickets].map((t) => t.id)).size,
  ).toBe(62);
});

test("unrelated event bursts cannot postpone periodic panel reconciliation", async () => {
  const sync = vi.fn(async () => {}),
    scheduler = new PanelSyncScheduler(sync);
  const settings = settingsSchema.parse({
    embedAutoRefreshEnabled: true,
    embedRefreshIntervalSeconds: 5,
    embedUpdateDebounceMs: 100,
  });
  await scheduler.tick(settings, 1, 1000);
  await scheduler.tick(settings, 1, 1100);
  expect(sync).toHaveBeenCalledTimes(1);
  for (let n = 2; n < 40; n++) {
    scheduler.request(1100 + n * 100, 100, []);
    await scheduler.tick(settings, n, 1100 + n * 100, []);
  }
  expect(sync).toHaveBeenCalledTimes(1);
  await scheduler.tick(settings, 40, 6100, []);
  expect(sync).toHaveBeenLastCalledWith(true);
  expect(sync).toHaveBeenCalledTimes(2);
});
