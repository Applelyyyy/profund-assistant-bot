import {
  refreshForEvents,
  panelScopes,
} from "../../../packages/shared/src/live-updates";
import {
  measure,
  stopPerformanceMonitor,
} from "../../../packages/config/src/performance";
import { processCompletion, notifyNoShow } from "./completion";
import {
  reconcileWaitingAlerts,
  observeWaitingMember,
  checkWaitingAlertPermissions,
  sendWaitingTestAlert,
} from "./waiting-alerts";
import { syncChannelVisibility } from "./permissions";
import { discordText } from "../../../packages/discord-ui/src/index";
import { Worker } from "bullmq";
import Redis from "ioredis";
import { AuditLogEvent, Events, Routes } from "discord.js";
import { env, logger } from "../../../packages/config/src/index";
import { db } from "../../../packages/database/src/index";
import {
  ACTIVE,
  DomainError,
  canHandle,
} from "../../../packages/shared/src/index";
import {
  locked,
  event,
  integrity,
  setPresence,
  cancelTicket,
} from "../../../packages/queue-engine/src/index";
import {
  client,
  rest,
  context,
  cleanupMute,
  cleanupSupportTicket,
  waitingMute,
  processTransfer,
  syncPanels,
  reconcilePresence,
  reconcileStudentVoice,
  syncIdentity,
  createSupportChannel,
  supportAction,
  validateChannels,
  requireStaff,
} from "./discord";
import "./interactions";
import { notifyEvents } from "./notifications";
import { PanelSyncScheduler } from "./panel-sync";
import { applyAccess } from "./permissions";
import type { AccessChange } from "../../../packages/config/src/access";
import { createHash } from "node:crypto";
const connection = new Redis(env().REDIS_URL, { maxRetriesPerRequest: null });
connection.on("error", (e) =>
  logger.warn(
    { message: e.message },
    "Redis connection unavailable; database polling continues",
  ),
);
let stopping = false,
  busy = false,
  lastNotifications = 0,
  lastPresence = 0;
const panels = new PanelSyncScheduler(syncPanels);
async function runOperation(id: string) {
  const op = await db.serviceOperation.findUniqueOrThrow({ where: { id } });
  const claimed = await db.serviceOperation.updateMany({
    where: {
      id,
      status: { in: ["PENDING", "RUNNING"] },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
    },
    data: {
      status: "RUNNING",
      leaseUntil: new Date(Date.now() + 120000),
      attempts: { increment: 1 },
    },
  });
  if (!claimed.count) return;
  try {
    const data = op.data as Record<string, string>;
    const ctx = await context(op.guildId);
    if (["waiting_alert_check", "waiting_alert_test"].includes(op.action)) {
      const admin = await db.adminUser.findUnique({
        where: { id: op.actorId },
      });
      if (!admin || admin.disabled || !["ADMIN", "OWNER"].includes(admin.role))
        throw new DomainError(
          "ADMIN",
          "Active administrator permission is required.",
          403,
        );
    }
    if (
      [
        "refresh_panels",
        "restart_sync",
        "reload_configuration",
        "rebuild_read_models",
      ].includes(op.action)
    ) {
      await syncPanels(true);
    } else if (op.action === "sync_visibility") {
      await syncChannelVisibility(op.guildId, true);
    } else if (op.action === "retire_panel") {
      const panel = await db.publishedPanel.findFirst({
        where: { id: data.panelId, guildId: op.guildId, active: false },
      });
      if (panel?.messageId) {
        await rest
          .delete(Routes.channelMessage(panel.channelId, panel.messageId))
          .catch((e) => {
            if (e.code !== 10008 && e.code !== 10003) throw e;
          });
        await db.publishedPanel.update({
          where: { id: panel.id },
          data: {
            messageId: null,
            fingerprint: null,
            generation: { increment: 1 },
          },
        });
      }
    } else if (op.action === "sync_permissions") {
      const admin = await db.adminUser.findUnique({
        where: { id: op.actorId },
      });
      if (!admin || admin.disabled || !["OWNER", "ADMIN"].includes(admin.role))
        throw new DomainError(
          "ADMIN",
          "Active administrator permission is required.",
          403,
        );
      await applyAccess(
        op.guildId,
        (op.data as unknown as { changes: AccessChange[] }).changes,
      );
      await syncPanels(true);
    } else if (["reconcile_transfers", "retry_moves"].includes(op.action)) {
      for (const t of await db.voiceTransferOperation.findMany({
        where: {
          ticket: { guildId: op.guildId },
          state: { in: ["PENDING", "MOVING", "FAILED", "NEEDS_REVIEW"] },
        },
      })) {
        await db.voiceTransferOperation.updateMany({
          where: {
            id: t.id,
            OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
          },
          data: { nextAttemptAt: new Date() },
        });
        await processTransfer(t.id);
      }
      for (const completion of await db.inspectionCompletion.findMany({
        where: {
          ticket: { guildId: op.guildId },
          state: { in: ["PENDING", "DISCONNECTING", "NEEDS_REVIEW"] },
        },
      })) {
        const reset = await db.inspectionCompletion.updateMany({
          where: {
            ticketId: completion.ticketId,
            state: { not: "SUCCEEDED" },
            OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
          },
          data: { state: "PENDING", attempts: 0, nextAttemptAt: new Date() },
        });
        if (reset.count) await processCompletion(completion.ticketId);
      }
    } else if (op.action === "reconcile_sessions") await reconcilePresence();
    else if (op.action === "retry_notifications") {
      await db.notificationDelivery.updateMany({
        where: { guildId: op.guildId, status: "FAILED" },
        data: { status: "PENDING", error: null },
      });
      await notifyEvents();
    } else if (op.action === "waiting_alert_check")
      await checkWaitingAlertPermissions(op.guildId);
    else if (op.action === "waiting_alert_test")
      await sendWaitingTestAlert(op.guildId);
    else if (op.action === "validate_channels") await validateChannels();
    else if (op.action === "check_no_show") {
      const ticket = await db.queueTicket.findFirst({
        where: {
          id: data.ticketId,
          guildId: op.guildId,
          status: { in: ["QUEUED", "MOVE_FAILED"] },
        },
        include: { student: true },
      });
      if (ticket) {
        const member = await ctx.guild.members
          .fetch(ticket.student.discordId!)
          .catch((e) => {
            if (e.code === 10007) return null;
            throw e;
          });
        if (!member?.voice.channelId)
          await cancelTicket(op.guildId, "system", op.id, ticket.id, true);
      }
    } else if (op.action === "sync_identity")
      await syncIdentity(data.studentId);
    else if (op.action === "create_support")
      await createSupportChannel(data.ticketId);
    else if (op.action === "support_action") {
      const admin = await db.adminUser.findUnique({
        where: { id: op.actorId },
      });
      if (
        !admin ||
        admin.disabled ||
        !["OWNER", "ADMIN", "OPERATOR"].includes(admin.role)
      )
        requireStaff(await ctx.guild.members.fetch(op.actorId), ctx.settings);
      await supportAction(
        op.guildId,
        op.actorId,
        data.ticketId,
        data.action,
        data.note || "",
        data.assignedId,
      );
    } else if (
      op.action === "return_student" ||
      op.action === "post_inspection_move"
    ) {
      const ticket = await db.queueTicket.findFirstOrThrow({
        where: {
          id: data.ticketId,
          guildId: op.guildId,
          status: op.action === "return_student" ? "IN_PROGRESS" : "COMPLETED",
        },
        include: { student: true, session: true },
      });
      if (
        op.action === "return_student" &&
        (await db.inspectionCompletion.findUnique({
          where: { ticketId: ticket.id },
        }))
      )
        throw new DomainError(
          "COMPLETION_PENDING",
          "An explicit inspection decision is pending; return skipped.",
        );
      if (ticket.session!.taId !== op.actorId)
        throw new DomainError(
          "OWNER",
          "Only the assigned TA may move this student.",
        );
      const member = await ctx.guild.members.fetch(ticket.student.discordId!);
      const target = ctx.channels(
        op.action === "return_student" ? "waiting_voice" : "post_inspection",
      )[0];
      if (!target)
        throw new DomainError(
          "CHANNEL",
          "Configure the destination voice channel first.",
        );
      if (member.voice.channelId !== target) {
        if (member.voice.channelId !== ticket.session!.voiceChannelId)
          throw new DomainError(
            "VOICE",
            "Student has left the TA room. Move skipped.",
          );
        await member.voice.setChannel(target, "Inspection voice destination");
      }
      if (member.voice.channelId !== target)
        throw new DomainError(
          "VERIFY",
          "Voice destination is not yet verified. Retry the operation.",
        );
    } else if (op.action === "reconnect_gateway") {
      stopPerformanceMonitor();
      await client.destroy();
      await client.login(env().DISCORD_BOT_TOKEN);
    } else if (op.action === "integrity_check") await integrity(op.guildId);
    else if (op.action === "abandoned_alert") {
      const incident = await db.queueIncident.findUnique({
        where: { guildId: op.guildId },
      });
      if (incident && !incident.resolvedAt) {
        const unresolved = await db.queueTicket.findMany({
          where: { guildId: op.guildId, status: { in: [...ACTIVE] } },
          include: { session: true, coursework: true },
        });
        const present = await db.tASession.findMany({
          where: {
            guildId: op.guildId,
            status: { not: "COMPLETED" },
            present: true,
          },
        });
        const availablePresence = await db.tAPresence.findMany({
          where: {
            guildId: op.guildId,
            observedAt: { gt: new Date(Date.now() - 120000) },
          },
        });
        if (
          unresolved.length &&
          !availablePresence.some(
            (p) =>
              ctx.channels("ta_voice").includes(p.voiceChannelId) &&
              p.roleIds.includes(ctx.settings.taRole) &&
              unresolved.some((t) =>
                canHandle(
                  t.coursework,
                  {
                    ...p,
                    courseworkIds:
                      present.find((s) => s.taId === p.taId)?.courseworkIds ||
                      [],
                  },
                  t.courseworkId,
                ),
              ),
          ) &&
          !present.some((s) =>
            unresolved.some((t) => canHandle(t.coursework, s, t.courseworkId)),
          )
        ) {
          for (const channelId of new Set(ctx.channels("queue_alert"))) {
            const channel = await ctx.guild.channels.fetch(channelId);
            if (channel?.isSendable())
              await channel.send({
                content: `${ctx.settings.alertText}\n${discordText("incidentDetails", { count: unresolved.length, sessions: new Set(unresolved.map((t) => t.sessionId).filter(Boolean)).size, seconds: Math.floor((Date.now() - incident.startedAt.getTime()) / 1000) })}`,
                allowedMentions: { parse: [] },
                nonce: BigInt(
                  `0x${createHash("sha256").update(`${op.id}:${channelId}`).digest("hex").slice(0, 15)}`,
                ).toString(),
                enforceNonce: true,
              });
          }
        }
      }
    } else throw new DomainError("OPERATION", "Unsupported bot operation.");
    await db.serviceOperation.update({
      where: { id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        leaseUntil: null,
        error: null,
      },
    });
    await locked(op.guildId, (tx) =>
      event(
        tx,
        op.guildId,
        op.actorId,
        "operation.completed",
        `${op.action} completed.`,
        { operationId: id },
      ),
    );
  } catch (error) {
    const message =
      error instanceof DomainError
        ? error.message
        : "Discord operation failed. Check permissions and retry from System Operations.";
    await db.serviceOperation.update({
      where: { id },
      data: { status: "FAILED", leaseUntil: null, error: message },
    });
    await locked(op.guildId, (tx) =>
      event(
        tx,
        op.guildId,
        op.actorId,
        "operation.failed",
        message,
        { operationId: id },
        "error",
      ),
    );
    logger.error({ err: error, operationId: id }, "Service operation failed");
  }
}
let criticalBusy = false;
async function criticalTick() {
  if (stopping || criticalBusy || !client.isReady()) return;
  criticalBusy = true;
  try {
    await measure("bot.queue_tick", async () => {
      await db.serviceHeartbeat.upsert({
        where: { service: "bot" },
        create: {
          service: "bot",
          status: "online",
          detail: "Discord Gateway connected",
        },
        update: { status: "online", detail: "Discord Gateway connected" },
      });
      for (const completion of await db.inspectionCompletion.findMany({
        where: {
          ticket: { guildId: env().DISCORD_GUILD_ID },
          state: { in: ["PENDING", "DISCONNECTING"] },
          nextAttemptAt: { lte: new Date() },
          OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
        },
        take: 10,
      }))
        if (!stopping)
          await processCompletion(completion.ticketId).catch((error) =>
            logger.warn(
              { err: error, ticketId: completion.ticketId },
              "Completion recovery deferred",
            ),
          );
      const transfers = await db.voiceTransferOperation.findMany({
        where: {
          ticket: { guildId: env().DISCORD_GUILD_ID },
          state: { in: ["PENDING", "MOVING", "FAILED"] },
          nextAttemptAt: { lte: new Date() },
          OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
        },
        orderBy: { createdAt: "asc" },
        take: 10,
      });
      for (const transfer of transfers)
        if (!stopping) await processTransfer(transfer.id);
    });
  } catch (error) {
    logger.error({ err: error }, "Critical queue reconciliation failed");
  } finally {
    criticalBusy = false;
  }
}
let lastPanelEvent: number | undefined;
async function tick() {
  return measure("bot.maintenance_tick", runMaintenance);
}
async function runMaintenance() {
  if (stopping || busy || !client.isReady()) return;
  busy = true;
  try {
    const ops = await db.serviceOperation.findMany({
      where: {
        guildId: env().DISCORD_GUILD_ID,
        action: { notIn: ["restart_bot", "restart_worker", "backup"] },
        status: { in: ["PENDING", "RUNNING"] },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
      },
      orderBy: { createdAt: "asc" },
      take: 10,
    });
    for (const op of ops) if (!stopping) await runOperation(op.id);
    await reconcileWaitingAlerts(env().DISCORD_GUILD_ID).catch((err) =>
      logger.warn(
        { err },
        "Waiting alert reconciliation deferred; queue processing continues",
      ),
    );
    for (const notice of await db.inspectionCompletion.findMany({
      where: {
        ticket: { guildId: env().DISCORD_GUILD_ID },
        state: "SUCCEEDED",
        outcome: "NO_SHOW",
        notificationState: { in: ["PENDING", "SENDING"] },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
      },
      take: 10,
    }))
      await notifyNoShow(notice.ticketId);
    const roomChecks = await db.tARoomPanel.findMany({
      where: {
        guildId: env().DISCORD_GUILD_ID,
        enabled: true,
        publishedPanel: { active: true },
      },
      select: {
        refreshSeconds: true,
        publishedPanel: { select: { checkedAt: true } },
      },
    });
    if (
      roomChecks.some(
        (room) =>
          !room.publishedPanel?.checkedAt ||
          Date.now() - room.publishedPanel.checkedAt.getTime() >=
            room.refreshSeconds * 1000,
      )
    )
      panels.request(Date.now(), 0, ["queue"]);
    if (Date.now() - lastPresence > 30000) {
      await syncChannelVisibility(env().DISCORD_GUILD_ID, false, true);
      await reconcilePresence();
      lastPresence = Date.now();
    }
    for (const legacy of await db.supportTicket.findMany({
      where: {
        guildId: env().DISCORD_GUILD_ID,
        status: "CLOSED",
        channelDeletedAt: null,
        channelId: { not: null },
      },
      take: 10,
    }))
      if (!stopping) await cleanupSupportTicket(legacy.id);
    for (const ticket of await db.supportTicket.findMany({
      where: {
        guildId: env().DISCORD_GUILD_ID,
        status: "CLOSING",
        AND: [
          {
            OR: [
              { cleanupAttempts: { lt: 5 } },
              {
                cleanupLeaseToken: { not: null },
                cleanupLeaseUntil: { lt: new Date() },
              },
            ],
          },
        ],
        OR: [
          { cleanupNextAttemptAt: null },
          { cleanupNextAttemptAt: { lte: new Date() } },
        ],
      },
      take: 10,
      orderBy: { createdAt: "asc" },
    }))
      if (!stopping) await cleanupSupportTicket(ticket.id);
    const ctx = await context(env().DISCORD_GUILD_ID);
    let scopes: ReturnType<typeof refreshForEvents>["panels"] = null;
    if (lastPanelEvent === undefined)
      lastPanelEvent =
        (
          await db.systemEvent.findFirst({
            where: { guildId: ctx.guild.id },
            orderBy: { id: "desc" },
            select: { id: true },
          })
        )?.id || 0;
    else {
      const events = await db.systemEvent.findMany({
        where: { guildId: ctx.guild.id, id: { gt: lastPanelEvent } },
        orderBy: { id: "asc" },
        take: 1000,
        select: { id: true, type: true },
      });
      if (events.length) {
        lastPanelEvent = events.at(-1)!.id;
        scopes = refreshForEvents(events.map((e) => e.type)).panels;
      }
    }
    await panels.tick(ctx.settings, lastPanelEvent, Date.now(), scopes);
    if (Date.now() - lastNotifications > 5000) {
      await notifyEvents();
      lastNotifications = Date.now();
    }
  } catch (error) {
    logger.error({ err: error }, "Bot reconciliation failed");
  } finally {
    busy = false;
  }
}
const worker = new Worker(
  "discord-sync",
  async (job) => {
    const ctx = await context(env().DISCORD_GUILD_ID);
    const requested = job.data.panels;
    const scopes =
      Array.isArray(requested) &&
      requested.every((p) => panelScopes.includes(p))
        ? requested
        : undefined;
    panels.request(Date.now(), ctx.settings.embedUpdateDebounceMs, scopes);
    await criticalTick();
    await tick();
  },
  {
    connection,
    concurrency: 1,
  },
);
worker.on("error", (e) =>
  logger.error({ err: e }, "Discord job worker failed"),
);
client.once(Events.ClientReady, async () => {
  logger.info({ userId: client.user?.id }, "Discord Gateway connected");
  await reconcilePresence();
  await syncPanels(true);
});
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  if (newState.guild.id !== env().DISCORD_GUILD_ID) return;
  const observedAt = new Date();
  try {
    const ctx = await context(newState.guild.id);
    const member = newState.member;
    if (!member) return;
    await observeWaitingMember(member);
    await setPresence(ctx.guild.id, member.id, newState.channelId);
    if (
      member.roles.cache.has(ctx.settings.taRole) &&
      oldState.channelId !== newState.channelId
    )
      await reconcilePresence();
    if (
      newState.channelId &&
      ctx.channels("waiting_voice").includes(newState.channelId)
    )
      await waitingMute(member, ctx.settings);
    else if (newState.channelId)
      await cleanupMute(
        member,
        ctx.settings,
        ctx.channels("ta_voice").includes(newState.channelId),
      );
    if (oldState.channelId !== newState.channelId)
      await reconcileStudentVoice(member, observedAt, oldState.channelId);
  } catch (error) {
    logger.error({ err: error }, "Voice state handling failed");
  }
});
client.on(Events.GuildMemberUpdate, async (_old, member) => {
  if (
    _old.roles.cache.size === member.roles.cache.size &&
    _old.roles.cache.every((r) => member.roles.cache.has(r.id))
  )
    return;
  if (member.guild.id === env().DISCORD_GUILD_ID)
    await syncChannelVisibility(member.guild.id).catch((e) =>
      logger.error({ err: e }, "Channel visibility sync failed"),
    );
  if (member.guild.id === env().DISCORD_GUILD_ID)
    await reconcilePresence().catch((e) =>
      logger.error({ err: e }, "Role presence reconciliation failed"),
    );
});
client.on(Events.ChannelDelete, async (channel) => {
  if ("guild" in channel && channel.guild.id === env().DISCORD_GUILD_ID)
    await reconcilePresence().catch((e) =>
      logger.error({ err: e }, "Deleted room reconciliation failed"),
    );
});
client.on(Events.GuildAuditLogEntryCreate, async (entry, guild) => {
  if (
    guild.id !== env().DISCORD_GUILD_ID ||
    entry.action !== AuditLogEvent.MemberUpdate ||
    entry.executorId === client.user?.id ||
    !entry.targetId ||
    !entry.changes.some((c) => c.key === "mute")
  )
    return;
  await db.muteOwnership
    .updateMany({
      where: { guildId: guild.id, discordId: entry.targetId },
      data: { state: "REVIEW" },
    })
    .catch((e) => logger.error({ err: e }, "Mute ownership audit failed"));
});
client.on(Events.Error, (e) =>
  logger.error({ err: e }, "Discord client error"),
);
const timer = setInterval(() => {
  void criticalTick();
  void tick();
}, 2000);
async function shutdown(code = 0) {
  stopping = true;
  clearInterval(timer);
  await worker.close();
  while (busy || criticalBusy) await new Promise((r) => setTimeout(r, 100));
  await db.serviceHeartbeat.upsert({
    where: { service: "bot" },
    create: { service: "bot", status: "offline" },
    update: { status: "offline" },
  });
  await client.destroy();
  await connection.quit();
  await db.$disconnect();
  process.exit(code);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
if (!env().DISCORD_BOT_TOKEN) {
  logger.fatal("DISCORD_BOT_TOKEN is required to start the bot.");
  void shutdown(1);
} else
  client.login(env().DISCORD_BOT_TOKEN).catch((e) => {
    logger.fatal({ err: e }, "Discord login failed");
    process.exit(1);
  });
