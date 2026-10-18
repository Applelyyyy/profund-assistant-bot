import { Prisma } from "@prisma/client";
import { ACTIVE, canHandle } from "../../../packages/shared/src/index";
import { locked, event } from "../../../packages/queue-engine/src/index";

export async function reconcileGuild(guildId: string) {
  await locked(guildId, async (tx, s) => {
    const unresolved = await tx.queueTicket.findMany({
      where: { guildId, status: { in: [...ACTIVE] } },
      include: { coursework: true },
    });
    const sessions = await tx.tASession.findMany({
      where: { guildId, status: { not: "COMPLETED" }, present: true },
    });
    const presence = await tx.tAPresence.findMany({
      where: { guildId, observedAt: { gt: new Date(Date.now() - 120000) } },
    });
    const rooms = await tx.channelBinding.findUnique({
      where: { guildId_feature: { guildId, feature: "ta_voice" } },
    });
    const eligible = [
      ...sessions,
      ...presence
        .filter(
          (p) =>
            rooms?.channelIds.includes(p.voiceChannelId) &&
            p.roleIds.includes(s.taRole),
        )
        .map((p) => ({
          ...p,
          courseworkIds:
            sessions.find((s) => s.taId === p.taId)?.courseworkIds || [],
        })),
    ].some((session) =>
      unresolved.some((t) => canHandle(t.coursework, session, t.courseworkId)),
    );
    const incident = await tx.queueIncident.findUnique({
      where: { guildId },
    });
    if (unresolved.length && !eligible) {
      if (!incident || incident.resolvedAt)
        await tx.queueIncident.upsert({
          where: { guildId },
          create: {
            guildId,
            startedAt: new Date(),
            unresolvedCount: unresolved.length,
          },
          update: {
            startedAt: new Date(),
            notifiedAt: null,
            resolvedAt: null,
            unresolvedCount: unresolved.length,
          },
        });
      else if (
        !incident.notifiedAt &&
        Date.now() - incident.startedAt.getTime() >=
          s.alertGraceSeconds * 1000 &&
        !(await tx.systemEvent.findFirst({
          where: {
            guildId,
            type: "queue.abandoned",
            createdAt: {
              gt: new Date(Date.now() - s.alertCooldownSeconds * 1000),
            },
          },
        }))
      ) {
        await tx.serviceOperation.create({
          data: { guildId, actorId: "system", action: "abandoned_alert" },
        });
        await tx.queueIncident.update({
          where: { guildId },
          data: {
            notifiedAt: new Date(),
            unresolvedCount: unresolved.length,
          },
        });
        await event(
          tx,
          guildId,
          "system",
          "queue.abandoned",
          "No eligible TA present with unresolved tickets.",
          { unresolved: unresolved.length },
          "warn",
        );
      }
    } else if (incident && !incident.resolvedAt) {
      await tx.queueIncident.update({
        where: { guildId },
        data: { resolvedAt: new Date() },
      });
      await event(
        tx,
        guildId,
        "system",
        "queue.recovered",
        "TA presence or queue resolution ended the incident.",
      );
    }
    const now = Date.now();
    const checks = unresolved.flatMap((ticket) => {
      const entries: { key: string; action: string; ticket: typeof ticket }[] =
        [];
      if (
        ["MOVING", "CLAIMED", "NEEDS_REVIEW", "MOVE_FAILED"].includes(
          ticket.status,
        ) &&
        now - ticket.updatedAt.getTime() > s.staleWarningSeconds * 1000
      )
        entries.push({
          key: `stale:${ticket.id}:${ticket.status}`,
          action: "stale_warning",
          ticket,
        });
      if (
        s.noShowTimeoutSeconds > 0 &&
        ["QUEUED", "MOVE_FAILED"].includes(ticket.status) &&
        now - ticket.createdAt.getTime() > s.noShowTimeoutSeconds * 1000
      )
        entries.push({
          key: `no-show-check:${ticket.id}:${Math.floor(now / 60000)}`,
          action: "check_no_show",
          ticket,
        });
      return entries;
    });
    const existing = new Set(
      checks.length
        ? (
            await tx.idempotencyRecord.findMany({
              where: { guildId, key: { in: checks.map((check) => check.key) } },
              select: { key: true },
            })
          ).map((record) => record.key)
        : [],
    );
    const pending = checks.filter((check) => !existing.has(check.key));
    if (pending.length)
      await tx.idempotencyRecord.createMany({
        data: pending.map(({ key, action, ticket }) => ({
          key,
          guildId,
          actorId: "system",
          action,
          result: { ticketId: ticket.id },
        })),
      });
    for (const { ticket } of pending.filter(
      (check) => check.action === "stale_warning",
    )) {
      await event(
        tx,
        guildId,
        "system",
        "queue.stale",
        "Ticket requires transfer reconciliation.",
        { ticketId: ticket.id, status: ticket.status },
        "warn",
      );
    }
    const noShows = pending.filter((check) => check.action === "check_no_show");
    if (noShows.length)
      await tx.serviceOperation.createMany({
        data: noShows.map(({ ticket }) => ({
          guildId,
          actorId: "system",
          action: "check_no_show",
          data: { ticketId: ticket.id },
        })),
      });
    await tx.supportTicket.updateMany({
      where: {
        guildId,
        status: "CLOSED",
        closedAt: {
          lt: new Date(Date.now() - s.transcriptRetentionDays * 86400000),
        },
        transcript: { not: Prisma.DbNull },
      },
      data: { transcript: Prisma.DbNull },
    });
  });
}
