import { measure } from "../../../packages/config/src/performance";
import { PermissionFlagsBits } from "discord.js";
import { logger } from "../../../packages/config/src/index";
import { db } from "../../../packages/database/src/index";
import { DomainError } from "../../../packages/shared/src/index";
import {
  leaseCompletion,
  finalizeCompletion,
  failCompletion,
} from "../../../packages/queue-engine/src/completion";
import { context, authorizeTA } from "./discord";

export function processCompletion(ticketId: string) {
  return measure("discord.inspection_finalization", () =>
    runCompletion(ticketId),
  );
}
async function runCompletion(ticketId: string) {
  const op = await leaseCompletion(ticketId);
  if (!op) return;
  try {
    const ctx = await context(op.ticket.guildId);
    const student = await ctx.guild.members
      .fetch(op.studentDiscordId || op.ticket.student.discordId!)
      .catch((e) => {
        if (e.code === 10007) return null;
        throw e;
      });
    if (student?.voice.channelId) {
      const ta = await authorizeTA(op.ticket.guildId, op.actorId);
      if (
        ta.room.id !== op.voiceChannelId ||
        student.voice.channelId !== op.voiceChannelId
      )
        throw new DomainError(
          "VOICE",
          "Student or TA is outside the inspection's assigned room. Reconcile before retrying.",
        );
      const bot = ta.bot;
      if (!ta.room.permissionsFor(bot)?.has(PermissionFlagsBits.MoveMembers))
        throw new DomainError(
          "PERMISSIONS",
          "Bot needs Move Members to disconnect the inspected student.",
        );
      const current = await db.inspectionCompletion.findUniqueOrThrow({
        where: { ticketId },
      });
      if (current.state === "SUCCEEDED") return;
      if (
        current.leaseToken !== op.leaseToken ||
        ta.member.voice.channelId !== op.voiceChannelId ||
        student.voice.channelId !== op.voiceChannelId
      )
        throw new DomainError(
          "COMPLETION_PENDING",
          "Voice operation changed; reconcile before retrying.",
        );
      await student.voice.disconnect(
        op.outcome === "NO_SHOW"
          ? "TA_MARKED_NO_SHOW"
          : "TA_COMPLETED_AND_DISCONNECTED",
      );
      // Gateway confirmation can follow the REST response; do not treat an accepted request as success.
      const deadline = Date.now() + 5000;
      while (student.voice.channelId && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await finalizeCompletion(
      ticketId,
      op.leaseToken!,
      () => !student?.voice.channelId,
    );
  } catch (error) {
    const current = await db.inspectionCompletion.findUniqueOrThrow({
      where: { ticketId },
    });
    if (current.state === "SUCCEEDED") return;
    logger.error({ err: error, ticketId }, "Inspection disconnect failed");
    await failCompletion(
      ticketId,
      op.leaseToken!,
      error instanceof DomainError
        ? error.message
        : "Discord disconnect failed. Check Move Members and retry.",
    );
    throw new DomainError(
      "COMPLETION_FAILED",
      "Disconnect is not verified; the inspection remains recoverable.",
    );
  }
}

export function notifyNoShow(ticketId: string) {
  return measure("discord.no_show_dm", () => runNoShowNotification(ticketId));
}
async function runNoShowNotification(ticketId: string) {
  const ticket = await db.queueTicket.findUniqueOrThrow({
    where: { id: ticketId },
  });
  const token = (await import("node:crypto")).randomUUID();
  const { locked, event, fullTicket } =
    await import("../../../packages/queue-engine/src/index");
  const op = await locked(ticket.guildId, async (tx, settings) => {
    const current = await tx.inspectionCompletion.findUniqueOrThrow({
      where: { ticketId },
      include: { ticket: { include: fullTicket } },
    });
    if (
      current.outcome !== "NO_SHOW" ||
      current.state !== "SUCCEEDED" ||
      !["PENDING", "SENDING"].includes(current.notificationState) ||
      (current.leaseUntil && current.leaseUntil > new Date())
    )
      return null;
    if (!settings.noShowDMEnabled) {
      await tx.inspectionCompletion.update({
        where: { ticketId },
        data: { notificationState: "SKIPPED" },
      });
      return null;
    }
    return tx.inspectionCompletion.update({
      where: { ticketId },
      data: {
        notificationState: "SENDING",
        leaseToken: token,
        leaseUntil: new Date(Date.now() + 90000),
      },
      include: { ticket: { include: fullTicket } },
    });
  });
  if (!op) return;
  const { rest, client } = await import("./discord");
  const { Routes } = await import("discord.js");
  const { render, defaults, templateSchema } =
    await import("../../../packages/discord-ui/src/index");
  const { createHash } = await import("node:crypto");
  try {
    const ref = createHash("sha256")
      .update(`no-show:${ticketId}`)
      .digest("hex")
      .slice(0, 12);
    const channel =
      op.notificationChannelId ||
      (
        (await rest.post(Routes.userChannels(), {
          body: {
            recipient_id: op.studentDiscordId || op.ticket.student.discordId,
          },
        })) as { id: string }
      ).id;
    await db.inspectionCompletion.updateMany({
      where: { ticketId, leaseToken: token },
      data: { notificationChannelId: channel },
    });
    let messageId = op.notificationMessageId;
    if (op.notificationState === "SENDING" && !messageId) {
      let before: string | undefined;
      for (let page = 0; page < 20; page++) {
        const messages = (await rest.get(Routes.channelMessages(channel), {
          query: new URLSearchParams({
            limit: "100",
            ...(before ? { before } : {}),
          }),
        })) as import("discord.js").APIMessage[];
        messageId =
          messages.find(
            (m) =>
              m.author.id === client.user?.id &&
              JSON.stringify(m).includes(`อ้างอิง ${ref}`),
          )?.id || null;
        if (
          messageId ||
          messages.length < 100 ||
          new Date(messages[messages.length - 1].timestamp) <= op.createdAt
        )
          break;
        if (page === 19)
          throw new DomainError(
            "DM_REVIEW",
            "Cannot safely determine whether the No Show DM was delivered. Review the message history.",
          );
        before = messages[messages.length - 1].id;
      }
    }
    if (!messageId) {
      const template = await db.embedTemplate.findFirst({
        where: { guildId: ticket.guildId, feature: "no_show_dm" },
        orderBy: { id: "asc" },
      });
      const doc = templateSchema.parse(
        template?.document || defaults.no_show_dm,
      );
      if (doc.buttons.length || doc.courseworkSelect)
        throw new DomainError(
          "TEMPLATE",
          "No Show DM cannot contain interactive controls.",
        );
      if (!doc.notificationEnabled) {
        await db.inspectionCompletion.updateMany({
          where: { ticketId, leaseToken: token },
          data: {
            notificationState: "SKIPPED",
            leaseToken: null,
            leaseUntil: null,
          },
        });
        return;
      }
      const sent = (await rest.post(Routes.channelMessages(channel), {
        body: {
          ...render(
            { ...doc, footer: `${doc.footer.slice(0, 1950)} · อ้างอิง ${ref}` },
            {
              "coursework.name": op.ticket.coursework.name,
              "queue.number": op.ticket.sequence,
              "ticket.id": op.ticket.sequence,
              "ta.name": op.ticket.session?.taName || "ผู้ช่วยสอน",
              "student.name": `${op.ticket.student.name} ${op.ticket.student.lastname}`,
            },
          ),
          nonce: BigInt(
            `0x${createHash("sha256").update(`no-show:${ticketId}`).digest("hex").slice(0, 15)}`,
          ).toString(),
          enforce_nonce: true,
        },
      })) as { id: string };
      messageId = sent.id;
    }
    await locked(ticket.guildId, async (tx) => {
      await tx.inspectionCompletion.updateMany({
        where: { ticketId, leaseToken: token },
        data: {
          notificationState: "SENT",
          notificationMessageId: messageId,
          notificationSentAt: new Date(),
          notificationError: null,
          leaseToken: null,
          leaseUntil: null,
        },
      });
      await event(
        tx,
        ticket.guildId,
        op.actorId,
        "inspection.no_show_dm_sent",
        "No Show DM delivered to the inspection's student.",
        { ticketId },
      );
    });
  } catch (error) {
    const disabled = (error as { code?: number }).code === 50007;
    await locked(ticket.guildId, async (tx) => {
      await tx.inspectionCompletion.updateMany({
        where: { ticketId, leaseToken: token },
        data: {
          notificationState: disabled
            ? "FAILED"
            : error instanceof DomainError && error.code === "DM_REVIEW"
              ? "NEEDS_REVIEW"
              : "SENDING",
          notificationError: disabled
            ? "Student has disabled private messages."
            : "No Show DM delivery requires reconciliation.",
          leaseUntil: disabled ? null : new Date(Date.now() + 60000),
          leaseToken: null,
        },
      });
      await event(
        tx,
        ticket.guildId,
        op.actorId,
        "inspection.no_show_dm_failed",
        disabled
          ? "Student's DM is unavailable; No Show remains finalized."
          : "No Show DM delivery deferred for safe reconciliation.",
        { ticketId },
        "warn",
      );
    });
    logger.warn({ err: error, ticketId }, "No Show DM delivery failed");
  }
}
