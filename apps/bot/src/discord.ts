import {
  Client,
  RESTEvents,
  GatewayIntentBits,
  PermissionFlagsBits,
  ChannelType,
  AuditLogEvent,
  GuildMember,
  REST,
  Routes,
  APIMessage,
  TextChannel,
  VoiceChannel,
  escapeMarkdown,
  MessageFlags,
} from "discord.js";
import { db, Prisma } from "../../../packages/database/src/index";
import { env, logger } from "../../../packages/config/src/index";
import {
  DomainError,
  Settings,
  defaultAccess,
  settingsSchema,
  canHandle,
  ACTIVE,
} from "../../../packages/shared/src/index";
import {
  event,
  locked,
  leaseTransfer,
  finalizeTransfer,
  observeStudentVoice,
  failTransfer,
  fullTicket,
  snapshot,
  setPresence,
} from "../../../packages/queue-engine/src/index";
import {
  render,
  roomPanelTemplateSchema,
  templateSchema,
  scopeRoomActions,
  resolve,
  th,
  discordText,
  discordStatus,
} from "../../../packages/discord-ui/src/index";
import {
  panelAffected,
  type PanelScope,
} from "../../../packages/shared/src/live-updates";
import { performance } from "node:perf_hooks";
import {
  measure,
  incrementCounter,
  recordDuration,
} from "../../../packages/config/src/performance";
import { randomUUID, createHash } from "node:crypto";
import { matchesPanel } from "./panel-recovery";
import {
  queueTop,
  roomCurrent,
  roomCurrentValues,
} from "../../../packages/discord-ui/src/queue-display";
export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildModeration,
    ...(env().DISCORD_MESSAGE_CONTENT_ENABLED === "true"
      ? [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
      : []),
  ],
});
export const rest = new REST({ version: "10" }).setToken(
  env().DISCORD_BOT_TOKEN,
);
for (const transport of [rest, client.rest]) {
  transport.on(RESTEvents.Response, () =>
    incrementCounter("discord.rest_responses"),
  );
  transport.on(RESTEvents.RateLimited, () =>
    incrementCounter("discord.rate_limits"),
  );
}
export async function context(guildId: string) {
  if (guildId !== env().DISCORD_GUILD_ID)
    throw new DomainError("GUILD", "This server is not configured.", 403);
  const [guild, record, bindings] = await Promise.all([
    client.guilds.fetch(guildId),
    db.guild.findUniqueOrThrow({ where: { id: guildId } }),
    db.channelBinding.findMany({ where: { guildId } }),
  ]);
  return {
    guild,
    settings: settingsSchema.parse(record.settings),
    channels: (feature: string) =>
      bindings.find((b) => b.feature === feature)?.channelIds || [],
  };
}
export function requireRole(member: GuildMember, role: string) {
  if (!role || role === member.guild.id || !member.roles.cache.has(role))
    throw new DomainError(
      "ROLE",
      "You do not have the required role. Ask an administrator.",
      403,
    );
}
export function requireStaff(member: GuildMember, s: Settings) {
  if (
    !member.permissions.has(PermissionFlagsBits.Administrator) &&
    ![...s.supportRoles, ...s.adminRoles].some(
      (r) => r !== member.guild.id && member.roles.cache.has(r),
    )
  )
    throw new DomainError(
      "STAFF",
      "Only authorized support staff can use this action.",
      403,
    );
}
export async function authorizeTA(
  guildId: string,
  userId: string,
  allowWithoutSession = false,
) {
  const ctx = await context(guildId);
  const member = await ctx.guild.members.fetch(userId);
  requireRole(member, ctx.settings.taRole);
  const channelId = member.voice.channelId;
  if (!channelId || !ctx.channels("ta_voice").includes(channelId))
    throw new DomainError(
      "VOICE",
      "Join an authorized TA inspection voice room first.",
    );
  const room = await ctx.guild.channels.fetch(channelId);
  const bot = await ctx.guild.members.fetchMe();
  if (
    !room ||
    room.type !== ChannelType.GuildVoice ||
    !room
      .permissionsFor(bot)
      ?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.MoveMembers,
      ])
  )
    throw new DomainError(
      "PERMISSIONS",
      "Bot needs View Channel, Connect, and Move Members in this room.",
    );
  const studentRole = ctx.settings.studentRole
    ? await ctx.guild.roles.fetch(ctx.settings.studentRole)
    : null;
  if (
    !studentRole ||
    room.permissionsFor(studentRole)?.has(PermissionFlagsBits.Connect) ||
    room.permissionsFor(studentRole)?.has(PermissionFlagsBits.ViewChannel) !==
      ctx.settings.studentVoiceVisible
  )
    throw new DomainError(
      "ROOM_SECURITY",
      "Inspection room must match configured student visibility and deny their normal Connect permission.",
    );
  if (!allowWithoutSession) {
    const session = await db.tASession.findFirst({
      where: { guildId, taId: userId, status: { not: "COMPLETED" } },
    });
    if (!session || session.voiceChannelId !== channelId)
      throw new DomainError(
        "SESSION",
        "Return to your assigned voice room or start a session.",
      );
  }
  return { ...ctx, member, room, bot };
}
export async function syncIdentity(studentId: string) {
  const student = await db.student.findUniqueOrThrow({
    where: { id: studentId },
  });
  if (!student.discordId || student.registration === "APPROVAL_PENDING") return;
  const { guild, settings } = await context(student.guildId);
  try {
    const member = await guild.members.fetch(student.discordId);
    const bot = await guild.members.fetchMe();
    const role = await guild.roles.fetch(settings.studentRole);
    if (
      !role ||
      role.id === guild.id ||
      role.managed ||
      role.permissions?.has(PermissionFlagsBits.Administrator) ||
      !bot.permissions.has([
        PermissionFlagsBits.ManageNicknames,
        PermissionFlagsBits.ManageRoles,
      ]) ||
      role.position >= bot.roles.highest.position ||
      !member.manageable
    )
      throw new DomainError(
        "IDENTITY_PERMISSIONS",
        "Bot role must be above the student and Student role, with Manage Roles and Manage Nicknames.",
      );
    const nickname = settings.nicknameTemplate
      .replaceAll("{name}", student.name)
      .replaceAll("{lastname}", student.lastname)
      .replaceAll("{id}", student.studentId);
    await member.setNickname(
      [...nickname].slice(0, 32).join(""),
      "Student verification",
    );
    await member.roles.add(role, "Student verification");
    await (
      await import("./permissions")
    ).syncChannelVisibility(student.guildId);
    await locked(student.guildId, async (tx) => {
      const current = await tx.student.findUniqueOrThrow({
        where: { id: studentId },
      });
      if (current.discordId !== student.discordId)
        throw new DomainError(
          "IDENTITY_CHANGED",
          "Mapping changed during synchronization.",
        );
      await tx.student.update({
        where: { id: studentId },
        data: { registration: "REGISTERED", syncError: null },
      });
      await event(
        tx,
        student.guildId,
        student.discordId!,
        "identity.registered",
        "Student nickname and role synchronized.",
        { studentId },
      );
    });
  } catch (error) {
    const message =
      error instanceof DomainError
        ? error.message
        : "Discord nickname or role synchronization failed. Check permissions and retry.";
    await db.student.update({
      where: { id: studentId },
      data: { registration: "SYNC_FAILED", syncError: message },
    });
    throw new DomainError("IDENTITY_SYNC", message);
  }
}
export async function recoverIdentities(guildId: string, actorId: string) {
  const { guild, settings } = await context(guildId);
  if (!settings.studentRole || settings.studentRole === guild.id)
    throw new DomainError(
      "STUDENT_ROLE",
      "Configure the previously verified Student role before recovering mappings.",
    );
  // A complete fetch is required: partial member caches cannot detect duplicate nicknames.
  const members = await guild.members.fetch();
  const normalize = (value: string) =>
    value.normalize("NFC").trim().replace(/\s+/g, " ");
  const byNickname = new Map<string, string[]>();
  for (const member of members.values()) {
    if (
      member.user.bot ||
      !member.nickname ||
      !member.roles.cache.has(settings.studentRole)
    )
      continue;
    const key = normalize(member.nickname);
    byNickname.set(key, [...(byNickname.get(key) || []), member.id]);
  }
  return locked(guildId, async (tx, currentSettings) => {
    if (
      currentSettings.studentRole !== settings.studentRole ||
      currentSettings.nicknameTemplate !== settings.nicknameTemplate
    )
      throw new DomainError(
        "CONFIGURATION_CHANGED",
        "Student verification settings changed during recovery. Retry the scan.",
      );
    const students = await tx.student.findMany({ where: { guildId } });
    const activeStudents = new Set(
      (
        await tx.queueTicket.findMany({
          where: { guildId, status: { in: [...ACTIVE] } },
          select: { studentId: true },
          distinct: ["studentId"],
        })
      ).map((ticket) => ticket.studentId),
    );
    const linked = new Set(
      students.flatMap((s) => (s.discordId ? [s.discordId] : [])),
    );
    const expected = new Map<string, string[]>();
    for (const student of students) {
      const names = [
        `${student.studentId} ${student.name}`,
        `${student.studentId} ${student.name} ${student.lastname}`,
      ];
      if (
        settings.nicknameTemplate.includes("{id}") &&
        settings.nicknameTemplate.includes("{name}")
      )
        names.push(
          settings.nicknameTemplate
            .replaceAll("{id}", student.studentId)
            .replaceAll("{name}", student.name)
            .replaceAll("{lastname}", student.lastname),
        );
      for (const name of new Set(
        names.map((n) => normalize([...n].slice(0, 32).join(""))),
      )) {
        // Never restore a mapping from a truncated student ID or incomplete first name.
        if (!name.includes(normalize(`${student.studentId} ${student.name}`)))
          continue;
        expected.set(name, [...(expected.get(name) || []), student.id]);
      }
    }
    const proposals = new Map<string, Set<string>>();
    const ambiguous = new Set<string>();
    for (const [nickname, ids] of expected) {
      const discordIds = byNickname.get(nickname);
      if (ids.length > 1 || (discordIds?.length || 0) > 1)
        ids.forEach((id) => ambiguous.add(id));
      if (ids.length !== 1 || discordIds?.length !== 1) continue;
      const choices = proposals.get(ids[0]) || new Set<string>();
      choices.add(discordIds[0]);
      proposals.set(ids[0], choices);
    }
    let recovered = 0;
    for (const student of students) {
      const choices = proposals.get(student.id);
      if (
        student.discordId ||
        ambiguous.has(student.id) ||
        student.registration !== "UNREGISTERED" ||
        choices?.size !== 1
      )
        continue;
      const discordId = [...choices][0];
      if (linked.has(discordId) || activeStudents.has(student.id)) continue;
      await tx.student.update({
        where: { id: student.id },
        data: { discordId, registration: "REGISTERED", syncError: null },
      });
      linked.add(discordId);
      recovered++;
      await event(
        tx,
        guildId,
        actorId,
        "identity.recovered",
        "Existing verified Discord identity recovered from Student role and nickname.",
        { studentId: student.id, discordId },
      );
    }
    const result = { recovered, skipped: students.length - recovered };
    await event(
      tx,
      guildId,
      actorId,
      "identity.recovery_completed",
      "Discord identity recovery completed; unmatched and ambiguous students remain unchanged.",
      result,
    );
    return result;
  });
}

async function recoverPanelMessage(
  guildId: string,
  channelId: string,
  feature: string,
  document: unknown,
  roomId?: string,
) {
  const botId = client.user?.id;
  if (!botId)
    throw new DomainError(
      "BOT_NOT_READY",
      "Wait for the bot to connect before recovering panels.",
    );
  const claimed = new Set(
    (
      await db.publishedPanel.findMany({
        where: { guildId, messageId: { not: null } },
        select: { messageId: true },
      })
    ).map((p) => p.messageId),
  );
  const match = (message: APIMessage) =>
    !claimed.has(message.id) &&
    matchesPanel(message, botId, feature, document, roomId);
  // Pins allow a long-lived panel to be recovered even in a busy channel.
  const pins = (await rest.get(Routes.channelMessagesPins(channelId))) as {
    items?: { message: APIMessage }[];
    has_more?: boolean;
  };
  const pinned = pins.items?.find((item) => match(item.message));
  if (pinned) return pinned.message;
  let before: string | undefined;
  for (let page = 0; page < 10; page++) {
    const query = new URLSearchParams({
      limit: "100",
      ...(before ? { before } : {}),
    });
    const messages = (await rest.get(Routes.channelMessages(channelId), {
      query,
    })) as APIMessage[];
    const found = messages.find(match);
    if (found) return found;
    if (messages.length < 100) {
      if (pins.has_more) break;
      return null;
    }
    before = messages.at(-1)!.id;
  }
  throw new DomainError(
    "PANEL_HISTORY_LIMIT",
    "Panel history is too large to safely publish. Pin the original bot panel and retry.",
  );
}
export async function register(
  guildId: string,
  discordId: string,
  studentId: string,
) {
  await locked(guildId, async (tx) => {
    const key = `verification:${guildId}:${discordId}`;
    const old = await tx.loginAttempt.findUnique({ where: { key } });
    if (old && Date.now() - old.windowAt.getTime() < 900000 && old.count >= 5)
      throw new DomainError(
        "RATE_LIMIT",
        "Too many verification attempts. Try again in 15 minutes.",
        429,
      );
    await tx.loginAttempt.upsert({
      where: { key },
      create: { key, count: 1 },
      update:
        old && Date.now() - old.windowAt.getTime() < 900000
          ? { count: { increment: 1 } }
          : { count: 1, windowAt: new Date() },
    });
  });
  const ctx = await context(guildId);
  const member = await ctx.guild.members.fetch(discordId);
  const bot = await ctx.guild.members.fetchMe();
  if (
    !ctx.settings.studentRole ||
    !bot.permissions.has([
      PermissionFlagsBits.ManageNicknames,
      PermissionFlagsBits.ManageRoles,
    ]) ||
    !member.manageable
  )
    throw new DomainError(
      "PERMISSIONS",
      "Ask an administrator to fix bot nickname and role permissions.",
    );
  const pending = await locked(guildId, async (tx) => {
    const record = await tx.student.findUnique({
      where: { guildId_studentId: { guildId, studentId: studentId.trim() } },
    });
    if (!record)
      throw new DomainError(
        "STUDENT_NOT_FOUND",
        "Student ID not found. Check your ID or ask an administrator.",
      );
    if (record.discordId && record.discordId !== discordId)
      throw new DomainError(
        "LINKED",
        "This student ID belongs to another Discord account. Ask an administrator to remap it.",
      );
    const existing = await tx.student.findUnique({
      where: { guildId_discordId: { guildId, discordId } },
    });
    if (existing && existing.id !== record.id)
      throw new DomainError(
        "LINKED",
        "Your Discord account is already linked to another student ID.",
      );
    if (
      record.registration === "REGISTERED" &&
      member.roles.cache.has(ctx.settings.studentRole)
    )
      return { student: record, operationId: null };
    const updated = await tx.student.update({
      where: { id: record.id },
      data: {
        discordId,
        registration:
          ctx.settings.verificationMode === "ADMIN_APPROVAL" &&
          record.registration !== "REGISTERED"
            ? "APPROVAL_PENDING"
            : "SYNC_PENDING",
        syncError: null,
      },
    });
    await event(
      tx,
      guildId,
      discordId,
      "identity.linked",
      "Student identity linked; Discord synchronization pending.",
      { studentId: record.id },
    );
    const operation =
      updated.registration === "SYNC_PENDING"
        ? await tx.serviceOperation.create({
            data: {
              guildId,
              actorId: discordId,
              action: "sync_identity",
              status: "RUNNING",
              leaseUntil: new Date(Date.now() + 120000),
              attempts: 1,
              data: { studentId: updated.id },
            },
          })
        : null;
    return { student: updated, operationId: operation?.id };
  });
  if (pending.operationId) {
    try {
      await syncIdentity(pending.student.id);
      await db.serviceOperation.update({
        where: { id: pending.operationId },
        data: {
          status: "COMPLETED",
          leaseUntil: null,
          completedAt: new Date(),
        },
      });
    } catch (error) {
      await db.serviceOperation.update({
        where: { id: pending.operationId },
        data: { status: "PENDING", leaseUntil: null },
      });
      throw error;
    }
  }
  return db.student.findUniqueOrThrow({ where: { id: pending.student.id } });
}

export async function cleanupMute(
  member: GuildMember,
  settings: Settings,
  transferred = false,
) {
  const owned = await db.muteOwnership.findUnique({
    where: {
      guildId_discordId: { guildId: member.guild.id, discordId: member.id },
    },
  });
  if (!owned || !["OWNED", "PENDING"].includes(owned.state)) return;
  if (!member.voice.channelId) return;
  if (!member.voice.serverMute) {
    await db.muteOwnership.delete({
      where: {
        guildId_discordId: { guildId: member.guild.id, discordId: member.id },
      },
    });
    return;
  }
  const logs = await member.guild
    .fetchAuditLogs({ type: AuditLogEvent.MemberUpdate, limit: 30 })
    .catch(() => null);
  const latest = logs?.entries.find(
    (e) => e.targetId === member.id && e.changes.some((c) => c.key === "mute"),
  );
  if (
    !latest ||
    latest.executorId !== client.user?.id ||
    latest.createdTimestamp < owned.createdAt.getTime() - 5000
  ) {
    await db.muteOwnership.update({
      where: {
        guildId_discordId: { guildId: member.guild.id, discordId: member.id },
      },
      data: { state: "REVIEW" },
    });
    await locked(member.guild.id, (tx) =>
      event(
        tx,
        member.guild.id,
        "system",
        "mute.review",
        "Mute ownership is ambiguous. Moderator review required.",
        { discordId: member.id },
        "warn",
      ),
    );
    return;
  }
  if (settings.muteCleanup || transferred) {
    await member.voice.setMute(false, "Release queue-owned mute");
    await db.muteOwnership.delete({
      where: {
        guildId_discordId: { guildId: member.guild.id, discordId: member.id },
      },
    });
  }
}
export async function waitingMute(member: GuildMember, settings: Settings) {
  if (
    !settings.autoMute ||
    !settings.studentRole ||
    !member.roles.cache.has(settings.studentRole) ||
    member.voice.serverMute
  )
    return;
  await db.muteOwnership.upsert({
    where: {
      guildId_discordId: { guildId: member.guild.id, discordId: member.id },
    },
    create: {
      guildId: member.guild.id,
      discordId: member.id,
      state: "PENDING",
    },
    update: { state: "PENDING", createdAt: new Date() },
  });
  try {
    await member.voice.setMute(true, "Waiting queue automatic mute");
    await db.muteOwnership.update({
      where: {
        guildId_discordId: { guildId: member.guild.id, discordId: member.id },
      },
      data: { state: "OWNED" },
    });
  } catch (error) {
    await db.muteOwnership.deleteMany({
      where: {
        guildId: member.guild.id,
        discordId: member.id,
        state: "PENDING",
      },
    });
    throw error;
  }
}
async function notifyRoom(room: VoiceChannel, text: string, key: string) {
  if (
    !room
      .permissionsFor(await room.guild.members.fetchMe())
      ?.has(PermissionFlagsBits.SendMessages)
  )
    return;
  await room.send({
    content: text.slice(0, 1900),
    allowedMentions: { parse: [] },
    nonce: BigInt(
      `0x${createHash("sha256").update(key).digest("hex").slice(0, 15)}`,
    ).toString(),
    enforceNonce: true,
  });
}
export function processTransfer(id: string) {
  return measure("discord.voice_transfer", () => runTransfer(id));
}
async function runTransfer(id: string) {
  if (client.guilds.cache.get(env().DISCORD_GUILD_ID)?.available === false)
    return;
  const op = await leaseTransfer(id);
  if (!op) return;
  let attempted = false,
    finalized = false;
  const values = {
    "student.name": `${op.ticket.student.name} ${op.ticket.student.lastname}`,
    "ticket.id": op.ticket.sequence,
    "coursework.name": op.ticket.coursework.name,
  };
  try {
    const lookupStart = performance.now();
    const ctx = await context(op.ticket.guildId);
    const session = await db.tASession.findUniqueOrThrow({
      where: { id: op.ticket.sessionId! },
    });
    const member = await ctx.guild.members.fetch(op.ticket.student.discordId!);
    // Reconcile observed destination before retrying any API call, even when the TA has since left.
    if (member.voice.channelId === op.targetChannelId) {
      await finalizeTransfer(op.id, op.leaseToken, op.targetChannelId);
      finalized = true;
      await cleanupMute(member, ctx.settings, true);
      return;
    }
    const ta = await ctx.guild.members.fetch(session.taId);
    requireRole(ta, ctx.settings.taRole);
    if (
      !ctx.channels("ta_voice").includes(op.targetChannelId) ||
      !canHandle(
        op.ticket.coursework,
        { ...session, roleIds: [...ta.roles.cache.keys()] },
        op.ticket.courseworkId,
      ) ||
      session.voiceChannelId !== op.targetChannelId ||
      ta.voice.channelId !== op.targetChannelId ||
      session.paused
    )
      throw new DomainError(
        "TA_UNAVAILABLE",
        "TA is unavailable. Return the TA to the assigned room, then retry.",
      );
    if (
      !member.voice.channelId ||
      !ctx.channels("waiting_voice").includes(member.voice.channelId)
    )
      throw new DomainError(
        "STUDENT_UNAVAILABLE",
        "Student is not in an authorized waiting voice room.",
      );
    const room = await ctx.guild.channels.fetch(op.targetChannelId);
    const bot = await ctx.guild.members.fetchMe();
    if (
      !room ||
      room.type !== ChannelType.GuildVoice ||
      !member.voice.channel
        ?.permissionsFor(bot)
        ?.has(PermissionFlagsBits.MoveMembers) ||
      !room
        .permissionsFor(bot)
        ?.has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.MoveMembers,
        ])
    )
      throw new DomainError(
        "MOVE_PERMISSIONS",
        "Bot lacks voice move permissions or the destination room is missing.",
      );
    if (
      !room
        .permissionsFor(member)
        ?.has([PermissionFlagsBits.Speak, PermissionFlagsBits.UseVAD])
    )
      throw new DomainError(
        "SPEECH_PERMISSIONS",
        "Student needs Speak and Use Voice Activity in this TA room. Sync Roles & Access or review individual moderation restrictions before retrying.",
      );
    const current = await db.voiceTransferOperation.findUniqueOrThrow({
      where: { id },
    });
    if (
      current.leaseToken !== op.leaseToken ||
      !current.leaseUntil ||
      current.leaseUntil.getTime() < Date.now() + 15000
    )
      throw new DomainError(
        "LEASE",
        "Transfer lease expired. Reconcile before retry.",
      );
    if (
      ctx.settings.notifications &&
      ctx.settings.routineAnnouncements &&
      op.attempts === 0
    )
      await notifyRoom(
        room,
        resolve(ctx.settings.calledText, values),
        `${id}:called`,
      );
    if (ta.voice.channelId !== op.targetChannelId)
      throw new DomainError("TA_LEFT", "TA left the room before transfer.");
    if (
      !member.voice.channelId ||
      !ctx.channels("waiting_voice").includes(member.voice.channelId)
    )
      throw new DomainError(
        "STUDENT_UNAVAILABLE",
        "Student left the waiting room before transfer.",
      );
    recordDuration("discord.voice_lookup", performance.now() - lookupStart);
    attempted = true;
    await measure("discord.voice_move_request", () =>
      member.voice.setChannel(room, `Queue ticket #${op.ticket.sequence}`),
    );
    const confirmationStart = performance.now();
    for (let n = 0; n < 20 && member.voice.channelId !== room.id; n++)
      await new Promise((r) => setTimeout(r, 250));
    if (member.voice.channelId !== room.id)
      throw new DomainError(
        "NOT_VERIFIED",
        "Discord move could not be verified. Manual reconciliation required.",
      );
    recordDuration(
      "discord.voice_confirmation",
      performance.now() - confirmationStart,
    );
    await measure("discord.voice_finalize", () =>
      finalizeTransfer(op.id, op.leaseToken, room.id),
    );
    finalized = true;
    await cleanupMute(member, ctx.settings, true);
  } catch (error) {
    if (finalized) {
      await locked(op.ticket.guildId, (tx) =>
        event(
          tx,
          op.ticket.guildId,
          "system",
          "voice.cleanup_failed",
          "Transfer succeeded; mute or room notification needs synchronization.",
          { operationId: id },
          "warn",
        ),
      );
      logger.error(
        { err: error, operationId: id },
        "Post-transfer synchronization failed",
      );
      return;
    }
    const reason =
      error instanceof DomainError
        ? error.message
        : "Discord transfer failed. Check permissions and reconcile voice state.";
    await failTransfer(op.id, op.leaseToken, reason, attempted);
    try {
      const ctx = await context(op.ticket.guildId);
      const room = await ctx.guild.channels.fetch(op.targetChannelId);
      if (ctx.settings.notifications && room?.type === ChannelType.GuildVoice)
        await notifyRoom(
          room,
          resolve(ctx.settings.failedText, values),
          `${id}:failed:${op.attempts}`,
        );
    } catch (notificationError) {
      logger.warn(
        { err: notificationError, operationId: id },
        "Transfer failure notification could not be sent",
      );
    }
    logger.error({ err: error, operationId: id }, "Voice transfer failed");
  }
}
let panelSync: Promise<void> | undefined;
let syncDirty = false,
  fullCheck = false;
let pendingScope: Set<PanelScope> | null = new Set();
export function syncPanels(
  force = false,
  scopes?: readonly PanelScope[] | null,
) {
  if (scopes?.length === 0 && !force) return Promise.resolve();
  syncDirty = true;
  fullCheck ||= force;
  if (!scopes || force) pendingScope = null;
  else for (const scope of scopes) pendingScope?.add(scope);
  return (panelSync ??= (async () => {
    while (syncDirty) {
      syncDirty = false;
      const check = fullCheck,
        selected = pendingScope ? [...pendingScope] : undefined;
      fullCheck = false;
      pendingScope = new Set();
      await measure("discord.panel_sync", () =>
        synchronizePanels(check, selected),
      );
    }
  })().finally(() => {
    panelSync = undefined;
  }));
}
async function synchronizePanels(
  force: boolean,
  scopes?: readonly PanelScope[],
) {
  const guildId = env().DISCORD_GUILD_ID;
  const state = await snapshot(guildId);
  const ctx = await context(guildId);
  const features = [
    "registration",
    "student_queue",
    "public_queue",
    "ta_dashboard",
    "support",
    "ranking",
    "summary",
    "student_ranking",
    "system_status",
  ];
  const [templates, published] = await Promise.all([
    db.embedTemplate.findMany({
      where: { guildId, feature: { in: features } },
      orderBy: { id: "asc" },
    }),
    db.publishedPanel.findMany({
      where: { guildId },
      select: { channelId: true, template: { select: { feature: true } } },
    }),
  ]);
  for (const feature of features) {
    const template = templates.find((t) => t.feature === feature);
    if (!template) continue;
    for (const channelId of ctx.channels(feature)) {
      if (
        published.some(
          (p) => p.channelId === channelId && p.template.feature === feature,
        )
      )
        continue;
      await db.publishedPanel.upsert({
        where: {
          guildId_channelId_templateId: {
            guildId,
            channelId,
            templateId: template.id,
          },
        },
        create: { guildId, channelId, templateId: template.id },
        update: {},
      });
    }
  }
  const eligiblePanels = (
    await db.publishedPanel.findMany({
      where: { guildId, active: true },
      include: { template: true, roomMapping: true },
    })
  ).filter(
    (panel) =>
      !scopes ||
      panelAffected(panel.template.feature, panel.template.document, scopes),
  );
  if (!eligiblePanels.length) return;
  const needsRankings = eligiblePanels.some((p) =>
    JSON.stringify(p.template.document).includes("{ranking."),
  );
  const guild = await db.guild.findUniqueOrThrow({ where: { id: guildId } });
  const baseline = [guild.analyticsSince, guild.rankingsSince]
    .filter((v): v is Date => !!v)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  const completed = needsRankings
    ? await db.inspection.findMany({
        where: {
          completedAt: { not: null, ...(baseline ? { gte: baseline } : {}) },
          voided: false,
          status: "COMPLETED",
          ticket: { guildId },
        },
        select: {
          taId: true,
          ticket: {
            select: {
              studentId: true,
              session: { select: { taName: true } },
              student: { select: { name: true, lastname: true } },
            },
          },
        },
      })
    : [];
  const ranks = new Map<string, { name: string; count: number }>();
  const students = new Map<string, { name: string; count: number }>();
  for (const i of completed) {
    const old = ranks.get(i.taId) || {
      name: i.ticket.session?.taName || i.taId,
      count: 0,
    };
    old.count++;
    ranks.set(i.taId, old);
    const student = students.get(i.ticket.studentId) || {
      name: `${i.ticket.student.name} ${i.ticket.student.lastname}`,
      count: 0,
    };
    student.count++;
    students.set(i.ticket.studentId, student);
  }
  const support = await db.supportTicket.groupBy({
    by: ["status"],
    where: { guildId },
    _count: true,
  });
  const heartbeats = await db.serviceHeartbeat.findMany();
  const values: Record<string, string | number> = {
    "support.open": support
      .filter((t) => !["CLOSING", "CLOSED"].includes(t.status))
      .reduce((n, t) => n + t._count, 0),
    "support.closing": support.find((t) => t.status === "CLOSING")?._count || 0,
    "support.closed": support.find((t) => t.status === "CLOSED")?._count || 0,
    ...Object.fromEntries(
      ["bot", "worker"].map((service) => [
        `system.${service}`,
        heartbeats.some(
          (h) =>
            h.service === service &&
            h.status === "online" &&
            Date.now() - h.updatedAt.getTime() < 45000,
        )
          ? th.online
          : th.offline,
      ]),
    ),

    "queue.total": state.tickets.length,
    "queue.waiting": state.metrics.waiting,
    "queue.available": state.metrics.available,
    "queue.capacity": state.metrics.capacity,
    "queue.draining": state.metrics.draining,
    "queue.active_tas": state.metrics.activeTAs,
    "queue.in_progress": state.metrics.inProgress,
    "queue.available_tas": state.metrics.availableTAs,
    "queue.current":
      state.sessions
        .map((s) => {
          const current = state.tickets.filter(
            (t) => t.sessionId === s.id && t.status === "IN_PROGRESS",
          );
          return current.length
            ? `${s.taName} · <#${s.voiceChannelId}> · ${current.map((t) => `#${t.sequence} · ${t.coursework.name}`).join(" · ")}`
            : "";
        })
        .filter(Boolean)
        .join("\n") || "ขณะนี้ไม่มีนักศึกษากำลังตรวจงาน",
    "queue.warnings": state.metrics.failed
      ? `⚠️ คิวที่ต้องตรวจสอบการย้าย: ${state.metrics.failed}`
      : state.metrics.draining
        ? `⚠️ คิวค้างที่รอตรวจ: ${state.metrics.draining}`
        : "",
    "queue.overview": `จำนวนคิวที่เปิดรับ: ${state.metrics.capacity}\nกำลังตรวจงาน: ${state.metrics.inProgress}\n🎟️ คิวว่าง: ${state.metrics.available}\n👥 นักศึกษารอคิว: ${state.metrics.waiting}\n🎓 ผู้ช่วยสอนที่เปิดรับคิว: ${state.metrics.activeTAs}`,
    "ta.table":
      state.sessions
        .map((s) => {
          const current = state.tickets.find(
            (t) => t.sessionId === s.id && t.status === "IN_PROGRESS",
          );
          return `${s.taName} · ${discordStatus(s.status)}${!s.present ? ` (${th.away})` : ""}${s.paused ? ` (${th.paused})` : ""} · ${s.capacity} · <#${s.voiceChannelId}>${current ? ` · ${th.ticket} #${current.sequence}` : ""}`;
        })
        .join("\n") || th.noSessions,
    "ranking.ta":
      [...ranks.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 10)
        .map((r, i) => `${i + 1}. ${r.name} · ${r.count} ${th.inspections}`)
        .join("\n") || th.noCompleted,
    "ranking.student": ctx.settings.publicStudentRanking
      ? [...students.values()]
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
          .slice(0, 10)
          .map(
            (s, i) =>
              `${i + 1}. ${ctx.settings.publicStudentNames ? s.name : th.student} · ${s.count} ${th.completed}`,
          )
          .join("\n") || th.noCompleted
      : th.privateRanking,
  };
  for (const panel of eligiblePanels) {
    try {
      if (
        panel.template.feature === "ta_room_queue_panel" &&
        !panel.roomMapping?.enabled
      )
        continue;
      if (panel.roomMapping)
        roomPanelTemplateSchema.parse(panel.template.document);
      const template = templateSchema.parse(panel.template.document);
      const visibility = ctx.settings.channelVisibility.find(
        (r) => r.channelId === panel.channelId,
      )?.policy;
      const preset =
        visibility ||
        ctx.settings.featureAccess[panel.template.feature] ||
        defaultAccess[panel.template.feature];
      const authorized = panel.roomMapping
        ? panel.roomMapping.visibility === "TAS" &&
          (!visibility || ["TAS", "ADMINS"].includes(visibility))
        : ["TAS", "ADMINS"].includes(preset || "");
      const fullDetails =
        panel.roomMapping?.visibility === "FULL_INSPECTION_DETAILS" &&
        panel.roomMapping.studentIdDisclosureAcknowledged;
      const currentAuthorized = authorized || !!fullDetails;
      const currentValues = roomCurrentValues(
        state.tickets,
        panel.roomMapping?.voiceChannelId || "",
        ctx.settings,
        currentAuthorized,
        template.roomLayout,
      );
      const panelValues = {
        ...values,
        ...currentValues,
        "queue.top": queueTop(
          state.tickets.filter((t) => !!t.reservation),
          panel.roomMapping && !authorized
            ? {
                ...ctx.settings,
                publicStudentIds:
                  ctx.settings.publicStudentIds === "MASKED"
                    ? "MASKED"
                    : "HIDDEN",
              }
            : ctx.settings,
          authorized,
        ),
        "room.status": panel.roomMapping
          ? state.sessions
              .filter(
                (s) => s.voiceChannelId === panel.roomMapping!.voiceChannelId,
              )
              .map(
                (s) =>
                  `${s.taName} · ${discordStatus(s.status)}${!s.present ? ` (${th.away})` : ""}${s.paused ? ` (${th.paused})` : ""} · เปิดรับ ${s.status === "ACCEPTING" ? s.capacity : 0} ที่`,
              )
              .join("\n") ||
            "ยังไม่เปิดรับคิว · ผู้ช่วยสอนในห้องที่กำหนดสามารถเรียกคิวได้ทันที"
          : "—",
        "room.current": panel.roomMapping
          ? roomCurrent(
              state.tickets,
              panel.roomMapping.voiceChannelId,
              ctx.settings,
              currentAuthorized,
              template.roomLayout,
            )
          : "ขณะนี้ไม่มีนักศึกษากำลังตรวจงาน",
      };
      const roomInspections = panel.roomMapping
        ? state.tickets.filter(
            (t) =>
              t.status === "IN_PROGRESS" &&
              (t.inspection?.voiceChannelId || t.session?.voiceChannelId) ===
                panel.roomMapping!.voiceChannelId,
          )
        : [];
      const documentWithState = panel.roomMapping
        ? {
            ...template,
            buttons: template.buttons.map((b) =>
              ["complete", "MARK_STUDENT_NO_SHOW", "no_show"].includes(b.action)
                ? {
                    ...b,
                    disabled:
                      b.disabled ||
                      !roomInspections.length ||
                      roomInspections.every(
                        (t) =>
                          t.completion?.state === "DISCONNECTING" &&
                          t.completion.leaseUntil &&
                          new Date(t.completion.leaseUntil) > new Date(),
                      ),
                    label: roomInspections.some(
                      (t) => t.completion?.state === "DISCONNECTING",
                    )
                      ? "กำลังจบการตรวจ…"
                      : b.label,
                  }
                : b,
            ),
          }
        : template;
      const rendered = render(
        documentWithState,
        panelValues,
        state.courses.filter((c) => c.enabled && !c.archived),
      );
      const document = panel.roomMapping
        ? (scopeRoomActions(
            rendered,
            panel.roomMapping.voiceChannelId,
          ) as typeof rendered)
        : rendered;
      const checkExisting =
        force ||
        (!!panel.roomMapping &&
          (!panel.checkedAt ||
            Date.now() - panel.checkedAt.getTime() >=
              panel.roomMapping.refreshSeconds * 1000));
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(document))
        .digest("hex");
      if (
        !checkExisting &&
        panel.fingerprint === fingerprint &&
        panel.messageId &&
        !panel.error
      )
        continue;
      const channel = await ctx.guild.channels.fetch(panel.channelId);
      if (!channel || !channel.isTextBased() || !("messages" in channel))
        throw new DomainError(
          "PANEL_CHANNEL",
          "Panel channel no longer exists.",
        );
      const mode = "flags" in document ? "V2" : "EMBED";
      const verifyExisting =
        checkExisting || panel.mode !== mode || !!panel.error;
      const existing =
        panel.messageId && verifyExisting
          ? await channel.messages
              .fetch({ message: panel.messageId, force: true })
              .catch((e) => {
                if (e.code === 10008) return null;
                throw e;
              })
          : null;
      let recovered = false;
      let existingMode = panel.mode;
      let existingId = verifyExisting ? existing?.id || null : panel.messageId;
      if (!existingId) {
        const adopted = await recoverPanelMessage(
          guildId,
          panel.channelId,
          panel.template.feature,
          document,
          panel.roomMapping?.voiceChannelId,
        );
        if (adopted) {
          existingId = adopted.id;
          existingMode =
            adopted.flags! & MessageFlags.IsComponentsV2 ? "V2" : "EMBED";
          if (existingMode !== mode)
            throw new DomainError(
              "PANEL_MODE",
              "An existing panel uses a different display mode. Select that mode to reuse its message.",
            );
          await db.publishedPanel.update({
            where: { id: panel.id },
            data: {
              messageId: adopted.id,
              mode: existingMode,
              fingerprint: null,
            },
          });
          recovered = true;
        }
      }
      if (
        existingId &&
        !recovered &&
        panel.mode === mode &&
        panel.fingerprint === fingerprint
      ) {
        await db.publishedPanel.update({
          where: { id: panel.id },
          data: { error: null, checkedAt: new Date() },
        });
        continue;
      }
      if (
        currentValues["room.current.student_id"]?.includes("ไม่พบรหัสนักศึกษา")
      )
        logger.warn(
          {
            guildId,
            panelId: panel.id,
            ticketIds: roomInspections.map((t) => t.id),
          },
          "Current inspection has no verified Student ID mapping; review Student Management identity mapping.",
        );
      let generation = panel.generation;
      if (existing && panel.mode !== mode) {
        await existing.delete();
        existingId = null;
      }
      let message: APIMessage | undefined;
      if (existingId && existingMode === mode) {
        try {
          message = (await rest.patch(
            Routes.channelMessage(panel.channelId, existingId),
            { body: document },
          )) as APIMessage;
        } catch (error) {
          if ((error as { code?: number }).code !== 10008) throw error;
        }
      }
      if (!message) {
        if (panel.messageId) {
          const pending = await db.publishedPanel.update({
            where: { id: panel.id },
            data: { messageId: null, generation: { increment: 1 } },
          });
          generation = pending.generation;
        }
        // A stable nonce prevents duplicate sends if Discord accepted a publish before a process crash.
        const nonce = BigInt(
          `0x${createHash("sha256").update(`${panel.id}:${mode}:${generation}`).digest("hex").slice(0, 15)}`,
        ).toString();
        message = (await rest.post(Routes.channelMessages(panel.channelId), {
          body: { ...document, nonce, enforce_nonce: true },
        })) as APIMessage;
      }
      await db.publishedPanel.update({
        where: { id: panel.id },
        data: {
          messageId: message.id,
          fingerprint,
          mode,
          version: panel.template.version,
          publishedAt: new Date(),
          checkedAt: new Date(),
          error: null,
        },
      });
      if (recovered)
        await locked(guildId, (tx) =>
          event(
            tx,
            guildId,
            "system",
            "panel.recovered",
            "Existing Discord panel adopted and updated.",
            {
              panelId: panel.id,
              channelId: panel.channelId,
              messageId: message.id,
            },
          ),
        );
    } catch (error) {
      const message =
        error instanceof DomainError
          ? error.message
          : "Discord panel update failed. Check channel permissions.";
      await db.publishedPanel.update({
        where: { id: panel.id },
        data: { error: message },
      });
      logger.error(
        { err: error, panelId: panel.id },
        "Panel synchronization failed",
      );
    }
  }
}
export async function createSupportChannel(ticketId: string) {
  const ticket = await db.supportTicket.findUniqueOrThrow({
    where: { id: ticketId },
  });
  if (!["CREATING", "CREATE_FAILED", "REOPENING"].includes(ticket.status))
    return;
  const ctx = await context(ticket.guildId);
  const all = await ctx.guild.channels.fetch();
  let channel = all.find(
    (c) =>
      c?.type === ChannelType.GuildText &&
      c.topic === `ta-support:${ticket.id}`,
  ) as TextChannel | undefined;
  if (!channel) {
    const category = ctx.channels("ticket_category")[0];
    const parent = category ? await ctx.guild.channels.fetch(category) : null;
    if (
      !parent ||
      parent.type !== ChannelType.GuildCategory ||
      !ctx.settings.supportRoles.length
    )
      throw new DomainError(
        "SUPPORT_CONFIG",
        "Configure support category and staff roles first.",
      );
    for (const role of [
      ...ctx.settings.supportRoles,
      ...ctx.settings.adminRoles,
    ])
      if (!(await ctx.guild.roles.fetch(role)))
        throw new DomainError(
          "SUPPORT_ROLE",
          "A support role no longer exists.",
        );
    channel = await ctx.guild.channels.create({
      name: `help-${ticket.id.slice(-8)}`,
      type: ChannelType.GuildText,
      parent: category,
      topic: `ta-support:${ticket.id}`,
      permissionOverwrites: [
        { id: ctx.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: ticket.creatorId,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
        {
          id: client.user!.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
        ...[...ctx.settings.supportRoles, ...ctx.settings.adminRoles].map(
          (id) => ({
            id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
            ],
          }),
        ),
      ],
    });
  }
  if (!ticket.channelId) {
    await channel.send({
      embeds: [
        {
          title: discordText("supportTitle", { id: ticket.id.slice(-8) }),
          description: ticket.description,
          fields: [
            { name: th.subject, value: ticket.subject },
            {
              name: th.category,
              value:
                th.categories[ticket.category as keyof typeof th.categories] ||
                ticket.category,
            },
            {
              name: th.additional,
              value: ticket.additional.slice(0, 1000) || th.none,
            },
            ...(ticket.additional.length > 1000
              ? [
                  {
                    name: th.additional,
                    value: ticket.additional.slice(1000, 2000),
                  },
                ]
              : []),
          ],
          color: 0x7879f1,
        },
      ],
      components: [
        {
          type: 1,
          components: ["claim", "reply", "close", "reopen", "escalate"].map(
            (action) => ({
              type: 2,
              style: action === "close" ? 4 : 2,
              label:
                th.supportActions[action as keyof typeof th.supportActions],
              customId: `ta:support_${action}:${ticket.id}`,
            }),
          ),
        },
        {
          type: 1,
          components: [
            {
              type: 2,
              style: 2,
              label: th.assignStaff,
              customId: `ta:support_assign:${ticket.id}`,
            },
          ],
        },
      ],
      allowedMentions: { parse: [] },
    });
    if (ctx.settings.supportRoles.length)
      await channel.send({
        content: ctx.settings.supportRoles.map((r) => `<@&${r}>`).join(" "),
        allowedMentions: { roles: ctx.settings.supportRoles },
      });
  }
  await locked(ticket.guildId, async (tx) => {
    await tx.supportTicket.update({
      where: { id: ticket.id },
      data: { channelId: channel!.id, status: "OPEN" },
    });
    await tx.supportTicketEvent.create({
      data: {
        ticketId,
        actorId: "system",
        action: "created",
        note: ticket.subject,
      },
    });
    await event(
      tx,
      ticket.guildId,
      ticket.creatorId,
      "support.created",
      "Private support channel created.",
      { ticketId, channelId: channel!.id },
    );
  });
}
export async function cleanupSupportTicket(ticketId: string) {
  const legacy = await db.supportTicket.findFirst({
    where: { id: ticketId, guildId: env().DISCORD_GUILD_ID },
  });
  if (!legacy) return;
  if (
    legacy.status === "CLOSED" &&
    !legacy.channelDeletedAt &&
    legacy.channelId
  )
    await locked(legacy.guildId, async (tx) => {
      const current = await tx.supportTicket.findUniqueOrThrow({
        where: { id: ticketId },
      });
      if (current.status !== "CLOSED" || current.channelDeletedAt) return;
      const closure = await tx.supportTicketEvent.findFirst({
        where: { ticketId, action: "close" },
        orderBy: { createdAt: "desc" },
      });
      await tx.supportTicket.update({
        where: { id: ticketId },
        data: {
          status: "CLOSING",
          closedBy: current.closedBy || closure?.actorId || "system",
          closureReason: current.closureReason || closure?.note || "",
          cleanupNextAttemptAt: new Date(),
        },
      });
    });
  const token = randomUUID();
  const claimed = await db.supportTicket.updateMany({
    where: {
      id: ticketId,
      status: "CLOSING",
      OR: [
        { cleanupAttempts: { lt: 5 } },
        {
          cleanupLeaseToken: { not: null },
          cleanupLeaseUntil: { lt: new Date() },
        },
      ],
      AND: [
        {
          OR: [
            { cleanupLeaseUntil: null },
            { cleanupLeaseUntil: { lt: new Date() } },
          ],
        },
        {
          OR: [
            { cleanupNextAttemptAt: null },
            { cleanupNextAttemptAt: { lte: new Date() } },
          ],
        },
      ],
    },
    data: {
      cleanupLeaseToken: token,
      cleanupError: null,
      cleanupLeaseUntil: new Date(Date.now() + 120000),
      cleanupAttempts: { increment: 1 },
    },
  });
  if (!claimed.count) return;
  const ticket = await db.supportTicket.findUniqueOrThrow({
    where: { id: ticketId },
  });
  try {
    const ctx = await context(ticket.guildId);
    const channel = ticket.channelId
      ? await ctx.guild.channels
          .fetch(ticket.channelId, { force: true })
          .catch((e) => {
            if (e.code === 10003) return null;
            throw e;
          })
      : null;
    if (
      channel &&
      (channel.type !== ChannelType.GuildText ||
        channel.topic !== `ta-support:${ticketId}`)
    )
      throw new DomainError(
        "TICKET_CHANNEL",
        "Channel ownership does not match this support ticket. Cleanup stopped.",
      );
    let transcript: Prisma.InputJsonValue | undefined;
    if (channel && ticket.transcriptRequired) {
      if (env().DISCORD_MESSAGE_CONTENT_ENABLED !== "true")
        throw new DomainError(
          "TRANSCRIPT_INTENT",
          "Required transcript needs Message Content intent. Enable it and retry cleanup.",
        );
      const messages = await channel.messages.fetch({ limit: 100 });
      const history = Array.isArray(ticket.transcript)
        ? (ticket.transcript as {
            id: string;
            author: string;
            content: string;
            time: string;
          }[])
        : [];
      transcript = [
        ...new Map(
          [
            ...history,
            ...messages.map((m) => ({
              id: m.id,
              author: m.author.id,
              content: m.content,
              time: m.createdAt.toISOString(),
            })),
          ].map((m) => [m.id, m]),
        ).values(),
      ];
    }
    await locked(ticket.guildId, async (tx) => {
      const current = await tx.supportTicket.findUniqueOrThrow({
        where: { id: ticketId },
      });
      if (current.cleanupLeaseToken !== token || current.status !== "CLOSING")
        throw new DomainError("LEASE", "Ticket cleanup lease changed.");
      if (transcript !== undefined)
        await tx.supportTicket.update({
          where: { id: ticketId },
          data: { transcript },
        });
      await tx.supportTicketEvent.create({
        data: {
          ticketId,
          actorId: ticket.closedBy || "system",
          action: "cleanup_prepared",
          note:
            !channel && ticket.transcriptRequired && ticket.transcript === null
              ? "Channel was already missing; transcript could not be recovered."
              : "Closure metadata and configured transcript are durable before channel deletion.",
        },
      });
    });
    if (channel && ticket.cleanupAttempts > 5)
      throw new DomainError(
        "CLEANUP_LIMIT",
        "Channel still exists after the cleanup retry limit. Retry cleanup explicitly in Tickets.",
      );
    if (channel)
      await channel
        .delete("Support ticket closed; history retained in Profun Assistant")
        .catch((error) => {
          if (error.code !== 10003) throw error;
        });
    await locked(ticket.guildId, async (tx) => {
      const updated = await tx.supportTicket.updateMany({
        where: { id: ticketId, status: "CLOSING", cleanupLeaseToken: token },
        data: {
          status: "CLOSED",
          closedAt: ticket.closedAt || new Date(),
          channelDeletedAt: new Date(),
          cleanupError: null,
          cleanupLeaseToken: null,
          cleanupLeaseUntil: null,
          cleanupNextAttemptAt: null,
        },
      });
      if (!updated.count) return;
      await tx.supportTicketEvent.create({
        data: {
          ticketId,
          actorId: ticket.closedBy || "system",
          action: ticket.closedAt ? "channel_deleted" : "close",
          note: ticket.closureReason,
        },
      });
      await event(
        tx,
        ticket.guildId,
        ticket.closedBy || "system",
        "support.closed",
        "Ticket history saved and Discord channel deletion confirmed.",
        { ticketId, channelId: ticket.channelId },
      );
    });
  } catch (error) {
    const message =
      error instanceof DomainError
        ? error.message
        : "Channel cleanup failed. Check Manage Channels and Read Message History, then retry cleanup in Tickets.";
    await db.supportTicket.updateMany({
      where: { id: ticketId, cleanupLeaseToken: token },
      data: {
        cleanupError: message,
        cleanupLeaseToken: null,
        cleanupLeaseUntil: null,
        cleanupNextAttemptAt: new Date(
          Date.now() + Math.min(60000, 1000 * 2 ** ticket.cleanupAttempts),
        ),
      },
    });
    await locked(ticket.guildId, (tx) =>
      event(
        tx,
        ticket.guildId,
        "system",
        "support.cleanup_failed",
        message,
        { ticketId, attempt: ticket.cleanupAttempts },
        "error",
      ),
    );
    logger.error({ err: error, ticketId }, "Support channel cleanup failed");
  }
}
export async function supportAction(
  guildId: string,
  actorId: string,
  ticketId: string,
  action: string,
  note = "",
  assignedId?: string,
) {
  const ctx = await context(guildId);
  const admin = await db.adminUser.findUnique({ where: { id: actorId } });
  if (
    !admin ||
    admin.disabled ||
    !["OWNER", "ADMIN", "OPERATOR"].includes(admin.role)
  )
    requireStaff(await ctx.guild.members.fetch(actorId), ctx.settings);
  const ticket = await db.supportTicket.findFirstOrThrow({
    where: { id: ticketId, guildId },
  });
  if (
    action === "claim" &&
    (ticket.status === "CLOSED" ||
      (ticket.assignedId && ticket.assignedId !== actorId))
  )
    throw new DomainError(
      "CLAIMED",
      "Ticket is closed or already claimed. Use explicit assignment or reopen.",
    );
  if (action === "close" || action === "retry_cleanup") {
    await locked(guildId, async (tx) => {
      const current = await tx.supportTicket.findUniqueOrThrow({
        where: { id: ticketId },
      });
      if (current.status === "CLOSED") return;
      if (action === "retry_cleanup") {
        if (current.status !== "CLOSING")
          throw new DomainError(
            "STATE",
            "Only pending channel cleanup can be retried.",
          );
        await tx.supportTicket.update({
          where: { id: ticketId },
          data: {
            cleanupAttempts: 0,
            cleanupNextAttemptAt: new Date(),
            cleanupError: null,
          },
        });
        return;
      }
      if (current.status === "CLOSING") return;
      if (!["OPEN", "CLAIMED", "ESCALATED"].includes(current.status))
        throw new DomainError("STATE", "Ticket is not ready to close.");
      if (
        ctx.settings.retainTranscripts &&
        env().DISCORD_MESSAGE_CONTENT_ENABLED !== "true"
      )
        throw new DomainError(
          "TRANSCRIPT_INTENT",
          "Enable Message Content intent before closing tickets with required transcripts.",
        );
      await tx.supportTicket.update({
        where: { id: ticketId },
        data: {
          status: "CLOSING",
          closedBy: actorId,
          closureReason: note,
          transcriptRequired: ctx.settings.retainTranscripts,
          cleanupAttempts: 0,
          cleanupNextAttemptAt: new Date(),
          cleanupError: null,
        },
      });
      await tx.supportTicketEvent.create({
        data: { ticketId, actorId, action: "close_requested", note },
      });
      await event(
        tx,
        guildId,
        actorId,
        "support.closing",
        "Ticket closure recorded; channel cleanup pending.",
        { ticketId, channelId: current.channelId },
      );
    });
    await cleanupSupportTicket(ticketId);
    return;
  }
  if (action === "reopen") {
    await locked(guildId, async (tx) => {
      const current = await tx.supportTicket.findUniqueOrThrow({
        where: { id: ticketId },
      });
      if (!["CLOSED", "REOPENING"].includes(current.status))
        throw new DomainError(
          "STATE",
          "Only a fully closed ticket can be reopened.",
        );
      if (
        (await tx.supportTicket.count({
          where: {
            guildId,
            creatorId: ticket.creatorId,
            status: { not: "CLOSED" },
            id: { not: ticketId },
          },
        })) >= ctx.settings.maxOpenSupport
      )
        throw new DomainError(
          "LIMIT",
          "Creator already has the maximum open support tickets.",
        );
      await tx.supportTicket.update({
        where: { id: ticketId },
        data: {
          status: "REOPENING",
          channelId: null,
          channelDeletedAt: null,
          closedAt: null,
        },
      });
      await tx.supportTicketEvent.create({
        data: { ticketId, actorId, action: "reopen", note },
      });
      await event(
        tx,
        guildId,
        actorId,
        "support.reopen",
        "Ticket reopened; new private channel requested.",
        { ticketId },
      );
      await tx.serviceOperation.create({
        data: {
          guildId,
          actorId,
          action: "create_support",
          data: { ticketId },
        },
      });
    });
    await createSupportChannel(ticketId);
    return;
  }
  if (!["OPEN", "CLAIMED", "ESCALATED"].includes(ticket.status))
    throw new DomainError("STATE", "Ticket is closed or changing state.");
  const channel = ticket.channelId
    ? await ctx.guild.channels.fetch(ticket.channelId)
    : null;
  if (!channel || channel.type !== ChannelType.GuildText)
    throw new DomainError(
      "CHANNEL",
      "Support channel is missing. Ask an administrator to recover it.",
    );
  if (action === "assign") {
    if (!assignedId)
      throw new DomainError("STAFF", "Choose a support staff Discord ID.");
    requireStaff(await ctx.guild.members.fetch(assignedId), ctx.settings);
  }
  await locked(guildId, async (tx) => {
    if (action === "claim") {
      const current = await tx.supportTicket.findUniqueOrThrow({
        where: { id: ticketId },
      });
      if (
        !["OPEN", "CLAIMED", "ESCALATED"].includes(current.status) ||
        (current.assignedId && current.assignedId !== actorId)
      )
        throw new DomainError(
          "CLAIMED",
          "Ticket is closed, changing state, or already claimed.",
        );
    }
    await tx.supportTicket.update({
      where: { id: ticketId },
      data: {
        ...(action === "claim"
          ? { assignedId: actorId, status: "CLAIMED" }
          : {}),
        ...(action === "assign" ? { assignedId } : {}),
        ...(action === "escalate" ? { status: "ESCALATED" } : {}),
      },
    });
    await tx.supportTicketEvent.create({
      data: { ticketId, actorId, action, note },
    });
    await event(
      tx,
      guildId,
      actorId,
      `support.${action}`,
      `Support ticket ${action}.`,
      { ticketId },
    );
  });
  await channel.send({
    content:
      `${discordText("supportUpdate", { action: th.supportActions[action as keyof typeof th.supportActions] || action })}${note ? `\n${note}` : ""}`.slice(
        0,
        1900,
      ),
    allowedMentions: { parse: [] },
  });
}
export async function validateChannels() {
  const ctx = await context(env().DISCORD_GUILD_ID);
  const bot = await ctx.guild.members.fetchMe();
  const reports: { feature: string; channelId: string; ok: boolean }[] = [];
  for (const b of await db.channelBinding.findMany({
    where: { guildId: ctx.guild.id },
  }))
    for (const id of b.channelIds) {
      const c = await ctx.guild.channels.fetch(id).catch(() => null);
      const need = b.feature.includes("voice")
        ? [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.MoveMembers,
          ]
        : b.feature === "ticket_category"
          ? [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.ManageChannels,
            ]
          : [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.EmbedLinks,
            ];
      reports.push({
        feature: b.feature,
        channelId: id,
        ok: !!c?.permissionsFor(bot)?.has(need),
      });
    }
  await locked(ctx.guild.id, (tx) =>
    event(
      tx,
      ctx.guild.id,
      "system",
      "channels.diagnostics",
      "Channel permission diagnostics completed.",
      reports,
      reports.every((r) => r.ok) ? "info" : "warn",
    ),
  );
  return reports;
}
export async function reconcileStudentVoice(
  member: GuildMember,
  observedAt = new Date(),
  previousChannelId?: string | null,
) {
  if (member.guild.available === false) return null;
  const changed = await observeStudentVoice(
    member.guild.id,
    member.id,
    member.voice.channelId,
    observedAt,
    previousChannelId,
    () => member.voice.channelId,
  );
  if (changed?.action === "cancelled")
    await member
      .send(discordText("departed", { number: changed.sequence }))
      .catch((error) =>
        logger.debug(
          { errorCode: error.code },
          "Student departure DM unavailable",
        ),
      );
  return changed;
}
export async function reconcilePresence() {
  const ctx = await context(env().DISCORD_GUILD_ID);
  if (ctx.guild.available === false) return;
  const observed = new Date();
  const present: {
    taId: string;
    taName: string;
    voiceChannelId: string;
    roleIds: string[];
  }[] = [];
  for (const voice of ctx.guild.voiceStates.cache.values()) {
    if (!voice.channelId || !ctx.channels("ta_voice").includes(voice.channelId))
      continue;
    const member = await ctx.guild.members.fetch(voice.id);
    if (member.roles.cache.has(ctx.settings.taRole))
      present.push({
        taId: member.id,
        taName: member.displayName,
        voiceChannelId: voice.channelId,
        roleIds: [...member.roles.cache.keys()],
      });
  }
  await locked(ctx.guild.id, async (tx) => {
    await tx.tAPresence.deleteMany({
      where: {
        guildId: ctx.guild.id,
        taId: { notIn: present.map((p) => p.taId) },
      },
    });
    for (const ta of present)
      await tx.tAPresence.upsert({
        where: { guildId_taId: { guildId: ctx.guild.id, taId: ta.taId } },
        create: { ...ta, guildId: ctx.guild.id, observedAt: observed },
        update: { ...ta, observedAt: observed },
      });
  });
  for (const s of await db.tASession.findMany({
    where: { guildId: ctx.guild.id, status: { not: "COMPLETED" } },
  })) {
    const member = await ctx.guild.members.fetch(s.taId).catch(() => null);
    const room = await ctx.guild.channels
      .fetch(s.voiceChannelId)
      .catch(() => null);
    const bot = await ctx.guild.members.fetchMe();
    const valid =
      member?.roles.cache.has(ctx.settings.taRole) &&
      ctx.channels("ta_voice").includes(s.voiceChannelId) &&
      room?.type === ChannelType.GuildVoice &&
      room
        .permissionsFor(bot)
        ?.has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.MoveMembers,
        ]);
    await setPresence(
      ctx.guild.id,
      s.taId,
      valid ? member?.voice.channelId || null : null,
    );
    if (member)
      await locked(ctx.guild.id, (tx) =>
        tx.tASession.update({
          where: { id: s.id },
          data: {
            roleIds: [...member.roles.cache.keys()],
            lastPresence: new Date(),
          },
        }),
      );
  }
  for (const ticket of await db.queueTicket.findMany({
    where: {
      guildId: ctx.guild.id,
      status: { in: ["QUEUED", "MOVE_FAILED", "IN_PROGRESS"] },
    },
    include: { student: true },
  })) {
    if (!ticket.student.discordId) continue;
    try {
      await reconcileStudentVoice(
        await ctx.guild.members.fetch(ticket.student.discordId),
      );
    } catch (error) {
      if ((error as { code?: number }).code === 10007)
        await observeStudentVoice(
          ctx.guild.id,
          ticket.student.discordId,
          null,
          new Date(),
        );
      else
        logger.warn(
          { err: error, ticketId: ticket.id },
          "Student voice reconciliation deferred",
        );
    }
  }
  for (const mute of await db.muteOwnership.findMany({
    where: { guildId: ctx.guild.id, state: { in: ["OWNED", "PENDING"] } },
  })) {
    const member = await ctx.guild.members
      .fetch(mute.discordId)
      .catch(() => null);
    if (
      member?.voice.channelId &&
      !ctx.channels("waiting_voice").includes(member.voice.channelId)
    ) {
      try {
        await cleanupMute(
          member,
          ctx.settings,
          ctx.channels("ta_voice").includes(member.voice.channelId),
        );
      } catch (error) {
        logger.warn(
          { err: error, discordId: mute.discordId },
          "Owned mute cleanup will retry",
        );
      }
    }
  }
}
