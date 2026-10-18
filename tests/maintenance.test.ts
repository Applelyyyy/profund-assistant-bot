import { test, expect, afterAll } from "vitest";
import { randomUUID, randomBytes } from "node:crypto";
import {
  mkdtemp,
  writeFile,
  readFile,
  utimes,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { db } from "../packages/database/src/index";
import { env } from "../packages/config/src/index";
import { settingsSchema } from "../packages/shared/src/index";
import { tokenHash } from "../packages/shared/src/auth";
import { GET, POST } from "../apps/web/app/api/[...path]/route";
import {
  previewMaintenance,
  backupMaintenance,
  executeMaintenance,
  confirmationPhrase,
} from "../packages/queue-engine/src/maintenance";
import {
  archivePreview,
  cleanArchives,
  currentLogName,
} from "../packages/config/src/log-archives";
afterAll(() => db.$disconnect());
async function fixture(
  guildId = `7${Date.now()}${Math.floor(Math.random() * 10000)}`,
) {
  if (!process.env.TEST_DATABASE_URL?.includes("_test"))
    throw new Error("Dedicated test database required.");
  await db.guild.upsert({
    where: { id: guildId },
    create: {
      id: guildId,
      name: "Maintenance fixture",
      settings: settingsSchema.parse({ transcriptRetentionDays: 7 }),
    },
    update: {},
  });
  const student = await db.student.create({
    data: {
      guildId,
      studentId: randomUUID(),
      name: "Keep",
      lastname: "Identity",
      discordId: randomUUID(),
      registration: "REGISTERED",
    },
  });
  const course = await db.coursework.create({
    data: { guildId, name: "Keep coursework" },
  });
  const owner = await db.adminUser.create({
    data: { username: randomUUID(), passwordHash: "unusable", role: "OWNER" },
  });
  const past = new Date(Date.now() - 10 * 86400000);
  const maxSequence =
    (
      await db.queueTicket.aggregate({
        where: { guildId },
        _max: { sequence: true },
      })
    )._max.sequence || 0;
  const terminal = await db.queueTicket.create({
    data: {
      guildId,
      studentId: student.id,
      courseworkId: course.id,
      sequence: maxSequence + 1,
      status: "COMPLETED",
      createdAt: past,
      updatedAt: past,
      inspection: {
        create: {
          taId: "fixture-ta",
          startedAt: past,
          completedAt: past,
          status: "COMPLETED",
          durationSeconds: 20,
        },
      },
    },
  });
  const session = await db.tASession.create({
    data: {
      guildId,
      taId: randomUUID(),
      taName: "Fixture TA",
      voiceChannelId: randomUUID(),
      capacity: 1,
      status: "ACCEPTING",
    },
  });
  const active = await db.queueTicket.create({
    data: {
      guildId,
      studentId: student.id,
      courseworkId: course.id,
      sequence: maxSequence + 2,
      status: "MOVING",
      sessionId: session.id,
      reservation: { create: {} },
      transfers: { create: { targetChannelId: "correct-room" } },
    },
  });
  const open = await db.supportTicket.create({
    data: {
      guildId,
      creatorId: student.discordId!,
      category: "Help",
      subject: "Keep open",
      description: "Keep",
      status: "OPEN",
    },
  });
  const closed = await db.supportTicket.create({
    data: {
      guildId,
      creatorId: student.discordId!,
      category: "Help",
      subject: "Old",
      description: "Remove",
      status: "CLOSED",
      closedAt: past,
      channelDeletedAt: past,
      transcript: ["old"],
      events: { create: { actorId: "system", action: "closed" } },
    },
  });
  const unsafeClosed = await db.supportTicket.create({
    data: {
      guildId,
      creatorId: student.discordId!,
      category: "Help",
      subject: "Channel remains",
      description: "Keep",
      channelId: randomUUID(),
      status: "CLOSED",
      closedAt: past,
    },
  });
  return {
    guildId,
    student,
    course,
    owner,
    past,
    terminal,
    active,
    open,
    closed,
    unsafeClosed,
  };
}
test("cleanup requires backup and phrase; protects live queue, pending move, identities and open support; duplicate execution is harmless", async () => {
  const f = await fixture();
  const before = await db.queueTicket.findUnique({
    where: { id: f.active.id },
    include: { reservation: true, transfers: true },
  });
  const plan = await previewMaintenance(f.guildId, f.owner.id, {
    kind: "PRODUCTION",
    method: "DELETE",
  });
  const preview = plan.preview as unknown as {
    counts: { queue: number; inspections: number; support: number };
  };
  expect(preview.counts).toMatchObject({
    queue: 1,
    inspections: 1,
    support: 1,
  });
  await expect(
    executeMaintenance(f.guildId, f.owner.id, plan.id, "wrong"),
  ).rejects.toMatchObject({ code: "CONFIRMATION" });
  await expect(
    executeMaintenance(f.guildId, f.owner.id, plan.id, confirmationPhrase),
  ).rejects.toMatchObject({ code: "BACKUP" });
  await backupMaintenance(
    f.guildId,
    f.owner.id,
    plan.id,
    process.env.TEST_DATABASE_URL!,
  );
  const other = await previewMaintenance(f.guildId, f.owner.id, {
    kind: "LOGS",
  });
  await db.maintenancePlan.update({
    where: { id: other.id },
    data: { status: "RUNNING", leaseUntil: new Date(0), result: { events: 0 } },
  });
  await expect(
    executeMaintenance(f.guildId, f.owner.id, plan.id, confirmationPhrase),
  ).rejects.toMatchObject({ code: "BUSY" });
  expect(
    await db.queueTicket.findUnique({ where: { id: f.terminal.id } }),
  ).not.toBeNull();
  await db.maintenancePlan.update({
    where: { id: other.id },
    data: { status: "COMPLETED", leaseUntil: null },
  });
  const results = await Promise.allSettled([
    executeMaintenance(f.guildId, f.owner.id, plan.id, confirmationPhrase),
    executeMaintenance(f.guildId, f.owner.id, plan.id, confirmationPhrase),
  ]);
  expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  const done = await executeMaintenance(
    f.guildId,
    f.owner.id,
    plan.id,
    confirmationPhrase,
  );
  expect(done.status).toBe("COMPLETED");
  expect(done.result).toMatchObject({ queue: 1, inspections: 1, support: 1 });
  expect(
    await db.queueTicket.findUnique({ where: { id: f.terminal.id } }),
  ).toBeNull();
  expect(
    await db.queueTicket.findUnique({
      where: { id: f.active.id },
      include: { reservation: true, transfers: true },
    }),
  ).toEqual(before);
  expect(await db.student.findUnique({ where: { id: f.student.id } })).toEqual(
    f.student,
  );
  expect(
    await db.supportTicket.findUnique({ where: { id: f.open.id } }),
  ).not.toBeNull();
  expect(
    await db.supportTicket.findUnique({ where: { id: f.unsafeClosed.id } }),
  ).not.toBeNull();
  expect(
    await db.systemEvent.count({
      where: { guildId: f.guildId, type: "maintenance.executed" },
    }),
  ).toBe(1);
});
test("expired/stale plans and cross-owner execution are refused without deleting data", async () => {
  const f = await fixture();
  const plan = await previewMaintenance(f.guildId, f.owner.id, {
    kind: "QUEUE_HISTORY",
  });
  await backupMaintenance(
    f.guildId,
    f.owner.id,
    plan.id,
    process.env.TEST_DATABASE_URL!,
  );
  await expect(
    executeMaintenance(f.guildId, "other-owner", plan.id, confirmationPhrase),
  ).rejects.toMatchObject({ code: "OWNER" });
  await db.queueTicket.update({
    where: { id: f.terminal.id },
    data: { assisted: true },
  });
  await expect(
    executeMaintenance(f.guildId, f.owner.id, plan.id, confirmationPhrase),
  ).rejects.toMatchObject({ code: "STALE" });
  await db.maintenancePlan.update({
    where: { id: plan.id },
    data: { expiresAt: new Date(0) },
  });
  await expect(
    executeMaintenance(f.guildId, f.owner.id, plan.id, confirmationPhrase),
  ).rejects.toMatchObject({ code: "EXPIRED" });
  expect(
    await db.queueTicket.findUnique({ where: { id: f.terminal.id } }),
  ).not.toBeNull();
});
async function session(adminId: string) {
  const token = randomBytes(32).toString("hex");
  await db.adminSession.create({
    data: {
      id: tokenHash(token),
      adminId,
      csrf: "maintenance-csrf",
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  return { cookie: `ta_session=${token}` };
}
async function analytics(headers: Record<string, string>) {
  const response = await GET(
    new NextRequest(`${env().APP_BASE_URL}/api/analytics`, { headers }),
    { params: Promise.resolve({ path: ["analytics"] }) },
  );
  expect(response.status).toBe(200);
  return response.json();
}
test("durable analytics/ranking baselines exclude retained old completions after reconnect; new completions count", async () => {
  const f = await fixture(env().DISCORD_GUILD_ID);
  const g = await db.guild.findUniqueOrThrow({ where: { id: f.guildId } });
  await db.guild.update({
    where: { id: f.guildId },
    data: { analyticsSince: null, rankingsSince: null },
  });
  const headers = await session(f.owner.id);
  expect((await analytics(headers)).completed).toBeGreaterThan(0);
  const plan = await previewMaintenance(f.guildId, f.owner.id, {
    kind: "INSPECTION_ANALYTICS",
    method: "BASELINE",
  });
  await backupMaintenance(
    f.guildId,
    f.owner.id,
    plan.id,
    process.env.TEST_DATABASE_URL!,
  );
  await executeMaintenance(f.guildId, f.owner.id, plan.id, confirmationPhrase);
  expect(
    await db.inspection.findUnique({ where: { ticketId: f.terminal.id } }),
  ).not.toBeNull();
  await db.$disconnect();
  const reset = await analytics(headers);
  expect(reset.completed).toBe(0);
  expect(reset.taRanking).toEqual([]);
  expect(reset.studentRanking).toEqual([]);
  await db.queueTicket.create({
    data: {
      guildId: f.guildId,
      studentId: f.student.id,
      courseworkId: f.course.id,
      sequence: 100000 + Math.floor(Math.random() * 100000),
      status: "COMPLETED",
      inspection: {
        create: {
          taId: "new-completer",
          startedAt: new Date(),
          completedAt: new Date(),
          status: "COMPLETED",
        },
      },
    },
  });
  const fresh = await analytics(headers);
  expect(fresh.completed).toBe(1);
  expect(fresh.taRanking).toHaveLength(1);
  expect(fresh.studentRanking).toHaveLength(1);
  await db.guild.update({
    where: { id: f.guildId },
    data: { analyticsSince: g.analyticsSince, rankingsSince: g.rankingsSince },
  });
  await db.voiceTransferOperation.deleteMany({
    where: { ticket: { courseworkId: f.course.id } },
  });
  await db.inspection.deleteMany({
    where: { ticket: { courseworkId: f.course.id } },
  });
  await db.queueReservation.deleteMany({
    where: { ticket: { courseworkId: f.course.id } },
  });
  await db.queueTicket.deleteMany({ where: { courseworkId: f.course.id } });
});
test("cleanup API rejects non-owner and missing CSRF", async () => {
  const f = await fixture();
  const viewer = await db.adminUser.create({
    data: { username: randomUUID(), passwordHash: "unused", role: "ADMIN" },
  });
  const h = await session(viewer.id);
  const response = await GET(
    new NextRequest(`${env().APP_BASE_URL}/api/data-management`, {
      headers: h,
    }),
    { params: Promise.resolve({ path: ["data-management"] }) },
  );
  expect(response.status).toBe(403);
  const ownerHeaders = await session(f.owner.id);
  const denied = await POST(
    new NextRequest(`${env().APP_BASE_URL}/api/data-management/preview`, {
      method: "POST",
      headers: { ...ownerHeaders, origin: env().APP_BASE_URL },
      body: JSON.stringify({ kind: "LOGS" }),
    }),
    { params: Promise.resolve({ path: ["data-management", "preview"] }) },
  );
  expect(denied.status).toBe(403);
});
test("archive cleanup respects dates, preserves current logs and retains file backup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ta-logs-"));
  const backup = join(directory, "backup");
  try {
    const name = "runtime-2025-01-01.ndjson";
    const line = (time: string) =>
      JSON.stringify({ time: Date.parse(time), msg: "fixture" }) + "\n";
    await writeFile(
      join(directory, name),
      line("2025-01-01T12:00:00Z") + line("2025-01-02T12:00:00Z"),
    );
    await utimes(join(directory, name), new Date(0), new Date(0));
    const live = join(directory, currentLogName());
    await writeFile(live, line(new Date().toISOString()));
    const entries = await archivePreview(
      new Date("2025-01-01"),
      new Date("2025-01-02"),
      new Date(),
      directory,
    );
    expect(entries[0].records).toBe(1);
    expect(
      await cleanArchives(
        entries,
        backup,
        new Date("2025-01-01"),
        new Date("2025-01-02"),
        directory,
      ),
    ).toBe(1);
    expect(await readFile(join(directory, name), "utf8")).toContain(
      String(Date.parse("2025-01-02T12:00:00Z")),
    );
    expect((await stat(join(backup, name))).size).toBeGreaterThan(0);
    expect(await readFile(live, "utf8")).toContain("fixture");
    expect(
      await cleanArchives(
        entries,
        backup,
        new Date("2025-01-01"),
        new Date("2025-01-02"),
        directory,
      ),
    ).toBe(1);
    await writeFile(join(directory, name), "externally changed archive\n");
    await expect(
      cleanArchives(
        entries,
        backup,
        new Date("2025-01-01"),
        new Date("2025-01-02"),
        directory,
      ),
    ).rejects.toThrow("Log archive changed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
