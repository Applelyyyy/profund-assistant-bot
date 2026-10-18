import { randomUUID } from "node:crypto";
import { db } from "../../database/src/index";
import { DomainError } from "../../shared/src/index";
import { mutate, locked, event, finishInspection, fullTicket } from "./index";

export async function requestCompletion(
  guildId: string,
  actorId: string,
  key: string,
  voiceChannelId: string,
  outcome: "COMPLETED" | "NO_SHOW" = "COMPLETED",
  expectedTicketId?: string,
) {
  return mutate(
    guildId,
    actorId,
    outcome === "NO_SHOW" ? "mark_no_show" : "disconnect_complete",
    key,
    async (tx) => {
      const tickets = await tx.queueTicket.findMany({
        where: {
          guildId,
          status: "IN_PROGRESS",
          inspection: { taId: actorId, completedAt: null },
        },
        include: fullTicket,
      });
      if (!tickets.length)
        throw new DomainError("NO_INSPECTION", "No inspection is in progress.");
      if (tickets.length !== 1)
        throw new DomainError(
          "AMBIGUOUS_INSPECTION",
          "Select a specific inspection through administrator recovery.",
        );
      const ticket = tickets[0];
      if (expectedTicketId && ticket.id !== expectedTicketId)
        throw new DomainError(
          "CONFIRMATION_EXPIRED",
          "Inspection changed; request confirmation again.",
        );
      if (
        (ticket.inspection!.voiceChannelId ||
          ticket.session?.voiceChannelId) !== voiceChannelId
      )
        throw new DomainError(
          "VOICE",
          "Return to the inspection's assigned voice room.",
        );
      if (
        await tx.serviceOperation.findFirst({
          where: {
            guildId,
            action: "return_student",
            status: { in: ["PENDING", "RUNNING"] },
            data: { path: ["ticketId"], equals: ticket.id },
          },
        })
      )
        throw new DomainError(
          "COMPLETION_PENDING",
          "Another voice operation is pending.",
        );
      const old = await tx.inspectionCompletion.findUnique({
        where: { ticketId: ticket.id },
      });
      if (old && old.outcome !== outcome)
        throw new DomainError(
          "COMPLETION_PENDING",
          "A conflicting inspection decision is already pending.",
        );
      if (old?.leaseUntil && old.leaseUntil > new Date()) return old;
      const op = await tx.inspectionCompletion.upsert({
        where: { ticketId: ticket.id },
        create: {
          ticketId: ticket.id,
          actorId,
          voiceChannelId,
          outcome,
          studentDiscordId: ticket.student.discordId,
        },
        update: {
          state: "PENDING",
          attempts: 0,
          nextAttemptAt: new Date(),
          lastError: null,
        },
      });
      await event(
        tx,
        guildId,
        actorId,
        "inspection.completion_requested",
        "Disconnect and completion requested.",
        { ticketId: ticket.id },
      );
      return op;
    },
  );
}
export async function leaseCompletion(ticketId: string) {
  const ticket = await db.queueTicket.findUniqueOrThrow({
    where: { id: ticketId },
  });
  return locked(ticket.guildId, async (tx) => {
    const op = await tx.inspectionCompletion.findUniqueOrThrow({
      where: { ticketId },
    });
    if (
      !["PENDING", "DISCONNECTING"].includes(op.state) ||
      op.nextAttemptAt > new Date() ||
      (op.leaseUntil && op.leaseUntil > new Date())
    )
      return null;
    return tx.inspectionCompletion.update({
      where: { ticketId },
      data: {
        state: "DISCONNECTING",
        attempts: { increment: 1 },
        leaseToken: randomUUID(),
        leaseUntil: new Date(Date.now() + 90000),
      },
      include: { ticket: { include: fullTicket } },
    });
  });
}
export async function finalizeCompletion(
  ticketId: string,
  leaseToken: string,
  disconnected: () => boolean,
) {
  const ticket = await db.queueTicket.findUniqueOrThrow({
    where: { id: ticketId },
  });
  return locked(ticket.guildId, async (tx) => {
    const op = await tx.inspectionCompletion.findUniqueOrThrow({
      where: { ticketId },
    });
    if (op.state === "SUCCEEDED") return;
    if (op.leaseToken !== leaseToken || !disconnected())
      throw new DomainError(
        "COMPLETION_FAILED",
        "Disconnection has not been verified.",
      );
    await finishInspection(
      tx,
      ticket,
      op.actorId,
      op.outcome === "NO_SHOW"
        ? "TA_MARKED_NO_SHOW"
        : "TA_COMPLETED_AND_DISCONNECTED",
    );
  });
}
export async function failCompletion(
  ticketId: string,
  leaseToken: string,
  message: string,
) {
  const ticket = await db.queueTicket.findUniqueOrThrow({
    where: { id: ticketId },
  });
  return locked(ticket.guildId, async (tx, s) => {
    const op = await tx.inspectionCompletion.findUniqueOrThrow({
      where: { ticketId },
    });
    if (op.leaseToken !== leaseToken || op.state === "SUCCEEDED") return;
    await tx.inspectionCompletion.update({
      where: { ticketId },
      data: {
        state: op.attempts >= s.maxMoveAttempts ? "NEEDS_REVIEW" : "PENDING",
        nextAttemptAt: new Date(
          Date.now() + Math.min(300000, 5000 * 2 ** op.attempts),
        ),
        leaseToken: null,
        leaseUntil: null,
        lastError: message,
      },
    });
    await event(
      tx,
      ticket.guildId,
      op.actorId,
      "inspection.disconnect_failed",
      message,
      { ticketId },
      "error",
    );
  });
}
