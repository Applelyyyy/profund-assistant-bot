import { performance } from "node:perf_hooks";
import { measure, recordDuration } from "../../config/src/performance";
import { randomUUID } from "node:crypto";
import { db, Prisma } from "../../database/src/index";
import {
  ACTIVE,
  DomainError,
  Settings,
  canHandle,
  json,
  settingsSchema,
} from "../../shared/src/index";
import type { TicketStatus } from "@prisma/client";
export type Tx = Prisma.TransactionClient;
export const fullTicket = {
  student: true,
  coursework: true,
  session: true,
  reservation: true,
  inspection: true,
  transfers: true,
  completion: true,
} as const;
export async function event(
  tx: Tx,
  guildId: string,
  actorId: string,
  type: string,
  message: string,
  data: unknown = {},
  severity = "info",
) {
  return tx.systemEvent.create({
    data: {
      guildId,
      actorId,
      type,
      message,
      data: json(data) as Prisma.InputJsonValue,
      correlationId: randomUUID(),
      severity,
    },
  });
}
export async function locked<T>(
  guildId: string,
  work: (tx: Tx, settings: Settings) => Promise<T>,
): Promise<T> {
  const waitingSince = performance.now();
  return db.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<
        { settings: Prisma.JsonValue }[]
      >`SELECT settings FROM "Guild" WHERE id = ${guildId} FOR UPDATE`;
      recordDuration(
        "database.guild_lock_wait",
        performance.now() - waitingSince,
      );
      if (!rows.length)
        throw new DomainError(
          "GUILD_NOT_FOUND",
          "Configure the Discord guild first.",
          404,
        );
      return measure("database.guild_lock_hold", () =>
        work(tx, settingsSchema.parse(rows[0].settings)),
      );
    },
    { maxWait: 60000, timeout: 15000 },
  );
}
export async function mutate<T>(
  guildId: string,
  actorId: string,
  action: string,
  key: string,
  work: (tx: Tx, s: Settings) => Promise<T>,
): Promise<T> {
  if (!key || key.length > 180)
    throw new DomainError(
      "BAD_KEY",
      "A valid idempotency key is required.",
      400,
    );
  return measure(`queue.${action}`, () =>
    locked(guildId, async (tx, s) => {
      const recordKey = `${guildId}:${actorId}:${action}:${key}`;
      const old = await tx.idempotencyRecord.findUnique({
        where: { key: recordKey },
      });
      if (old) return old.result as T;
      const result = await work(tx, s);
      await tx.idempotencyRecord.create({
        data: {
          key: recordKey,
          guildId,
          actorId,
          action,
          result: json(result) as Prisma.InputJsonValue,
        },
      });
      return result;
    }),
  );
}
async function finishDrained(tx: Tx, sessionId: string | null) {
  if (!sessionId) return;
  const s = await tx.tASession.findUniqueOrThrow({ where: { id: sessionId } });
  if (
    s.status === "DRAINING" &&
    !(await tx.queueTicket.count({
      where: {
        sessionId,
        status: { in: [...ACTIVE] },
      },
    }))
  )
    await tx.tASession.update({
      where: { id: sessionId },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
}
export async function startSession(
  guildId: string,
  actor: string,
  key: string,
  input: {
    taName: string;
    voiceChannelId: string;
    capacity: number;
    courseworkIds: string[];
    roleIds: string[];
    note: string;
  },
  mode: "START" | "SETTINGS" = "START",
) {
  return mutate(
    guildId,
    actor,
    mode === "START" ? "start" : "session_settings",
    key,
    async (tx, s) => {
      if (input.capacity < s.minCapacity || input.capacity > s.maxCapacity)
        throw new DomainError(
          "CAPACITY",
          `Capacity must be ${s.minCapacity}–${s.maxCapacity}.`,
          400,
        );
      const other = await tx.tASession.findFirst({
        where: {
          guildId,
          status: { not: "COMPLETED" },
          voiceChannelId: input.voiceChannelId,
          taId: { not: actor },
        },
      });
      if (other)
        throw new DomainError(
          "ROOM_OWNED",
          "Another TA owns this room. Choose an available inspection room.",
        );
      if (
        input.courseworkIds.length !==
        (await tx.coursework.count({
          where: {
            guildId,
            id: { in: input.courseworkIds },
            enabled: true,
            archived: false,
          },
        }))
      )
        throw new DomainError(
          "COURSEWORK",
          "Select available coursework.",
          400,
        );
      const old = await tx.tASession.findFirst({
        where: { guildId, taId: actor, status: { not: "COMPLETED" } },
      });
      if (old && old.voiceChannelId !== input.voiceChannelId)
        throw new DomainError(
          "SESSION_ROOM",
          "Resolve the previous session before changing rooms.",
        );
      if (old?.status === "ACCEPTING" && mode === "START")
        throw new DomainError(
          "ALREADY_ACCEPTING",
          "Already accepting; use Session Settings to change capacity.",
        );
      if (mode === "SETTINGS" && !old)
        throw new DomainError(
          "NO_SESSION",
          "Start an accepting session first.",
        );
      if (old?.paused && mode === "START")
        throw new DomainError(
          "SESSION_ROOM",
          "An administrator must resume the paused session first.",
        );
      if (
        old &&
        mode === "SETTINGS" &&
        old.status === "ACCEPTING" &&
        input.capacity < old.capacity
      ) {
        const accepting = await tx.tASession.findMany({
          where: {
            guildId,
            status: "ACCEPTING",
            present: true,
            paused: false,
            id: { not: old.id },
          },
        });
        const reserved = await tx.queueReservation.count({
          where: { ticket: { guildId } },
        });
        if (
          input.capacity + accepting.reduce((n, a) => n + a.capacity, 0) <
          reserved
        )
          throw new DomainError(
            "CAPACITY",
            "Capacity cannot be reduced below outstanding global waiting reservations.",
            400,
          );
      }
      const session = old
        ? await tx.tASession.update({
            where: { id: old.id },
            data: {
              ...input,
              status: mode === "SETTINGS" ? old.status : "ACCEPTING",
              present: true,
              paused: mode === "SETTINGS" ? old.paused : false,
              lastPresence: new Date(),
            },
          })
        : await tx.tASession.create({
            data: { ...input, guildId, taId: actor },
          });
      await event(
        tx,
        guildId,
        actor,
        mode === "SETTINGS" ? "session.settings_updated" : "session.started",
        `${input.taName} opened ${input.capacity} waiting slots.`,
        { sessionId: session.id },
      );
      return session;
    },
  );
}
export async function stopSession(
  guildId: string,
  actor: string,
  key: string,
  sessionId?: string,
) {
  return mutate(guildId, actor, "stop", key, async (tx) => {
    const session = await tx.tASession.findFirst({
      where: {
        guildId,
        status: { not: "COMPLETED" },
        ...(sessionId ? { id: sessionId } : { taId: actor }),
      },
    });
    if (!session)
      throw new DomainError(
        "NO_SESSION",
        "No active session. Start a queue first.",
      );
    await tx.tASession.update({
      where: { id: session.id },
      data: { status: "DRAINING" },
    });
    await finishDrained(tx, session.id);
    await event(
      tx,
      guildId,
      actor,
      "session.draining",
      "Session stopped accepting. Existing tickets are preserved.",
      { sessionId: session.id },
    );
    return tx.tASession.findUniqueOrThrow({ where: { id: session.id } });
  });
}
export async function admission(
  guildId: string,
  discordId: string,
  key: string,
  courseworkId: string,
  voiceEligible?: () => boolean,
) {
  return mutate(guildId, discordId, "admit", key, async (tx, s) => {
    if (voiceEligible && !voiceEligible())
      throw new DomainError(
        "WAITING_VOICE",
        "Return to an authorized waiting voice channel before joining.",
      );
    if (s.maintenance)
      throw new DomainError(
        "MAINTENANCE",
        "Queue admission is paused. Existing tickets remain valid.",
      );
    const student = await tx.student.findUnique({
      where: { guildId_discordId: { guildId, discordId } },
    });
    if (
      !student ||
      (s.requireIdentity && student.registration !== "REGISTERED")
    )
      throw new DomainError("VERIFY", "Verify your student ID first.", 403);
    const duplicate = await tx.queueTicket.findFirst({
      where: { guildId, studentId: student.id, status: { in: [...ACTIVE] } },
    });
    if (duplicate)
      throw new DomainError(
        "DUPLICATE",
        `You already have active ticket #${duplicate.sequence}.`,
      );
    const now = new Date();
    const course = await tx.coursework.findFirst({
      where: {
        id: courseworkId,
        guildId,
        enabled: true,
        archived: false,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
        ],
      },
    });
    if (!course)
      throw new DomainError(
        "COURSEWORK",
        "Choose an available assignment first.",
        400,
      );
    const sessions = await tx.tASession.findMany({
      where: { guildId, status: "ACCEPTING", present: true, paused: false },
    });
    if (!sessions.some((t) => canHandle(course, t, course.id)))
      throw new DomainError(
        "NO_TA",
        "No available TA accepts this coursework. Please try later.",
      );
    const waiting = await tx.queueReservation.count({
      where: { ticket: { guildId } },
    });
    if (waiting >= sessions.reduce((n, t) => n + t.capacity, 0))
      throw new DomainError(
        "QUEUE_FULL",
        "Queue full. Wait for a slot, then try again.",
      );
    const guild = await tx.guild.update({
      where: { id: guildId },
      data: { nextSequence: { increment: 1 } },
    });
    const created = await tx.queueTicket.create({
      data: {
        guildId,
        sequence: guild.nextSequence,
        studentId: student.id,
        courseworkId,
        reservation: { create: {} },
      },
      include: { reservation: true },
    });
    const ticket = {
      ...created,
      student,
      coursework: course,
      session: null,
      inspection: null,
      transfers: [],
      completion: null,
    };
    await event(
      tx,
      guildId,
      discordId,
      "queue.admitted",
      `Ticket #${ticket.sequence} admitted.`,
      { ticketId: ticket.id },
    );
    return ticket;
  });
}
export async function cancelTicket(
  guildId: string,
  actor: string,
  key: string,
  ticketId?: string,
  noShow = false,
) {
  return mutate(
    guildId,
    actor,
    noShow ? "no_show" : "cancel",
    key,
    async (tx, s) => {
      if (!ticketId && !s.allowCancellation)
        throw new DomainError(
          "CANCEL_DISABLED",
          "Ask a TA to cancel this ticket.",
          403,
        );
      const ticket = await tx.queueTicket.findFirst({
        where: {
          guildId,
          ...(ticketId ? { id: ticketId } : { student: { discordId: actor } }),
          status: { in: ["QUEUED", "MOVE_FAILED", "NEEDS_REVIEW"] },
        },
        include: { reservation: true },
      });
      if (!ticket)
        throw new DomainError(
          "CANNOT_CANCEL",
          "Ticket is already claimed, moving, or no longer waiting. Ask your TA.",
        );
      // A reviewed failed transfer may already have moved the student; Discord adapter must reconcile before authorizing cancellation.
      if (ticket.status === "NEEDS_REVIEW")
        throw new DomainError(
          "RECONCILE_FIRST",
          "Reconcile the transfer before cancelling.",
        );
      await tx.queueReservation.deleteMany({ where: { ticketId: ticket.id } });
      await tx.voiceTransferOperation.updateMany({
        where: { ticketId: ticket.id, state: { not: "SUCCEEDED" } },
        data: { state: "CANCELLED", leaseToken: null, leaseUntil: null },
      });
      const updated = await tx.queueTicket.update({
        where: { id: ticket.id },
        data: { status: noShow ? "NO_SHOW" : "CANCELLED" },
      });
      await finishDrained(tx, ticket.sessionId);
      await event(
        tx,
        guildId,
        actor,
        noShow ? "queue.no_show" : "queue.cancelled",
        `Ticket #${ticket.sequence} ${noShow ? "marked no-show" : "cancelled"}.`,
        { ticketId: ticket.id },
      );
      return updated;
    },
  );
}
export async function claimNext(
  guildId: string,
  actor: string,
  key: string,
  caller?: {
    taName: string;
    voiceChannelId: string;
    roleIds: string[];
    voiceEligible: () => boolean;
  },
) {
  return mutate(guildId, actor, "CALL_NEXT_STUDENT", key, async (tx, s) => {
    if (caller && !caller.voiceEligible())
      throw new DomainError(
        "VOICE",
        "Join an authorized TA inspection voice room first.",
      );
    let session = await tx.tASession.findFirst({
      where: {
        guildId,
        taId: actor,
        status: { not: "COMPLETED" },
      },
    });
    if (caller) {
      const binding = await tx.channelBinding.findUnique({
        where: { guildId_feature: { guildId, feature: "ta_voice" } },
      });
      if (
        !s.taRole ||
        !caller.roleIds.includes(s.taRole) ||
        !binding?.channelIds.includes(caller.voiceChannelId)
      )
        throw new DomainError(
          "PERMISSION",
          "An authorized TA inspection room and TA role are required.",
          403,
        );
      const other = await tx.tASession.findFirst({
        where: {
          guildId,
          voiceChannelId: caller.voiceChannelId,
          status: { not: "COMPLETED" },
          taId: { not: actor },
        },
      });
      if (other)
        throw new DomainError(
          "ROOM_OWNED",
          "Another TA owns this room. Choose an available inspection room.",
        );
      if (
        session &&
        (session.voiceChannelId !== caller.voiceChannelId || session.paused)
      )
        throw new DomainError(
          "SESSION_ROOM",
          "Return to your assigned inspection room or ask an administrator to resolve your session.",
        );
      if (session && session.taName !== caller.taName)
        await event(
          tx,
          guildId,
          actor,
          "session.settings_updated",
          "TA display name updated.",
          { sessionId: session.id },
        );
      session = session
        ? await tx.tASession.update({
            where: { id: session.id },
            data: {
              present: true,
              roleIds: caller.roleIds,
              taName: caller.taName,
              lastPresence: new Date(),
            },
          })
        : await tx.tASession.create({
            data: {
              guildId,
              taId: actor,
              taName: caller.taName,
              voiceChannelId: caller.voiceChannelId,
              roleIds: caller.roleIds,
              capacity: 0,
              status: "DRAINING",
            },
          });
    }
    if (!session || !session.present || session.paused)
      throw new DomainError(
        "NO_SESSION",
        "Join an authorized TA inspection voice room first.",
      );
    if (
      (await tx.queueTicket.count({
        where: {
          sessionId: session.id,
          status: {
            in: [
              "CLAIMED",
              "MOVING",
              "IN_PROGRESS",
              "MOVE_FAILED",
              "NEEDS_REVIEW",
            ],
          },
        },
      })) >= s.inspectionConcurrency
    )
      throw new DomainError(
        "BUSY",
        "Finish or resolve your current inspection first.",
      );
    let ticket = await tx.queueTicket.findFirst({
      where: {
        guildId,
        status: {
          in: ["QUEUED", "CLAIMED", "MOVING", "MOVE_FAILED", "NEEDS_REVIEW"],
        },
      },
      include: { coursework: true, session: true },
      orderBy: { sequence: "asc" },
    });
    if (!ticket) throw new DomainError("EMPTY", "No waiting students.");
    if (["CLAIMED", "MOVING"].includes(ticket.status)) {
      // Claims may line up concurrently; the transfer lease barrier enforces physical FIFO.
      const next = await tx.queueTicket.findFirst({
        where: {
          guildId,
          status: { in: ["QUEUED", "MOVE_FAILED", "NEEDS_REVIEW"] },
        },
        include: { coursework: true, session: true },
        orderBy: { sequence: "asc" },
      });
      if (!next) throw new DomainError("EMPTY", "No waiting students.");
      ticket = next;
    }
    if (ticket.status !== "QUEUED")
      throw new DomainError(
        "FIFO_BLOCKED",
        `Ticket #${ticket.sequence} is ${ticket.status}. Finish or reconcile its dispatch before calling another student.`,
      );
    if (!canHandle(ticket.coursework, session, ticket.courseworkId))
      throw new DomainError(
        "FIFO_ELIGIBILITY",
        `Next student #${ticket.sequence} requires an eligible TA for ${ticket.coursework.name}. No later ticket can be called.`,
      );
    const oldSession = ticket.sessionId;
    await tx.queueTicket.update({
      where: { id: ticket.id },
      data: {
        status: "CLAIMED",
        sessionId: session.id,
        assisted: session.capacity === 0,
      },
    });
    if (oldSession !== session.id)
      await event(
        tx,
        guildId,
        actor,
        "queue.dispatched",
        "Global FIFO ticket assigned to inspecting TA only at claim.",
        { ticketId: ticket.id, from: oldSession, to: session.id },
      );
    const operation = await tx.voiceTransferOperation.create({
      data: { ticketId: ticket.id, targetChannelId: session.voiceChannelId },
    });
    await event(
      tx,
      guildId,
      actor,
      "queue.claimed",
      `Ticket #${ticket.sequence} claimed.`,
      { ticketId: ticket.id, operationId: operation.id },
    );
    return {
      ticketId: ticket.id,
      operationId: operation.id,
      sequence: ticket.sequence,
    };
  });
}
export async function setPresence(
  guildId: string,
  taId: string,
  channelId: string | null,
) {
  return locked(guildId, async (tx) => {
    const sessions = await tx.tASession.findMany({
      where: { guildId, taId, status: { not: "COMPLETED" } },
    });
    for (const s of sessions) {
      const present = channelId === s.voiceChannelId;
      if (s.present !== present) {
        await tx.tASession.update({
          where: { id: s.id },
          data: { present, lastPresence: new Date() },
        });
        await event(
          tx,
          guildId,
          taId,
          "session.presence",
          present
            ? "TA returned to assigned room."
            : "TA left assigned room; new admissions suspended.",
          { sessionId: s.id, present },
        );
      }
    }
  });
}
export async function leaseTransfer(id: string) {
  const op = await db.voiceTransferOperation.findUniqueOrThrow({
    where: { id },
    include: { ticket: true },
  });
  return locked(op.ticket.guildId, async (tx, s) => {
    const current = await tx.voiceTransferOperation.findUniqueOrThrow({
      where: { id },
      include: { ticket: { include: fullTicket } },
    });
    if (
      ["SUCCEEDED", "CANCELLED"].includes(current.state) ||
      (current.leaseUntil && current.leaseUntil > new Date()) ||
      current.nextAttemptAt > new Date()
    )
      return null;
    if (
      !["CLAIMED", "MOVING", "MOVE_FAILED", "NEEDS_REVIEW"].includes(
        current.ticket.status,
      )
    )
      return null;
    const head = await tx.queueTicket.findFirst({
      where: { guildId: current.ticket.guildId, reservation: { isNot: null } },
      orderBy: { sequence: "asc" },
    });
    if (head?.id !== current.ticketId) return null;
    const token = randomUUID();
    await tx.voiceTransferOperation.update({
      where: { id },
      data: {
        state: "MOVING",
        leaseToken: token,
        leaseUntil: new Date(Date.now() + s.claimLeaseSeconds * 1000),
        attempts: { increment: 1 },
      },
    });
    await tx.queueTicket.update({
      where: { id: current.ticketId },
      data: { status: "MOVING" },
    });
    return { ...current, leaseToken: token };
  });
}
export async function finalizeTransfer(
  id: string,
  token: string,
  actualChannelId: string,
) {
  const op = await db.voiceTransferOperation.findUniqueOrThrow({
    where: { id },
    include: { ticket: true },
  });
  return locked(op.ticket.guildId, async (tx) => {
    const current = await tx.voiceTransferOperation.findUniqueOrThrow({
      where: { id },
      include: { ticket: { include: { reservation: true } } },
    });
    if (current.state === "SUCCEEDED") return current;
    if (
      current.leaseToken !== token ||
      current.targetChannelId !== actualChannelId ||
      current.ticket.status !== "MOVING"
    )
      throw new DomainError("STALE_TRANSFER", "Transfer must be reconciled.");
    const head = await tx.queueTicket.findFirst({
      where: { guildId: current.ticket.guildId, reservation: { isNot: null } },
      orderBy: { sequence: "asc" },
    });
    if (head?.id !== current.ticketId)
      throw new DomainError(
        "FIFO_BLOCKED",
        "An older ticket must finish dispatch first.",
      );
    await tx.voiceTransferOperation.update({
      where: { id },
      data: {
        state: "SUCCEEDED",
        verifiedAt: new Date(),
        leaseUntil: null,
        leaseToken: null,
        lastError: null,
      },
    });
    const ticket = await tx.queueTicket.update({
      where: { id: current.ticketId },
      data: { status: "IN_PROGRESS" },
      include: { session: true },
    });
    await tx.inspection.upsert({
      where: { ticketId: ticket.id },
      create: {
        ticketId: ticket.id,
        taId: ticket.session!.taId,
        assisted: ticket.assisted,
        voiceChannelId: actualChannelId,
      },
      update: {},
    });
    await tx.queueReservation.deleteMany({ where: { ticketId: ticket.id } });
    await event(
      tx,
      ticket.guildId,
      ticket.session!.taId,
      "transfer.succeeded",
      `Ticket #${ticket.sequence} reached the assigned room.`,
      { ticketId: ticket.id, channelId: actualChannelId },
    );
    return ticket;
  });
}
export async function failTransfer(
  id: string,
  token: string,
  reason: string,
  uncertain = false,
) {
  const op = await db.voiceTransferOperation.findUniqueOrThrow({
    where: { id },
    include: { ticket: true },
  });
  return locked(op.ticket.guildId, async (tx, s) => {
    const current = await tx.voiceTransferOperation.findUniqueOrThrow({
      where: { id },
    });
    if (current.leaseToken !== token || current.state === "SUCCEEDED") return;
    const review = uncertain || current.attempts >= s.maxMoveAttempts;
    await tx.voiceTransferOperation.update({
      where: { id },
      data: {
        state: review ? "NEEDS_REVIEW" : "FAILED",
        leaseToken: null,
        leaseUntil: null,
        lastError: reason.slice(0, 400),
        nextAttemptAt: new Date(
          Date.now() + Math.min(300000, 1000 * 2 ** current.attempts),
        ),
      },
    });
    await tx.queueTicket.update({
      where: { id: current.ticketId },
      data: { status: review ? "NEEDS_REVIEW" : "MOVE_FAILED" },
    });
    await event(
      tx,
      op.ticket.guildId,
      "system",
      "transfer.failed",
      reason,
      { operationId: id, review },
      "error",
    );
  });
}
export async function retryMove(
  guildId: string,
  actor: string,
  key: string,
  ticketId: string,
) {
  return mutate(guildId, actor, "retry", key, async (tx) => {
    const t = await tx.queueTicket.findFirstOrThrow({
      where: {
        id: ticketId,
        guildId,
        status: { in: ["MOVE_FAILED", "NEEDS_REVIEW"] },
      },
    });
    const op = await tx.voiceTransferOperation.findFirstOrThrow({
      where: { ticketId: t.id, state: { not: "SUCCEEDED" } },
      orderBy: { createdAt: "desc" },
    });
    if (op.leaseUntil && op.leaseUntil > new Date())
      throw new DomainError("LEASED", "Transfer is still being processed.");
    await tx.voiceTransferOperation.update({
      where: { id: op.id },
      data: { state: "PENDING", attempts: 0, nextAttemptAt: new Date() },
    });
    await tx.queueTicket.update({
      where: { id: t.id },
      data: { status: "CLAIMED" },
    });
    await event(
      tx,
      guildId,
      actor,
      "transfer.retry",
      "Transfer queued for reconciliation before retry.",
      { ticketId },
    );
    return op;
  });
}
export async function finishInspection(
  tx: Tx,
  ticket: {
    id: string;
    guildId: string;
    sessionId: string | null;
    sequence: number;
  },
  actor: string,
  reason: string,
  note = "",
) {
  const inspection = await tx.inspection.findUniqueOrThrow({
    where: { ticketId: ticket.id },
  });
  const pending = await tx.inspectionCompletion.findUnique({
    where: { ticketId: ticket.id },
  });
  if (inspection.completedAt) return;
  if (pending)
    await tx.inspectionCompletion.update({
      where: { ticketId: ticket.id },
      data: {
        state: "SUCCEEDED",
        verifiedAt: new Date(),
        leaseUntil: null,
        leaseToken: null,
        lastError: null,
      },
    });
  const noShow = pending?.outcome === "NO_SHOW";
  if (noShow) reason = "TA_MARKED_NO_SHOW";
  const completedAt = new Date();
  await tx.inspection.update({
    where: { id: inspection.id },
    data: {
      completedAt,
      status: noShow ? "NO_SHOW" : "COMPLETED",
      completionReason: reason,
      durationSeconds: Math.max(
        0,
        Math.floor(
          (completedAt.getTime() - inspection.startedAt.getTime()) / 1000,
        ),
      ),
      ...(note
        ? {
            note: (reason !== "MANUAL"
              ? [inspection.note, note].filter(Boolean).join("\n")
              : note
            ).slice(0, 2000),
          }
        : {}),
    },
  });
  await tx.queueTicket.update({
    where: { id: ticket.id },
    data: { status: noShow ? "NO_SHOW" : "COMPLETED" },
  });
  if (noShow)
    await tx.inspectionCompletion.update({
      where: { ticketId: ticket.id },
      data: { notificationState: "PENDING" },
    });
  await finishDrained(tx, ticket.sessionId);
  await event(
    tx,
    ticket.guildId,
    actor,
    noShow ? "inspection.no_show" : "inspection.completed",
    `Inspection #${ticket.sequence} completed (${reason}).`,
    { ticketId: ticket.id, inspectionId: inspection.id, reason },
  );
}
export async function observeStudentVoice(
  guildId: string,
  discordId: string,
  channelId: string | null,
  observedAt: Date,
  previousChannelId?: string | null,
  currentChannel?: () => string | null,
) {
  return locked(guildId, async (tx) => {
    if (currentChannel && currentChannel() !== channelId) return null;
    const ticket = await tx.queueTicket.findFirst({
      where: { guildId, student: { discordId }, status: { in: [...ACTIVE] } },
      include: fullTicket,
    });
    if (!ticket || ticket.createdAt > observedAt) return null;
    const waiting = await tx.channelBinding.findUnique({
      where: { guildId_feature: { guildId, feature: "waiting_voice" } },
    });
    if (
      (["QUEUED", "MOVE_FAILED"].includes(ticket.status) ||
        (ticket.status === "CLAIMED" &&
          ticket.transfers.every(
            (op) => ["PENDING", "FAILED"].includes(op.state) && !op.leaseToken,
          ))) &&
      (!channelId || !waiting?.channelIds.includes(channelId))
    ) {
      // A claimed but unleased transfer has never submitted a move; leased/uncertain moves must reconcile first.
      await tx.queueReservation.deleteMany({ where: { ticketId: ticket.id } });
      await tx.voiceTransferOperation.updateMany({
        where: { ticketId: ticket.id, state: { not: "SUCCEEDED" } },
        data: { state: "CANCELLED", leaseToken: null, leaseUntil: null },
      });
      await tx.queueTicket.update({
        where: { id: ticket.id },
        data: { status: "CANCELLED" },
      });
      await finishDrained(
        tx,
        ticket.reservation?.sessionId || ticket.sessionId,
      );
      await finishDrained(tx, ticket.sessionId);
      await event(
        tx,
        guildId,
        discordId,
        "queue.cancelled",
        `Ticket #${ticket.sequence} cancelled after leaving the waiting voice area. Request a new ticket to rejoin.`,
        { ticketId: ticket.id, reason: "VOICE_LEFT", channelId },
      );
      return { action: "cancelled", sequence: ticket.sequence };
    }
    const inspection = ticket.inspection;
    const room = inspection?.voiceChannelId || ticket.session?.voiceChannelId;
    if (
      ticket.status === "IN_PROGRESS" &&
      inspection &&
      !inspection.completedAt &&
      inspection.startedAt <= observedAt &&
      channelId !== room &&
      (previousChannelId === undefined || previousChannelId === room)
    ) {
      await finishInspection(
        tx,
        ticket,
        inspection.taId,
        channelId === null &&
          ticket.completion &&
          ticket.completion.state !== "SUCCEEDED"
          ? "TA_COMPLETED_AND_DISCONNECTED"
          : "VOICE_LEFT",
        channelId
          ? "Student moved to another voice channel."
          : "Student disconnected from voice.",
      );
      return {
        action:
          ticket.completion?.outcome === "NO_SHOW" ? "no_show" : "completed",
        sequence: ticket.sequence,
      };
    }
    return null;
  });
}
export async function completeInspection(
  guildId: string,
  actor: string,
  key: string,
  note = "",
) {
  return mutate(guildId, actor, "complete", key, async (tx) => {
    const ticket = await tx.queueTicket.findFirst({
      where: { guildId, status: "IN_PROGRESS", session: { taId: actor } },
      orderBy: { sequence: "asc" },
    });
    if (!ticket)
      throw new DomainError("NO_INSPECTION", "No inspection is in progress.");
    if (
      await tx.inspectionCompletion.findUnique({
        where: { ticketId: ticket.id },
      })
    )
      throw new DomainError(
        "COMPLETION_PENDING",
        "Reconcile the pending disconnect first.",
      );
    if (
      (await tx.queueTicket.count({
        where: {
          guildId,
          status: "IN_PROGRESS",
          inspection: { taId: actor, completedAt: null },
        },
      })) !== 1
    )
      throw new DomainError(
        "AMBIGUOUS_INSPECTION",
        "Choose a specific inspection.",
      );
    await finishInspection(tx, ticket, actor, "MANUAL", note);
    return tx.queueTicket.findUniqueOrThrow({
      where: { id: ticket.id },
      include: fullTicket,
    });
  });
}
export async function snapshot(guildId: string) {
  return db.$transaction(
    async (tx) => {
      const [
        guild,
        tickets,
        sessions,
        courses,
        support,
        events,
        heartbeats,
        presence,
        rooms,
      ] = await Promise.all([
        tx.guild.findUniqueOrThrow({ where: { id: guildId } }),
        tx.queueTicket.findMany({
          where: { guildId, status: { in: [...ACTIVE] } },
          include: fullTicket,
          orderBy: { sequence: "asc" },
        }),
        tx.tASession.findMany({
          where: { guildId, status: { not: "COMPLETED" } },
          include: { _count: { select: { reservations: true } } },
          orderBy: { activatedAt: "asc" },
        }),
        tx.coursework.findMany({
          where: { guildId },
          orderBy: { sortOrder: "asc" },
        }),
        tx.supportTicket.count({
          where: { guildId, status: { not: "CLOSED" } },
        }),
        tx.systemEvent.findMany({
          where: { guildId },
          orderBy: { id: "desc" },
          take: 40,
        }),
        tx.serviceHeartbeat.findMany(),
        tx.tAPresence.findMany({
          where: { guildId, observedAt: { gt: new Date(Date.now() - 120000) } },
        }),
        tx.channelBinding.findUnique({
          where: { guildId_feature: { guildId, feature: "ta_voice" } },
        }),
      ]);
      const accepting = sessions.filter(
        (s) => s.status === "ACCEPTING" && s.present && !s.paused,
      );
      const settings = settingsSchema.parse(guild.settings);
      return json({
        guild,
        settings,
        tickets,
        sessions,
        courses,
        support,
        events,
        heartbeats,
        metrics: {
          capacity: accepting.reduce((n, s) => n + s.capacity, 0),
          available: Math.max(
            0,
            accepting.reduce((n, s) => n + s.capacity, 0) -
              tickets.filter((t) => t.reservation).length,
          ),
          waiting: tickets.filter((t) => t.reservation).length,
          draining: Math.max(
            0,
            tickets.filter((t) => t.reservation).length -
              accepting.reduce((n, s) => n + s.capacity, 0),
          ),
          inProgress: tickets.filter((t) => t.status === "IN_PROGRESS").length,
          activeTAs: accepting.length,
          availableTAs: presence.filter((p) => {
            const session = sessions.find((x) => x.taId === p.taId);
            return (
              p.roleIds.includes(settings.taRole) &&
              rooms?.channelIds.includes(p.voiceChannelId) &&
              !session?.paused &&
              (!session || session.voiceChannelId === p.voiceChannelId) &&
              !sessions.some(
                (x) =>
                  x.voiceChannelId === p.voiceChannelId && x.taId !== p.taId,
              ) &&
              tickets.filter(
                (t) =>
                  t.session?.taId === p.taId &&
                  ["CLAIMED", "MOVING", "IN_PROGRESS"].includes(t.status),
              ).length < settings.inspectionConcurrency &&
              courses.some(
                (c) =>
                  c.enabled &&
                  !c.archived &&
                  (!c.startsAt || c.startsAt <= new Date()) &&
                  (!c.endsAt || c.endsAt > new Date()) &&
                  canHandle(
                    c,
                    { ...p, courseworkIds: session?.courseworkIds || [] },
                    c.id,
                  ),
              )
            );
          }).length,
          failed: tickets.filter(
            (t) =>
              ["MOVE_FAILED", "NEEDS_REVIEW"].includes(t.status) ||
              t.completion?.state === "NEEDS_REVIEW",
          ).length,
        },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
export async function integrity(guildId: string) {
  const tickets = await db.queueTicket.findMany({
    where: { guildId, status: { in: [...ACTIVE] } },
    include: fullTicket,
  });
  const issues: string[] = [];
  for (const t of tickets) {
    if (
      (t.session && t.session.guildId !== guildId) ||
      t.student.guildId !== guildId ||
      t.coursework.guildId !== guildId
    )
      issues.push(`${t.id}: cross-guild reference`);
    if (t.status !== "IN_PROGRESS" && !t.reservation)
      issues.push(`${t.id}: missing reservation`);
    if (t.status === "IN_PROGRESS" && (!t.inspection || t.reservation))
      issues.push(`${t.id}: inconsistent inspection`);
    if (t.status === "QUEUED" && (t.sessionId || t.reservation?.sessionId))
      issues.push(`${t.id}: waiting ticket has a TA owner`);
    if (
      [
        "CLAIMED",
        "MOVING",
        "IN_PROGRESS",
        "MOVE_FAILED",
        "NEEDS_REVIEW",
      ].includes(t.status) &&
      !t.sessionId
    )
      issues.push(`${t.id}: dispatch has no inspecting TA`);
  }
  const sessions = await db.tASession.findMany({
    where: { guildId, status: { not: "COMPLETED" } },
  });
  return {
    ok: issues.length === 0,
    issues,
    ticketsChecked: tickets.length,
    sessionsChecked: sessions.length,
  };
}
export type { TicketStatus };
