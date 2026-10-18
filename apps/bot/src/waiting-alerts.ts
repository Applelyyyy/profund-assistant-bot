import { createHash, randomUUID } from "node:crypto";
import {
  ChannelType,
  GuildMember,
  PermissionFlagsBits,
  Routes,
  APIMessage,
} from "discord.js";
import { logger } from "../../../packages/config/src/index";
import { db } from "../../../packages/database/src/index";
import {
  ACTIVE,
  DomainError,
  canHandle,
} from "../../../packages/shared/src/index";
import {
  locked,
  event,
  snapshot,
} from "../../../packages/queue-engine/src/index";
import {
  renderWaitingAlert,
  waitingAlertTemplateSchema,
  defaults,
} from "../../../packages/discord-ui/src/index";
import { context, authorizeTA, rest, client } from "./discord";

export async function observeWaitingMember(member: GuildMember) {
  const ctx = await context(member.guild.id);
  const ids = ctx.settings.waitingRoomAlerts.waitingChannelIds.length
    ? ctx.settings.waitingRoomAlerts.waitingChannelIds
    : ctx.channels("waiting_voice");
  const room = member.voice.channelId;
  await locked(member.guild.id, async (tx) => {
    if (
      !room ||
      !ids.includes(room) ||
      !ctx.channels("waiting_voice").includes(room) ||
      !member.roles.cache.has(ctx.settings.studentRole)
    ) {
      await tx.waitingPresence.deleteMany({
        where: { guildId: member.guild.id, discordId: member.id },
      });
      return;
    }
    const old = await tx.waitingPresence.findUnique({
      where: {
        guildId_discordId: { guildId: member.guild.id, discordId: member.id },
      },
    });
    await tx.waitingPresence.upsert({
      where: {
        guildId_discordId: { guildId: member.guild.id, discordId: member.id },
      },
      create: {
        guildId: member.guild.id,
        discordId: member.id,
        voiceChannelId: room,
      },
      update: {
        voiceChannelId: room,
        observedAt: new Date(),
        ...(old?.voiceChannelId !== room ? { joinedAt: new Date() } : {}),
      },
    });
  });
}
export async function checkWaitingAlertPermissions(guildId: string) {
  const ctx = await context(guildId);
  const s = ctx.settings.waitingRoomAlerts;
  const channelId = s.channelId || ctx.channels("queue_alert")[0];
  if (!channelId)
    throw new DomainError(
      "CHANNEL",
      "Select a TA Alert channel or bind Queue Alert first.",
    );
  const channel = await ctx.guild.channels.fetch(channelId);
  const bot = await ctx.guild.members.fetchMe();
  if (
    !channel?.isSendable() ||
    !channel
      .permissionsFor(bot)
      ?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ReadMessageHistory,
      ])
  )
    throw new DomainError(
      "PERMISSIONS",
      "TA alert channel needs View Channel, Send Messages, Embed Links and Read Message History for the bot.",
    );
  for (const id of s.roleIds) {
    const role = await ctx.guild.roles.fetch(id);
    if (
      !role ||
      id === guildId ||
      (!role.mentionable &&
        !channel.permissionsFor(bot)?.has(PermissionFlagsBits.MentionEveryone))
    )
      throw new DomainError(
        "PERMISSIONS",
        "Selected notification roles must exist and be mentionable, or the bot needs Mention Everyone. Everyone/here mentions are never enabled.",
      );
  }
  for (const id of s.waitingChannelIds) {
    const room = await ctx.guild.channels.fetch(id);
    if (
      !ctx.channels("waiting_voice").includes(id) ||
      room?.type !== ChannelType.GuildVoice
    )
      throw new DomainError(
        "CHANNEL",
        "Alert waiting rooms must also be bound as authorized Waiting Voice Channels.",
      );
  }
  return { ctx, channelId };
}
async function alertDocument(guildId: string) {
  const template = await db.embedTemplate.findFirst({
    where: { guildId, feature: "waiting_room_alert" },
    orderBy: { id: "asc" },
  });
  return waitingAlertTemplateSchema.parse(
    template?.document || defaults.waiting_room_alert,
  );
}
export async function sendWaitingTestAlert(guildId: string) {
  const { channelId } = await checkWaitingAlertPermissions(guildId);
  const state = await snapshot(guildId);
  return rest.post(Routes.channelMessages(channelId), {
    body: {
      ...renderWaitingAlert(await alertDocument(guildId), {
        "voice.channel": "ทดสอบการแจ้งเตือน",
        "waiting.incident": "ทดสอบ",
        "waiting.unqueued_count": 0,
        "waiting.status": "ข้อความทดสอบจากผู้ดูแล",
        "queue.active_tas": state.metrics.activeTAs,
        "queue.available_tas": state.metrics.availableTAs,
        "queue.available": state.metrics.available,
        "queue.capacity": state.metrics.capacity,
      }),
      allowed_mentions: { parse: [] },
    },
  });
}
let flight: Promise<void> | undefined;
export function reconcileWaitingAlerts(guildId: string) {
  if (flight) return flight;
  flight = reconcile(guildId).finally(() => {
    flight = undefined;
  });
  return flight;
}
async function reconcile(guildId: string) {
  const ctx = await context(guildId);
  if (ctx.guild.available === false) return;
  // Recover observations from the Gateway snapshot after restart; preserve durable join times.
  const members: GuildMember[] = [];
  for (const voice of ctx.guild.voiceStates.cache.values()) {
    if (
      !voice.channelId ||
      !ctx.channels("waiting_voice").includes(voice.channelId)
    )
      continue;
    const member = await ctx.guild.members.fetch(voice.id);
    members.push(member);
  }
  for (const member of members) await observeWaitingMember(member);
  for (const old of await db.waitingPresence.findMany({ where: { guildId } })) {
    if (members.some((m) => m.id === old.discordId)) continue;
    const member = await ctx.guild.members.fetch(old.discordId).catch((e) => {
      if (e.code === 10007) return null;
      throw e;
    });
    if (member) await observeWaitingMember(member);
    else
      await db.waitingPresence.deleteMany({
        where: { guildId, discordId: old.discordId },
      });
  }
  const inspectors: {
    taId: string;
    roleIds: string[];
    voiceChannelId: string;
  }[] = [];
  for (const voice of ctx.guild.voiceStates.cache.values()) {
    if (!voice.channelId || !ctx.channels("ta_voice").includes(voice.channelId))
      continue;
    const member = await ctx.guild.members.fetch(voice.id);
    if (!member.roles.cache.has(ctx.settings.taRole)) continue;
    try {
      const ta = await authorizeTA(guildId, member.id, true);
      inspectors.push({
        taId: member.id,
        voiceChannelId: ta.room.id,
        roleIds: [...member.roles.cache.keys()],
      });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
    }
  }
  const observations = await locked(guildId, async (tx, current) => {
    const config = current.waitingRoomAlerts;
    const now = new Date();
    const sessions = await tx.tASession.findMany({
      where: { guildId, status: { not: "COMPLETED" } },
    });
    const tickets = await tx.queueTicket.findMany({
      where: { guildId, status: { in: [...ACTIVE] } },
      include: { student: true },
    });
    const courses = await tx.coursework.findMany({
      where: {
        guildId,
        enabled: true,
        archived: false,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
        ],
      },
    });
    const accepting = sessions.filter(
      (session) =>
        session.status === "ACCEPTING" &&
        session.present &&
        !session.paused &&
        inspectors.some(
          (p) =>
            p.taId === session.taId &&
            p.voiceChannelId === session.voiceChannelId,
        ) &&
        courses.some((c) => canHandle(c, session, c.id)),
    );
    const capacity = accepting.reduce((n, session) => n + session.capacity, 0);
    const available = Math.max(
      0,
      capacity -
        tickets.filter((t) =>
          [
            "QUEUED",
            "CLAIMED",
            "MOVING",
            "MOVE_FAILED",
            "NEEDS_REVIEW",
          ].includes(t.status),
        ).length,
    );
    const ready = inspectors.filter((p) => {
      const session = sessions.find((x) => x.taId === p.taId);
      return (
        !session?.paused &&
        tickets.filter(
          (t) =>
            t.sessionId === session?.id &&
            ["CLAIMED", "MOVING", "IN_PROGRESS"].includes(t.status),
        ).length < current.inspectionConcurrency &&
        courses.some((c) =>
          canHandle(
            c,
            { ...p, courseworkIds: session?.courseworkIds || [] },
            c.id,
          ),
        )
      );
    }).length;
    const conditions = [
      ...(config.noAccepting ? [!accepting.length] : []),
      ...(config.noAvailable ? [!ready] : []),
    ];
    const unavailable =
      config.enabled &&
      ((conditions.length > 0 &&
        (config.triggerMode === "ALL"
          ? conditions.every(Boolean)
          : conditions.some(Boolean))) ||
        (config.queueFull && !available && accepting.length > 0));
    const presence = await tx.waitingPresence.findMany({ where: { guildId } });
    const candidates = unavailable
      ? presence.filter(
          (p) =>
            members.some(
              (m) =>
                m.id === p.discordId &&
                m.voice.channelId === p.voiceChannelId &&
                m.roles.cache.has(current.studentRole),
            ) && !tickets.some((t) => t.student.discordId === p.discordId),
        )
      : [];
    const groups = new Map<string, typeof candidates>();
    for (const p of candidates) {
      const scope = config.group ? "all" : p.discordId;
      groups.set(scope, [...(groups.get(scope) || []), p]);
    }
    const alerts = await tx.waitingRoomAlert.findMany({ where: { guildId } });
    for (const row of alerts)
      if (
        !row.resolvedAt &&
        !groups.has(row.scope) &&
        (config.autoResolve || !config.enabled)
      ) {
        await tx.waitingRoomAlert.update({
          where: { guildId_scope: { guildId, scope: row.scope } },
          data: { resolvedAt: now },
        });
        await event(
          tx,
          guildId,
          "system",
          "waiting_alert.resolved",
          "Waiting-room availability incident resolved.",
          { scope: config.group ? "all" : "individual" },
        );
      }
    for (const [scope] of groups) {
      const old = alerts.find((a) => a.scope === scope);
      if (!old || old.resolvedAt) {
        await tx.waitingRoomAlert.upsert({
          where: { guildId_scope: { guildId, scope } },
          create: { guildId, scope },
          update: {
            startedAt: now,
            resolvedAt: null,
            notifiedAt: null,
            mentionAttempted: false,
            messageId: null,
            channelId: null,
            fingerprint: null,
            generation: { increment: 1 },
            leaseToken: null,
            leaseUntil: null,
            lastError: null,
          },
        });
        await event(
          tx,
          guildId,
          "system",
          "waiting_alert.opened",
          "Student waiting without a ticket while TA availability is unavailable.",
        );
      }
    }
    return {
      groups,
      accepting: accepting.length,
      ready,
      capacity,
      available,
      config,
    };
  });
  const doc = await alertDocument(guildId);
  if (!doc.notificationEnabled) return;
  for (const row of await db.waitingRoomAlert.findMany({
    where: { guildId },
  })) {
    const group = observations.groups.get(row.scope) || [];
    const resolved = !!row.resolvedAt;
    if (resolved && !row.messageId) continue;
    if (
      !resolved &&
      (!group.length ||
        Date.now() - row.startedAt.getTime() <
          observations.config.graceSeconds * 1000 ||
        !group.some(
          (p) =>
            Date.now() - p.joinedAt.getTime() >=
            observations.config.graceSeconds * 1000,
        ))
    )
      continue;
    if (
      !resolved &&
      !row.notifiedAt &&
      row.lastNotifiedAt &&
      Date.now() - row.lastNotifiedAt.getTime() <
        observations.config.cooldownSeconds * 1000
    )
      continue;
    const reference = createHash("sha256")
      .update(`${guildId}:${row.scope}:${row.generation}`)
      .digest("hex")
      .slice(0, 12);
    const payload = renderWaitingAlert(doc, {
      "waiting.incident": reference,
      "voice.channel":
        [...new Set(group.map((p) => `<#${p.voiceChannelId}>`))].join(" · ") ||
        "—",
      "waiting.unqueued_count": group.length,
      "waiting.status": resolved
        ? "สิ้นสุดการแจ้งเตือน"
        : !observations.accepting
          ? "ยังไม่มีผู้ช่วยสอนเปิดรับคิว"
          : !observations.ready
            ? "ยังไม่มีผู้ตรวจที่พร้อม"
            : "คิวเต็ม",
      "queue.active_tas": resolved ? 0 : observations.accepting,
      "queue.available_tas": resolved ? 0 : observations.ready,
      "queue.available": resolved ? 0 : observations.available,
      "queue.capacity": resolved ? 0 : observations.capacity,
    });
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex");
    if (row.fingerprint === fingerprint) continue;
    const token = randomUUID();
    const claimed = await locked(guildId, (tx) =>
      tx.waitingRoomAlert.updateMany({
        where: {
          guildId,
          scope: row.scope,
          generation: row.generation,
          OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
        },
        data: { leaseToken: token, leaseUntil: new Date(Date.now() + 90000) },
      }),
    );
    if (!claimed.count) continue;
    try {
      const { channelId } = await checkWaitingAlertPermissions(guildId);
      const live = await db.waitingRoomAlert.findUniqueOrThrow({
        where: { guildId_scope: { guildId, scope: row.scope } },
      });
      const activeTickets = await db.queueTicket.findMany({
        where: { guildId, status: { in: [...ACTIVE] } },
        select: { student: { select: { discordId: true } } },
      });
      if (
        live.generation !== row.generation ||
        !!live.resolvedAt !== resolved ||
        (!resolved &&
          group.some(
            (p) =>
              activeTickets.some((t) => t.student.discordId === p.discordId) ||
              !members.some(
                (m) =>
                  m.id === p.discordId &&
                  m.voice.channelId === p.voiceChannelId,
              ),
          ))
      ) {
        await db.waitingRoomAlert.updateMany({
          where: { guildId, scope: row.scope, leaseToken: token },
          data: { leaseToken: null, leaseUntil: null },
        });
        continue;
      }
      const target = row.channelId || channelId;
      const nonce = BigInt(
        `0x${createHash("sha256").update(`${guildId}:${row.scope}:${row.generation}`).digest("hex").slice(0, 15)}`,
      ).toString();
      let messageId = row.messageId;
      if (!messageId && row.mentionAttempted) {
        let before: string | undefined;
        for (let page = 0; page < 20; page++) {
          const recent = (await rest.get(Routes.channelMessages(target), {
            query: new URLSearchParams({
              limit: "100",
              ...(before ? { before } : {}),
            }),
          })) as APIMessage[];
          messageId =
            recent.find(
              (m) =>
                m.nonce === nonce ||
                (m.author?.id === client.user?.id &&
                  JSON.stringify(m).includes(`อ้างอิง ${reference}`)),
            )?.id || null;
          if (
            messageId ||
            recent.length < 100 ||
            new Date(recent[recent.length - 1].timestamp) <= row.startedAt
          )
            break;
          before = recent[recent.length - 1].id;
          if (page === 19)
            throw new DomainError(
              "ALERT_REVIEW",
              "Alert history exceeds safe recovery limits. Review the incident before retrying; no replacement was sent.",
            );
        }
      }
      let mention = false;
      if (!messageId && !resolved) {
        const reserved = await locked(guildId, (tx) =>
          tx.waitingRoomAlert.updateMany({
            where: {
              guildId,
              scope: row.scope,
              leaseToken: token,
              mentionAttempted: false,
            },
            data: { mentionAttempted: true },
          }),
        );
        mention = !!reserved.count;
      }
      const body = {
        ...payload,
        content: observations.config.roleIds.map((r) => `<@&${r}>`).join(" "),
        allowed_mentions: {
          parse: [],
          roles: mention ? observations.config.roleIds : [],
        },
        nonce,
        enforce_nonce: true,
      };
      if (messageId) {
        try {
          await rest.patch(Routes.channelMessage(target, messageId), { body });
        } catch (error) {
          if ((error as { code?: number }).code !== 10008) throw error;
          await locked(guildId, (tx) =>
            tx.waitingRoomAlert.updateMany({
              where: { guildId, scope: row.scope, leaseToken: token },
              data: {
                messageId: null,
                fingerprint: null,
                generation: { increment: 1 },
                leaseToken: null,
                leaseUntil: null,
                lastError: null,
              },
            }),
          );
          continue;
        }
      } else {
        const sent = (await rest.post(Routes.channelMessages(target), {
          body,
        })) as APIMessage;
        messageId = sent.id;
      }
      await locked(guildId, async (tx) => {
        await tx.waitingRoomAlert.updateMany({
          where: { guildId, scope: row.scope, leaseToken: token },
          data: {
            messageId,
            channelId: target,
            fingerprint,
            leaseToken: null,
            leaseUntil: null,
            lastError: null,
            ...(row.notifiedAt
              ? {}
              : { notifiedAt: new Date(), lastNotifiedAt: new Date() }),
          },
        });
        await event(
          tx,
          guildId,
          "system",
          resolved ? "waiting_alert.message_resolved" : "waiting_alert.sent",
          resolved
            ? "Waiting alert marked resolved."
            : "Waiting alert published or updated without repeated role mentions.",
          { count: group.length, channelId: target },
        );
      });
    } catch (error) {
      logger.warn({ err: error, guildId }, "Waiting alert delivery deferred");
      const message =
        error instanceof DomainError
          ? error.message
          : "Waiting alert delivery failed. Check the channel permissions and retry.";
      await locked(guildId, async (tx) => {
        await tx.waitingRoomAlert.updateMany({
          where: { guildId, scope: row.scope, leaseToken: token },
          data: {
            lastError: message,
            leaseToken: null,
            leaseUntil: new Date(Date.now() + 60000),
          },
        });
        await event(
          tx,
          guildId,
          "system",
          "waiting_alert.failed",
          message,
          {},
          "error",
        );
      });
    }
  }
}
