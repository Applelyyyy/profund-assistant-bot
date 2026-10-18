import type { SystemEvent } from "@prisma/client";
import {
  Routes,
  ChannelType,
  PermissionFlagsBits as P,
  escapeMarkdown,
} from "discord.js";
import { createHash } from "node:crypto";
import { db } from "../../../packages/database/src/index";
import { env, logger } from "../../../packages/config/src/index";
import {
  defaults,
  th,
  render,
  arrivalTemplateSchema,
} from "../../../packages/discord-ui/src/index";
import { context, rest } from "./discord";
export async function notifyEvents() {
  const ctx = await context(env().DISCORD_GUILD_ID);
  await notifyArrivals();
  const channels = new Set([
    ...ctx.channels("audit_log"),
    ...ctx.channels("error_log"),
  ]);
  for (const channelId of channels) {
    const isAudit = ctx.channels("audit_log").includes(channelId);
    const events = await db.$queryRaw<
      SystemEvent[]
    >`SELECT e.* FROM "SystemEvent" e LEFT JOIN "NotificationDelivery" n ON n."eventId"=e.id AND n."channelId"=${channelId} WHERE e."guildId"=${ctx.guild.id} AND (n.id IS NULL OR n.status='PENDING') AND (${isAudit} OR e.severity='error') ORDER BY e.id ASC LIMIT 50`;
    for (const e of events) {
      const id = `${e.id}:${channelId}`;
      const old = await db.notificationDelivery.findUnique({ where: { id } });
      if (old?.status === "SENT") continue;
      const pending = await db.notificationDelivery.upsert({
        where: { id },
        create: { id, guildId: ctx.guild.id, eventId: e.id, channelId },
        update: {},
      });
      if (pending.status === "FAILED") continue;
      try {
        const nonce = BigInt(
          `0x${createHash("sha256").update(id).digest("hex").slice(0, 15)}`,
        ).toString();
        await rest.post(Routes.channelMessages(channelId), {
          body: {
            embeds: [
              {
                title:
                  `${e.severity === "error" ? th.errorTitle : th.auditTitle} · ${e.type}`.slice(
                    0,
                    256,
                  ),
                description:
                  e.severity === "error"
                    ? th.errorDescription
                    : th.auditDescription,
                color: e.severity === "error" ? 0xdb5266 : 0x898aff,
                fields: [
                  {
                    name: th.severity,
                    value:
                      e.severity === "error" ? th.errorTitle : th.auditTitle,
                    inline: true,
                  },
                  {
                    name: th.correlation,
                    value: e.correlationId,
                    inline: true,
                  },
                  {
                    name: th.retryStatus,
                    value: e.type.includes("failed")
                      ? th.reviewRetry
                      : th.retryNotRequired,
                    inline: false,
                  },
                ],
                timestamp: e.createdAt.toISOString(),
              },
            ],
            allowed_mentions: { parse: [] },
            nonce,
            enforce_nonce: true,
          },
        });
        await db.notificationDelivery.update({
          where: { id },
          data: { status: "SENT", sentAt: new Date() },
        });
      } catch (error) {
        await db.notificationDelivery.update({
          where: { id },
          data: {
            status: "FAILED",
            error: "Discord notification failed. Check channel permissions.",
          },
        });
        logger.error(
          { err: error, eventId: e.id, channelId },
          "Event notification failed",
        );
      }
    }
  }
}

export async function notifyArrivals() {
  const ctx = await context(env().DISCORD_GUILD_ID);
  const template = await db.embedTemplate.findFirst({
    where: { guildId: ctx.guild.id, feature: "arrival" },
    orderBy: { id: "asc" },
  });
  const document = arrivalTemplateSchema.parse(
    template?.document || defaults.arrival,
  );
  const events = await db.$queryRaw<
    SystemEvent[]
  >`SELECT e.* FROM "SystemEvent" e LEFT JOIN "NotificationDelivery" n ON n.id=('arrival:' || e.id) WHERE e."guildId"=${ctx.guild.id} AND e.type='transfer.succeeded' AND (n.id IS NULL OR n.status='PENDING') ORDER BY e.id ASC LIMIT 20`;
  for (const event of events) {
    const id = `arrival:${event.id}`;
    const data = event.data as { ticketId: string; channelId: string };
    const ticket = await db.queueTicket.findFirst({
      where: { id: data.ticketId, guildId: ctx.guild.id },
      include: {
        student: true,
        coursework: true,
        session: true,
        transfers: true,
      },
    });
    if (
      !ticket ||
      !ticket.transfers.some(
        (op) =>
          op.state === "SUCCEEDED" && op.targetChannelId === data.channelId,
      )
    )
      continue;
    let channelId = data.channelId;
    const old = await db.notificationDelivery.findUnique({ where: { id } });
    let selectedDestination = !!old?.channelId;
    if (old?.status === "SENT" || old?.status === "SKIPPED") continue;
    if (
      !ctx.settings.notifications ||
      !ctx.settings.routineAnnouncements ||
      !document.notificationEnabled
    ) {
      await db.notificationDelivery.upsert({
        where: { id },
        create: {
          id,
          guildId: ctx.guild.id,
          eventId: event.id,
          channelId,
          status: "SKIPPED",
        },
        update: { status: "SKIPPED" },
      });
      continue;
    }
    try {
      const bot = await ctx.guild.members.fetchMe();
      const room = await ctx.guild.channels
        .fetch(old?.channelId || channelId)
        .catch((e) => {
          if (e.code === 10003) return null;
          throw e;
        });
      const allowed = (c: typeof room) =>
        !!c &&
        "guild" in c &&
        c.guild.id === ctx.guild.id &&
        [
          ChannelType.GuildVoice,
          ChannelType.GuildText,
          ChannelType.GuildAnnouncement,
        ].includes(c.type) &&
        c
          .permissionsFor(bot)
          ?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks]);
      let destination = room;
      if (!old?.channelId && !allowed(room) && document.fallbackChannelId)
        destination = await ctx.guild.channels.fetch(
          document.fallbackChannelId,
        );
      if (!allowed(destination))
        throw new Error(
          "No permitted arrival notification destination. Configure an explicit fallback in Embed Builder.",
        );
      channelId = destination!.id;
      await db.notificationDelivery.upsert({
        where: { id },
        create: { id, guildId: ctx.guild.id, eventId: event.id, channelId },
        update: old?.channelId ? {} : { channelId },
      });
      selectedDestination = true;
      const safe = (v: string) => escapeMarkdown(v).replaceAll("@", "＠");
      const body = render(document, {
        "student.name": safe(
          `${ticket.student.name} ${ticket.student.lastname}`,
        ),
        "student.id": document.includeStudentId
          ? safe(ticket.student.studentId)
          : th.student,
        "student.mention": `<@${ticket.student.discordId}>`,
        "coursework.name": safe(ticket.coursework.name),
        "queue.number": ticket.sequence,
        "ticket.id": ticket.sequence,
        "ta.name": safe(ticket.session!.taName),
        "ta.mention": `<@${ticket.session!.taId}>`,
        "voice.channel": `<#${data.channelId}>`,
      });
      const nonce = BigInt(
        `0x${createHash("sha256").update(id).digest("hex").slice(0, 15)}`,
      ).toString();
      await rest.post(Routes.channelMessages(channelId), {
        body: { ...body, nonce, enforce_nonce: true },
      });
      await db.notificationDelivery.update({
        where: { id },
        data: { status: "SENT", sentAt: new Date(), error: null },
      });
    } catch (error) {
      await db.notificationDelivery.upsert({
        where: { id },
        create: {
          id,
          guildId: ctx.guild.id,
          eventId: event.id,
          channelId: selectedDestination ? channelId : "",
          status: "FAILED",
          error:
            "Arrival notification failed. Check destination permissions, then retry notifications.",
        },
        update: {
          status: "FAILED",
          error:
            "Arrival notification failed. Check destination permissions, then retry notifications.",
        },
      });
      logger.error(
        { err: error, eventId: event.id },
        "Arrival notification failed",
      );
    }
  }
}
