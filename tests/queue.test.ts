import { beforeAll, afterAll, describe, test, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../packages/database/src/index";
import { settingsSchema, ACTIVE } from "../packages/shared/src/index";
import {
  admission,
  startSession,
  stopSession,
  claimNext,
  cancelTicket,
  completeInspection,
  leaseTransfer,
  finalizeTransfer,
  failTransfer,
  retryMove,
  integrity,
  setPresence,
  snapshot,
  observeStudentVoice,
} from "../packages/queue-engine/src/index";
let serial = 0;
const key = () => randomUUID();
async function fixture(capacity = 1, students = 70, tas = 1) {
  const guildId = `${Date.now()}${String(++serial).padStart(5, "0")}`;
  await db.guild.create({
    data: {
      id: guildId,
      name: "Integration Test",
      settings: settingsSchema.parse({
        minCapacity: 1,
        defaultCapacity: 1,
        maxCapacity: 200,
      }),
    },
  });
  const course = await db.coursework.create({
    data: { guildId, name: "Test coursework" },
  });
  const sessions = [];
  for (let i = 0; i < tas; i++)
    sessions.push(
      await startSession(guildId, `ta-${i}`, key(), {
        taName: `TA ${i}`,
        voiceChannelId: `voice-${i}`,
        capacity,
        courseworkIds: [],
        roleIds: [],
        note: "",
      }),
    );
  const users = [];
  for (let i = 0; i < students; i++)
    users.push({ id: `student-${i}`, discordId: `discord-${i}` });
  await db.student.createMany({
    data: users.map((u) => ({
      id: `${guildId}-${u.id}`,
      guildId,
      studentId: u.id,
      discordId: u.discordId,
      name: "First",
      lastname: "Last",
      registration: "REGISTERED",
    })),
  });
  return { guildId, course, sessions, users };
}
beforeAll(async () => {
  if (
    !process.env.TEST_DATABASE_URL ||
    !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
  )
    throw new Error(
      "Integration tests require a dedicated TEST_DATABASE_URL ending in _test.",
    );
  await db.$queryRaw`SELECT 1`;
});
afterAll(() => db.$disconnect());
test("claiming refreshes historical ranking names only when the TA display name changes", async () => {
  const f = await fixture();
  const current = await db.guild.findUniqueOrThrow({
    where: { id: f.guildId },
  });
  await db.guild.update({
    where: { id: f.guildId },
    data: {
      settings: {
        ...settingsSchema.parse(current.settings),
        taRole: "100000000000000031",
      },
    },
  });
  await db.channelBinding.create({
    data: { guildId: f.guildId, feature: "ta_voice", channelIds: ["voice-0"] },
  });
  await admission(f.guildId, f.users[0].discordId, key(), f.course.id);
  const claim = await claimNext(f.guildId, "ta-0", key(), {
    taName: "Renamed TA",
    voiceChannelId: "voice-0",
    roleIds: ["100000000000000031"],
    voiceEligible: () => true,
  });
  expect(
    await db.tASession.findUniqueOrThrow({ where: { id: f.sessions[0].id } }),
  ).toMatchObject({ taName: "Renamed TA" });
  expect(
    await db.systemEvent.count({
      where: { guildId: f.guildId, type: "session.settings_updated" },
    }),
  ).toBe(1);
  expect(claim.ticketId).toBeTruthy();
  await observeStudentVoice(f.guildId, f.users[0].discordId, null, new Date());
  await admission(f.guildId, f.users[0].discordId, key(), f.course.id);
  await claimNext(f.guildId, "ta-0", key(), {
    taName: "Renamed TA",
    voiceChannelId: "voice-0",
    roleIds: ["100000000000000031"],
    voiceEligible: () => true,
  });
  expect(
    await db.systemEvent.count({
      where: { guildId: f.guildId, type: "session.settings_updated" },
    }),
  ).toBe(1);
});
test("70 students and ten TAs retain FIFO, unique claims and terminal outcomes under concurrent use", async () => {
  const f = await fixture(1, 70, 10);
  const repeated = await Promise.allSettled(
    Array.from({ length: 50 }, (_, i) =>
      startSession(f.guildId, `ta-${i % 10}`, key(), {
        taName: `TA ${i % 10}`,
        voiceChannelId: `voice-${i % 10}`,
        capacity: 5,
        courseworkIds: [],
        roleIds: [],
        note: "",
      }),
    ),
  );
  expect(
    repeated.every(
      (r) => r.status === "rejected" && r.reason.code === "ALREADY_ACCEPTING",
    ),
  ).toBe(true);
  const admissions = await Promise.allSettled(
    f.users.map((u) => admission(f.guildId, u.discordId, key(), f.course.id)),
  );
  expect(admissions.filter((r) => r.status === "fulfilled")).toHaveLength(10);
  expect(
    admissions.filter(
      (r) => r.status === "rejected" && r.reason.code === "QUEUE_FULL",
    ),
  ).toHaveLength(60);
  const tickets = new Map(
    admissions.flatMap((r) =>
      r.status === "fulfilled" ? [[r.value.id, r.value] as const] : [],
    ),
  );
  const claims = await Promise.all(
    f.sessions.map(async (session) => ({
      ...(await claimNext(f.guildId, session.taId, key())),
      session,
    })),
  );
  expect(new Set(claims.map((c) => c.ticketId)).size).toBe(10);
  expect(claims.map((c) => c.sequence).sort((a, b) => a - b)).toEqual(
    Array.from({ length: 10 }, (_, i) => i + 1),
  );
  const sorted = [...claims].sort((a, b) => a.sequence - b.sequence);
  const leases = await Promise.all(
    sorted.map((c) => leaseTransfer(c.operationId)),
  );
  expect(leases.filter(Boolean)).toHaveLength(1);
  expect(leases[0]).toBeTruthy();
  for (let i = 0; i < sorted.length; i++) {
    const lease =
      i === 0 ? leases[0] : await leaseTransfer(sorted[i].operationId);
    expect(lease).toBeTruthy();
    expect(lease!.targetChannelId).toBe(sorted[i].session.voiceChannelId);
    await finalizeTransfer(
      sorted[i].operationId,
      lease!.leaseToken,
      lease!.targetChannelId,
    );
  }
  const { requestCompletion, leaseCompletion, finalizeCompletion } =
    await import("../packages/queue-engine/src/completion");
  await Promise.all(
    sorted.map((c, i) =>
      requestCompletion(
        f.guildId,
        c.session.taId,
        key(),
        c.session.voiceChannelId,
        i % 2 ? "COMPLETED" : "NO_SHOW",
        c.ticketId,
      ),
    ),
  );
  const completions = await Promise.all(
    sorted.map((c) => leaseCompletion(c.ticketId)),
  );
  await Promise.all(
    sorted.flatMap((c, i) => [
      observeStudentVoice(
        f.guildId,
        tickets.get(c.ticketId)!.student.discordId!,
        null,
        new Date(),
        c.session.voiceChannelId,
      ),
      finalizeCompletion(c.ticketId, completions[i]!.leaseToken!, () => true),
      finalizeCompletion(c.ticketId, completions[i]!.leaseToken!, () => true),
    ]),
  );
  expect(
    await db.inspection.count({
      where: { ticket: { guildId: f.guildId }, status: "COMPLETED" },
    }),
  ).toBe(5);
  expect(
    await db.inspection.count({
      where: {
        ticket: { guildId: f.guildId },
        status: "NO_SHOW",
        completionReason: "TA_MARKED_NO_SHOW",
      },
    }),
  ).toBe(5);
  expect(
    await db.systemEvent.count({
      where: {
        guildId: f.guildId,
        type: { in: ["inspection.completed", "inspection.no_show"] },
      },
    }),
  ).toBe(10);
  expect(
    await db.inspectionCompletion.count({
      where: { ticket: { guildId: f.guildId }, state: "SUCCEEDED" },
    }),
  ).toBe(10);
  expect((await snapshot(f.guildId)).metrics).toMatchObject({
    capacity: 10,
    available: 10,
    waiting: 0,
    inProgress: 0,
  });
  expect(await integrity(f.guildId)).toMatchObject({ ok: true });
});
describe("PostgreSQL queue invariants", () => {
  test("A: 50 simultaneous admissions compete for one seat", async () => {
    const f = await fixture();
    const r = await Promise.allSettled(
      f.users
        .slice(0, 50)
        .map((u) => admission(f.guildId, u.discordId, key(), f.course.id)),
    );
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(r.filter((x) => x.status === "rejected")).toHaveLength(49);
    expect(
      await db.queueReservation.count({
        where: { ticket: { guildId: f.guildId } },
      }),
    ).toBe(1);
    expect(await integrity(f.guildId)).toMatchObject({ ok: true });
  });
  test("H: 70 students, ten slots, exactly ten admissions", async () => {
    const f = await fixture(1, 70, 10);
    const r = await Promise.allSettled(
      f.users.map((u) => admission(f.guildId, u.discordId, key(), f.course.id)),
    );
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(10);
    expect(r.filter((x) => x.status === "rejected")).toHaveLength(60);
    const tickets = await db.queueTicket.findMany({
      where: { guildId: f.guildId },
    });
    expect(new Set(tickets.map((t) => t.sequence)).size).toBe(10);
    expect(await integrity(f.guildId)).toMatchObject({ ok: true });
  });
  test("200 interactions cannot oversell ten seats", async () => {
    const f = await fixture(10, 200);
    const r = await Promise.allSettled(
      f.users.map((u) => admission(f.guildId, u.discordId, key(), f.course.id)),
    );
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(10);
    expect(r.filter((x) => x.status === "rejected")).toHaveLength(190);
    expect(await integrity(f.guildId)).toMatchObject({ ok: true });
  });
  test("idempotency and one active ticket per student", async () => {
    const f = await fixture(3);
    const interaction = key();
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        admission(f.guildId, f.users[0].discordId, interaction, f.course.id),
      ),
    );
    expect(new Set(results.map((t) => t.id)).size).toBe(1);
    expect(await db.queueTicket.count({ where: { guildId: f.guildId } })).toBe(
      1,
    );
    await expect(
      admission(f.guildId, f.users[0].discordId, key(), f.course.id),
    ).rejects.toMatchObject({ code: "DUPLICATE" });
  });
  test("five concurrent TAs serialize dispatch, keep FIFO and use the actual TA room", async () => {
    const f = await fixture(1, 5, 5);
    const tickets = [];
    for (const u of f.users)
      tickets.push(await admission(f.guildId, u.discordId, key(), f.course.id));
    const calls = await Promise.all(
      f.sessions.map((ta) => claimNext(f.guildId, ta.taId, key())),
    );
    expect(new Set(calls.map((c) => c.ticketId)).size).toBe(5);
    const ordered = [...calls].sort((a, b) => a.sequence - b.sequence);
    expect(ordered.map((c) => c.ticketId)).toEqual(tickets.map((t) => t.id));
    for (const c of ordered.slice(1))
      expect(await leaseTransfer(c.operationId)).toBeNull();
    for (const c of ordered) {
      const ta = f.sessions[calls.indexOf(c)];
      const leased = await leaseTransfer(c.operationId);
      expect(leased!.targetChannelId).toBe(ta.voiceChannelId);
      await finalizeTransfer(
        leased!.id,
        leased!.leaseToken,
        leased!.targetChannelId,
      );
    }
    expect(await integrity(f.guildId)).toMatchObject({ ok: true });
  });
  test("C/D: concurrent stop/admit and cancel/claim preserve a valid order", async () => {
    const f = await fixture();
    const r = await Promise.allSettled([
      stopSession(f.guildId, "ta-0", key()),
      admission(f.guildId, f.users[0].discordId, key(), f.course.id),
    ]);
    const ticket = await db.queueTicket.findFirst({
      where: { guildId: f.guildId },
    });
    if (ticket) {
      expect(r[1].status).toBe("fulfilled");
      expect(ticket.sessionId).toBeNull();
      expect((await snapshot(f.guildId)).metrics.draining).toBe(1);
    } else expect(r[1].status).toBe("rejected");
    const g = await fixture();
    const t = await admission(
      g.guildId,
      g.users[0].discordId,
      key(),
      g.course.id,
    );
    const actions = await Promise.allSettled([
      cancelTicket(g.guildId, g.users[0].discordId, key()),
      claimNext(g.guildId, "ta-0", key()),
    ]);
    expect(actions.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const saved = await db.queueTicket.findUniqueOrThrow({
      where: { id: t.id },
    });
    expect(["CANCELLED", "CLAIMED"]).toContain(saved.status);
    expect(await integrity(g.guildId)).toMatchObject({ ok: true });
  });
  test("stopping drains and never deletes tickets; session completes after backlog resolves", async () => {
    const f = await fixture(3);
    const tickets = [];
    for (const u of f.users.slice(0, 3))
      tickets.push(await admission(f.guildId, u.discordId, key(), f.course.id));
    expect((await stopSession(f.guildId, "ta-0", key())).status).toBe(
      "COMPLETED",
    );
    expect(await db.queueTicket.count({ where: { guildId: f.guildId } })).toBe(
      3,
    );
    expect((await snapshot(f.guildId)).metrics).toMatchObject({
      capacity: 0,
      available: 0,
      draining: 3,
    });
    for (const t of tickets)
      await cancelTicket(f.guildId, "admin", key(), t.id);
    expect(
      (
        await db.tASession.findUniqueOrThrow({
          where: { id: f.sessions[0].id },
        })
      ).status,
    ).toBe("COMPLETED");
  });
  test("E/G: restart after move reconciles once and releases only verified reservation", async () => {
    const f = await fixture();
    const ticket = await admission(
      f.guildId,
      f.users[0].discordId,
      key(),
      f.course.id,
    );
    const claim = await claimNext(f.guildId, "ta-0", key());
    const first = await leaseTransfer(claim.operationId);
    expect(first).not.toBeNull();
    expect(
      await db.queueReservation.count({ where: { ticketId: ticket.id } }),
    ).toBe(1);
    await expect(
      finalizeTransfer(claim.operationId, first!.leaseToken, "wrong-room"),
    ).rejects.toMatchObject({ code: "STALE_TRANSFER" });
    await db.voiceTransferOperation.update({
      where: { id: claim.operationId },
      data: { leaseUntil: new Date(Date.now() - 1000) },
    });
    const recovered = await leaseTransfer(claim.operationId);
    expect(recovered).not.toBeNull();
    await expect(
      finalizeTransfer(
        claim.operationId,
        first!.leaseToken,
        first!.targetChannelId,
      ),
    ).rejects.toMatchObject({ code: "STALE_TRANSFER" });
    await finalizeTransfer(
      claim.operationId,
      recovered!.leaseToken,
      recovered!.targetChannelId,
    );
    await finalizeTransfer(
      claim.operationId,
      recovered!.leaseToken,
      recovered!.targetChannelId,
    );
    expect(await db.inspection.count({ where: { ticketId: ticket.id } })).toBe(
      1,
    );
    expect(
      await db.queueReservation.count({ where: { ticketId: ticket.id } }),
    ).toBe(0);
    expect((await snapshot(f.guildId)).metrics.available).toBe(1);
    await completeInspection(f.guildId, "ta-0", key());
    expect(
      (await db.queueTicket.findUniqueOrThrow({ where: { id: ticket.id } }))
        .status,
    ).toBe("COMPLETED");
    expect(await integrity(f.guildId)).toMatchObject({ ok: true });
  });
  test("failed move retains capacity and retries only within lease policy", async () => {
    const f = await fixture();
    const t = await admission(
      f.guildId,
      f.users[0].discordId,
      key(),
      f.course.id,
    );
    const c = await claimNext(f.guildId, "ta-0", key());
    const leased = await leaseTransfer(c.operationId);
    await failTransfer(c.operationId, leased!.leaseToken, "Permission denied");
    expect(
      (await db.queueTicket.findUniqueOrThrow({ where: { id: t.id } })).status,
    ).toBe("MOVE_FAILED");
    expect((await snapshot(f.guildId)).metrics.available).toBe(0);
    await expect(claimNext(f.guildId, "ta-0", key())).rejects.toMatchObject({
      code: "BUSY",
    });
    await retryMove(f.guildId, "admin", key(), t.id);
    const next = await leaseTransfer(c.operationId);
    expect(next).not.toBeNull();
    await failTransfer(
      c.operationId,
      next!.leaseToken,
      "Outcome uncertain",
      true,
    );
    await expect(
      cancelTicket(f.guildId, "admin", key(), t.id),
    ).rejects.toMatchObject({ code: "RECONCILE_FIRST" });
    expect(await integrity(f.guildId)).toMatchObject({ ok: true });
  });
  test("assistance transfers ownership and credits actual TA", async () => {
    const f = await fixture(1, 4, 2);
    const t = await admission(
      f.guildId,
      f.users[0].discordId,
      key(),
      f.course.id,
    );
    await stopSession(f.guildId, "ta-0", key());
    const c = await claimNext(f.guildId, "ta-1", key());
    expect(c.ticketId).toBe(t.id);
    const lease = await leaseTransfer(c.operationId);
    await finalizeTransfer(
      c.operationId,
      lease!.leaseToken,
      lease!.targetChannelId,
    );
    await completeInspection(f.guildId, "ta-1", key());
    const saved = await db.queueTicket.findUniqueOrThrow({
      where: { id: t.id },
      include: { inspection: true },
    });
    expect(saved.originalSessionId).toBeNull();
    expect(saved.sessionId).toBe(f.sessions[1].id);
    expect(saved.inspection).toMatchObject({ taId: "ta-1", assisted: false });
  });
  test("TA absence pauses admission without discarding reservations; maintenance blocks admission", async () => {
    const f = await fixture(2);
    await admission(f.guildId, f.users[0].discordId, key(), f.course.id);
    await setPresence(f.guildId, "ta-0", null);
    await expect(
      admission(f.guildId, f.users[1].discordId, key(), f.course.id),
    ).rejects.toMatchObject({ code: "NO_TA" });
    expect(
      await db.queueReservation.count({
        where: { ticket: { guildId: f.guildId } },
      }),
    ).toBe(1);
    await setPresence(f.guildId, "ta-0", "voice-0");
    await db.guild.update({
      where: { id: f.guildId },
      data: {
        settings: settingsSchema.parse({
          minCapacity: 1,
          defaultCapacity: 1,
          maintenance: true,
        }),
      },
    });
    await expect(
      admission(f.guildId, f.users[1].discordId, key(), f.course.id),
    ).rejects.toMatchObject({ code: "MAINTENANCE" });
  });
  test("exclusive rooms, coursework restrictions, FIFO and guild isolation", async () => {
    const f = await fixture(3, 5, 2);
    await expect(
      startSession(f.guildId, "other", key(), {
        taName: "Other",
        voiceChannelId: "voice-0",
        capacity: 3,
        courseworkIds: [],
        roleIds: [],
        note: "",
      }),
    ).rejects.toMatchObject({ code: "ROOM_OWNED" });
    const t1 = await admission(
      f.guildId,
      f.users[0].discordId,
      key(),
      f.course.id,
    );
    const t2 = await admission(
      f.guildId,
      f.users[1].discordId,
      key(),
      f.course.id,
    );
    const claimed = await claimNext(f.guildId, "ta-0", key());
    expect(claimed.ticketId).toBe(t1.id);
    const leased = await leaseTransfer(claimed.operationId);
    await finalizeTransfer(
      leased!.id,
      leased!.leaseToken,
      leased!.targetChannelId,
    );
    expect(t2.sessionId).toBeNull();
    expect((await claimNext(f.guildId, "ta-1", key())).ticketId).toBe(t2.id);
    const g = await fixture();
    await expect(
      admission(g.guildId, g.users[0].discordId, key(), f.course.id),
    ).rejects.toMatchObject({ code: "COURSEWORK" });
    await db.coursework.update({
      where: { id: g.course.id },
      data: { eligibleUsers: ["not-a-ta"] },
    });
    await expect(
      admission(g.guildId, g.users[0].discordId, key(), g.course.id),
    ).rejects.toMatchObject({ code: "NO_TA" });
    expect(await integrity(f.guildId)).toMatchObject({ ok: true });
    expect(
      await db.queueTicket.count({
        where: { guildId: g.guildId, status: { in: [...ACTIVE] } },
      }),
    ).toBe(0);
  });
});

test("fast and slow TAs call A, B, C, D without admission-time TA ownership", async () => {
  const f = await fixture(2, 4, 2),
    tickets = [];
  for (const user of f.users)
    tickets.push(
      await admission(f.guildId, user.discordId, key(), f.course.id),
    );
  expect(
    tickets.every(
      (t) => t.sessionId === null && t.reservation?.sessionId === null,
    ),
  ).toBe(true);
  const call = async (actor: string) => {
    const claim = await claimNext(f.guildId, actor, key());
    const lease = await leaseTransfer(claim.operationId);
    await finalizeTransfer(
      lease!.id,
      lease!.leaseToken,
      lease!.targetChannelId,
    );
    return claim.ticketId;
  };
  const actual = [await call("ta-1"), await call("ta-0")];
  await completeInspection(f.guildId, "ta-1", key());
  actual.push(await call("ta-1"));
  await completeInspection(f.guildId, "ta-0", key());
  actual.push(await call("ta-0"));
  expect(actual).toEqual(tickets.map((t) => t.id));
  expect(await integrity(f.guildId)).toMatchObject({ ok: true });
});
test("head coursework and failed transfer block later students without changing their order", async () => {
  const f = await fixture(2, 4, 2);
  await db.coursework.update({
    where: { id: f.course.id },
    data: { eligibleUsers: ["ta-0"] },
  });
  const other = await db.coursework.create({
    data: { guildId: f.guildId, name: "Other", eligibleUsers: ["ta-1"] },
  });
  const head = await admission(
    f.guildId,
    f.users[0].discordId,
    key(),
    f.course.id,
  );
  await admission(f.guildId, f.users[1].discordId, key(), other.id);
  await expect(claimNext(f.guildId, "ta-1", key())).rejects.toMatchObject({
    code: "FIFO_ELIGIBILITY",
  });
  const c = await claimNext(f.guildId, "ta-0", key());
  expect(c.ticketId).toBe(head.id);
  const lease = await leaseTransfer(c.operationId);
  await failTransfer(lease!.id, lease!.leaseToken, "Temporary error");
  await expect(claimNext(f.guildId, "ta-1", key())).rejects.toMatchObject({
    code: "FIFO_BLOCKED",
  });
  await cancelTicket(f.guildId, "admin", key(), head.id);
  expect((await claimNext(f.guildId, "ta-1", key())).sequence).toBe(
    head.sequence + 1,
  );
});
test("voice departure cancels only waiting tickets, completes only verified inspections, and ignores stale events", async () => {
  const f = await fixture(3, 3);
  await db.channelBinding.create({
    data: {
      guildId: f.guildId,
      feature: "waiting_voice",
      channelIds: ["waiting"],
    },
  });
  const first = await admission(
    f.guildId,
    f.users[0].discordId,
    key(),
    f.course.id,
  );
  expect(
    await observeStudentVoice(
      f.guildId,
      f.users[0].discordId,
      "waiting",
      new Date(),
    ),
  ).toBeNull();
  expect(
    await observeStudentVoice(
      f.guildId,
      f.users[0].discordId,
      null,
      new Date(),
    ),
  ).toMatchObject({ action: "cancelled" });
  expect(
    await observeStudentVoice(
      f.guildId,
      f.users[0].discordId,
      null,
      new Date(),
    ),
  ).toBeNull();
  const second = await admission(
    f.guildId,
    f.users[0].discordId,
    key(),
    f.course.id,
  );
  expect(second.sequence).toBe(first.sequence + 1);
  const oldEvent = new Date(Date.now() - 1000);
  const c = await claimNext(f.guildId, "ta-0", key());
  const lease = await leaseTransfer(c.operationId);
  expect(
    await observeStudentVoice(
      f.guildId,
      f.users[0].discordId,
      null,
      new Date(),
    ),
  ).toBeNull();
  expect(
    await observeStudentVoice(
      f.guildId,
      f.users[0].discordId,
      lease!.targetChannelId,
      new Date(),
      "waiting",
    ),
  ).toBeNull();
  await finalizeTransfer(lease!.id, lease!.leaseToken, lease!.targetChannelId);
  expect(
    await observeStudentVoice(
      f.guildId,
      f.users[0].discordId,
      null,
      oldEvent,
      lease!.targetChannelId,
    ),
  ).toBeNull();
  expect(
    await observeStudentVoice(
      f.guildId,
      f.users[0].discordId,
      null,
      new Date(),
      "wrong-room",
    ),
  ).toBeNull();
  expect(
    await observeStudentVoice(
      f.guildId,
      f.users[0].discordId,
      null,
      new Date(),
      lease!.targetChannelId,
      () => lease!.targetChannelId,
    ),
  ).toBeNull();
  expect(
    await observeStudentVoice(
      f.guildId,
      f.users[0].discordId,
      null,
      new Date(),
      lease!.targetChannelId,
    ),
  ).toMatchObject({ action: "completed" });
  expect(
    await observeStudentVoice(
      f.guildId,
      f.users[0].discordId,
      null,
      new Date(),
      lease!.targetChannelId,
    ),
  ).toBeNull();
  const i = await db.inspection.findUniqueOrThrow({
    where: { ticketId: second.id },
  });
  expect(i).toMatchObject({
    completionReason: "VOICE_LEFT",
    taId: "ta-0",
    voiceChannelId: lease!.targetChannelId,
  });
  expect(i.durationSeconds).toBeGreaterThanOrEqual(0);
  await admission(f.guildId, f.users[1].discordId, key(), f.course.id);
  expect(await claimNext(f.guildId, "ta-0", key())).toBeTruthy();
});

test("TA without Start claims global backlog with zero admission capacity; role, room, busy and stale presence stay enforced", async () => {
  const f = await fixture(2, 2);
  const role = "100000000000000077",
    room = "100000000000000078";
  const guild = await db.guild.findUniqueOrThrow({ where: { id: f.guildId } });
  await db.guild.update({
    where: { id: f.guildId },
    data: {
      settings: settingsSchema.parse({
        ...(guild.settings as object),
        taRole: role,
      }),
    },
  });
  await db.channelBinding.create({
    data: { guildId: f.guildId, feature: "ta_voice", channelIds: [room] },
  });
  const a = await admission(
    f.guildId,
    f.users[0].discordId,
    key(),
    f.course.id,
  );
  const b = await admission(
    f.guildId,
    f.users[1].discordId,
    key(),
    f.course.id,
  );
  expect(a.sessionId).toBeNull();
  expect(a.reservation?.sessionId).toBeNull();
  const caller = {
    taName: "Never started",
    voiceChannelId: room,
    roleIds: [role],
    voiceEligible: () => true,
  };
  await expect(
    claimNext(f.guildId, "student", key(), { ...caller, roleIds: [] }),
  ).rejects.toMatchObject({ code: "PERMISSION" });
  await expect(
    claimNext(f.guildId, "absent", key(), {
      ...caller,
      voiceEligible: () => false,
    }),
  ).rejects.toMatchObject({ code: "VOICE" });
  await expect(
    claimNext(f.guildId, "wrong-room", key(), {
      ...caller,
      voiceChannelId: "other",
    }),
  ).rejects.toMatchObject({ code: "PERMISSION" });
  await stopSession(f.guildId, "ta-0", key());
  const claim = await claimNext(f.guildId, "never-started", key(), caller);
  expect(claim.ticketId).toBe(a.id);
  const session = await db.tASession.findFirstOrThrow({
    where: { guildId: f.guildId, taId: "never-started" },
  });
  expect(session).toMatchObject({ capacity: 0, status: "DRAINING" });
  expect((await snapshot(f.guildId)).metrics).toMatchObject({
    capacity: 0,
    available: 0,
    waiting: 2,
    draining: 2,
  });
  const lease = await leaseTransfer(claim.operationId);
  expect(lease!.targetChannelId).toBe(room);
  await finalizeTransfer(lease!.id, lease!.leaseToken, room);
  await expect(
    claimNext(f.guildId, "never-started", key(), caller),
  ).rejects.toMatchObject({ code: "BUSY" });
  await completeInspection(f.guildId, "never-started", key());
  expect(
    (await claimNext(f.guildId, "never-started", key(), caller)).ticketId,
  ).toBe(b.id);
  expect(await integrity(f.guildId)).toMatchObject({ ok: true });
});

test("global capacity shrinks without giving waiting tickets to a TA and refills only after verified release", async () => {
  const f = await fixture(2, 5, 2);
  for (const user of f.users.slice(0, 4))
    await admission(f.guildId, user.discordId, key(), f.course.id);
  await stopSession(f.guildId, "ta-0", key());
  expect((await snapshot(f.guildId)).metrics).toMatchObject({
    capacity: 2,
    waiting: 4,
    available: 0,
    draining: 2,
  });
  await expect(
    admission(f.guildId, f.users[4].discordId, key(), f.course.id),
  ).rejects.toMatchObject({ code: "QUEUE_FULL" });
  const waiting = await db.queueTicket.findMany({
    where: { guildId: f.guildId, status: "QUEUED" },
  });
  expect(waiting.every((t) => t.sessionId === null)).toBe(true);
  for (const t of waiting.slice(0, 3))
    await cancelTicket(f.guildId, "admin", key(), t.id);
  expect((await snapshot(f.guildId)).metrics).toMatchObject({
    waiting: 1,
    available: 1,
    draining: 0,
  });
  expect(
    (await admission(f.guildId, f.users[4].discordId, key(), f.course.id))
      .sequence,
  ).toBe(5);
});

test("rapid and concurrent repeated Starts cannot edit capacity; only Session Settings can", async () => {
  const f = await fixture(5, 8);
  const original = await db.tASession.findFirstOrThrow({
    where: { guildId: f.guildId, taId: "ta-0" },
  });
  const input = {
    taName: "TA 0",
    voiceChannelId: "voice-0",
    capacity: 8,
    courseworkIds: [],
    roleIds: [],
    note: "",
  };
  const repeats = await Promise.allSettled(
    Array.from({ length: 50 }, () =>
      startSession(f.guildId, "ta-0", key(), input),
    ),
  );
  expect(repeats.filter((r) => r.status === "fulfilled")).toHaveLength(0);
  expect(
    repeats.every(
      (r) => r.status === "rejected" && r.reason.code === "ALREADY_ACCEPTING",
    ),
  ).toBe(true);
  expect(
    await db.tASession.count({
      where: { guildId: f.guildId, status: "ACCEPTING" },
    }),
  ).toBe(1);
  expect((await snapshot(f.guildId)).metrics.capacity).toBe(5);
  expect(
    await db.tASession.findUniqueOrThrow({ where: { id: original.id } }),
  ).toEqual(original);
  await startSession(f.guildId, "ta-0", key(), input, "SETTINGS");
  expect((await snapshot(f.guildId)).metrics.capacity).toBe(8);
  for (const user of f.users.slice(0, 6))
    await admission(f.guildId, user.discordId, key(), f.course.id);
  await expect(
    startSession(
      f.guildId,
      "ta-0",
      key(),
      { ...input, capacity: 3 },
      "SETTINGS",
    ),
  ).rejects.toMatchObject({ code: "CAPACITY" });
  expect((await snapshot(f.guildId)).metrics.waiting).toBe(6);
  await stopSession(f.guildId, "ta-0", key());
  expect((await snapshot(f.guildId)).metrics.capacity).toBe(0);
  await startSession(f.guildId, "ta-0", key(), input);
  expect((await snapshot(f.guildId)).metrics.capacity).toBe(8);
  expect((await snapshot(f.guildId)).metrics.waiting).toBe(6);
});
test("five initial Start requests produce one accepting session and one activation event", async () => {
  const f = await fixture(5, 1);
  const input = {
    taName: "Concurrent TA",
    voiceChannelId: "other-room",
    capacity: 5,
    courseworkIds: [],
    roleIds: [],
    note: "",
  };
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      startSession(f.guildId, "new-ta", key(), input),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(
    await db.tASession.count({
      where: { guildId: f.guildId, taId: "new-ta", status: "ACCEPTING" },
    }),
  ).toBe(1);
  expect(
    await db.systemEvent.count({
      where: { guildId: f.guildId, actorId: "new-ta", type: "session.started" },
    }),
  ).toBe(1);
  expect((await snapshot(f.guildId)).metrics.capacity).toBe(10);
});

test("admission projection preserves every ticket relation and idempotent replay", async () => {
  const f = await fixture(1, 1);
  const interaction = key();
  const first = await admission(
    f.guildId,
    f.users[0].discordId,
    interaction,
    f.course.id,
  );
  const { fullTicket } = await import("../packages/queue-engine/src/index");
  const stored = await db.queueTicket.findUniqueOrThrow({
    where: { id: first.id },
    include: fullTicket,
  });
  expect(JSON.parse(JSON.stringify(first))).toEqual(
    JSON.parse(JSON.stringify(stored)),
  );
  expect(
    await admission(f.guildId, f.users[0].discordId, interaction, f.course.id),
  ).toEqual(JSON.parse(JSON.stringify(first)));
});
