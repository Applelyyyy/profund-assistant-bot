import {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  ButtonInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
  StringSelectMenuBuilder,
  LabelBuilder,
  type InteractionReplyOptions,
} from "discord.js";
import { z } from "zod";
import { performance } from "node:perf_hooks";
import { env } from "../../../packages/config/src/index";
import {
  measure,
  recordDuration,
} from "../../../packages/config/src/performance";
import { db } from "../../../packages/database/src/index";
import {
  DomainError,
  actionSchema,
  studentSchema,
  ACTIVE,
  defaultAccess,
  supportInputSchema,
  taRoomActions,
} from "../../../packages/shared/src/index";
import {
  admission,
  startSession,
  stopSession,
  claimNext,
  cancelTicket,
  retryMove,
  locked,
  mutate,
  event,
} from "../../../packages/queue-engine/src/index";
import {
  context,
  requireRole,
  requireStaff,
  authorizeTA,
  register,
  client,
} from "./discord";
import {
  th,
  discordText,
  discordStatus,
  discordError,
  thaiDateTime,
} from "../../../packages/discord-ui/src/index";
import { requestCompletion } from "../../../packages/queue-engine/src/completion";
import { processCompletion, notifyNoShow } from "./completion";
export type Interaction =
  | ButtonInteraction
  | ModalSubmitInteraction
  | StringSelectMenuInteraction;
const input = (
  id: string,
  label: string,
  style = TextInputStyle.Short,
  required = true,
  value?: string,
  maxLength = style === TextInputStyle.Paragraph ? 2000 : 100,
) =>
  new LabelBuilder().setLabel(label.slice(0, 45)).setTextInputComponent(
    new TextInputBuilder()
      .setCustomId(id)
      .setStyle(style)
      .setRequired(required)
      .setMaxLength(maxLength)
      .setValue(value || ""),
  );
const modal = (id: string, title: string, rows: LabelBuilder[]) =>
  new ModalBuilder().setCustomId(id).setTitle(title).addLabelComponents(rows);
async function personalTicket(guildId: string, userId: string) {
  return db.queueTicket.findFirst({
    where: {
      guildId,
      student: { discordId: userId },
      status: { in: [...ACTIVE] },
    },
    include: { student: true, session: true, coursework: true },
    orderBy: { sequence: "asc" },
  });
}
async function finishNoShow(
  guildId: string,
  actorId: string,
  key: string,
  roomId: string,
  ticketId: string,
) {
  const previous = await db.inspectionCompletion.findUnique({
    where: { ticketId },
    include: { ticket: true },
  });
  if (!previous || previous.state !== "SUCCEEDED") {
    const op = await requestCompletion(
      guildId,
      actorId,
      key,
      roomId,
      "NO_SHOW",
      ticketId,
    );
    await processCompletion(op.ticketId);
  } else if (
    previous.actorId !== actorId ||
    previous.ticket.guildId !== guildId ||
    previous.outcome !== "NO_SHOW"
  )
    throw new DomainError(
      "CONFIRMATION_EXPIRED",
      "Inspection no longer belongs to this decision.",
    );
  const done = await db.inspectionCompletion.findUniqueOrThrow({
    where: { ticketId },
  });
  if (done.state !== "SUCCEEDED")
    throw new DomainError(
      "COMPLETION_PENDING",
      "No Show disconnection is pending.",
    );
  await notifyNoShow(ticketId);
  const dm = await db.inspectionCompletion.findUniqueOrThrow({
    where: { ticketId },
  });
  return (
    "บันทึกว่านักศึกษาไม่ตอบกลับแล้ว สามารถเรียกคิวถัดไปได้" +
    (dm.notificationState === "FAILED"
      ? "\nไม่สามารถส่งข้อความส่วนตัวให้นักศึกษาได้"
      : ["SENDING", "NEEDS_REVIEW"].includes(dm.notificationState)
        ? "\nกำลังตรวจสอบการส่งข้อความส่วนตัว"
        : "")
  );
}
export function handleInteraction(i: Interaction) {
  const action = actionSchema.safeParse(i.customId.split(":")[1]);
  return measure(
    `discord.interaction.${action.success ? action.data : "unknown"}`,
    () => runInteraction(i),
  );
}
async function runInteraction(i: Interaction) {
  const received = performance.now();
  const acknowledge = async <T>(work: () => Promise<T>) => {
    const result = await work();
    recordDuration("discord.acknowledgment", performance.now() - received);
    return result;
  };
  if (!i.customId.startsWith("ta:")) return;
  const guildId = i.guildId;
  if (!guildId)
    throw new DomainError(
      "GUILD",
      "Use this panel inside the configured Discord server.",
      403,
    );
  const [, rawAction, target] = i.customId.split(":");
  const parsed = actionSchema.safeParse(rawAction);
  if (!parsed.success)
    throw new DomainError(
      "STALE",
      "This panel is stale. Ask an administrator to republish it.",
    );
  const action =
    parsed.data === "no_show"
      ? "MARK_STUDENT_NO_SHOW"
      : ["next", "help"].includes(parsed.data)
        ? "CALL_NEXT_STUDENT"
        : parsed.data;
  const opensModal =
    i.isButton() &&
    [
      "verify",
      "start",
      "session_settings",
      "support_open",
      "note",
      "support_reply",
      "support_assign",
      "support_close",
    ].includes(action);
  const silent =
    (action === "coursework" && i.isStringSelectMenu()) ||
    (action === "refresh" && i.isButton()) ||
    (taRoomActions.includes(action as (typeof taRoomActions)[number]) &&
      !!target &&
      !opensModal &&
      i.isButton());
  if (silent) await acknowledge(() => i.deferUpdate());
  else if (!opensModal)
    await acknowledge(() => i.deferReply({ flags: MessageFlags.Ephemeral }));
  const userId = i.user.id;
  if (guildId !== env().DISCORD_GUILD_ID)
    throw new DomainError("GUILD", "This server is not configured.", 403);
  if (action === "coursework" && i.isStringSelectMenu()) {
    const courseworkId = z.string().min(1).max(100).parse(i.values[0]);
    await db.draftSelection.upsert({
      where: { guildId_discordId: { guildId, discordId: userId } },
      create: {
        guildId,
        discordId: userId,
        courseworkId,
        expiresAt: new Date(Date.now() + 1800000),
      },
      update: {
        courseworkId,
        expiresAt: new Date(Date.now() + 1800000),
      },
    });
    return;
  }
  const ctx = await context(guildId);
  const member = await ctx.guild.members.fetch(userId);
  const taActions = [
    "start",
    "stop",
    "CALL_NEXT_STUDENT",
    "complete",
    "my_queue",
    "session_settings",
    "MARK_STUDENT_NO_SHOW",
    "no_show_confirm",
    "no_show_cancel",
    "retry",
    "return",
    "note",
  ];
  if (taActions.includes(action)) requireRole(member, ctx.settings.taRole);
  if (
    target &&
    taRoomActions.includes(action as (typeof taRoomActions)[number])
  ) {
    requireRole(member, ctx.settings.taRole);
    const mapping = await db.tARoomPanel.findFirst({
      where: { guildId, voiceChannelId: target, enabled: true },
      include: { publishedPanel: true },
    });
    if (
      !mapping ||
      mapping.destinationChannelId !== i.channelId ||
      !mapping.publishedPanel?.active ||
      !mapping.publishedPanel.messageId ||
      (i.isButton() && mapping.publishedPanel.messageId !== i.message?.id) ||
      (i.isModalSubmit() &&
        i.isFromMessage() &&
        mapping.publishedPanel.messageId !== i.message?.id) ||
      member.voice.channelId !== mapping.voiceChannelId
    )
      throw new DomainError(
        "ROOM_PANEL",
        "Use the panel in your current configured inspection room.",
        403,
      );
  }
  if (action === "support_open") {
    const preset = ctx.settings.featureAccess.support || defaultAccess.support;
    if (preset === "STUDENTS") requireRole(member, ctx.settings.studentRole);
    else if (preset === "TAS") requireRole(member, ctx.settings.taRole);
    else if (preset === "SUPPORT")
      requireStaff(member, {
        ...ctx.settings,
        supportRoles: ctx.settings.supportRoles,
      });
    else if (
      preset === "ADMINS" &&
      !member.permissions.has(8n) &&
      !ctx.settings.adminRoles.some((r) => member.roles.cache.has(r))
    )
      throw new DomainError(
        "PERMISSION",
        "Administrator access is required.",
        403,
      );
  }
  const permissionRoles =
    ctx.settings.featurePermissions[action] ||
    (["MARK_STUDENT_NO_SHOW", "no_show_confirm"].includes(action)
      ? ctx.settings.featurePermissions.MARK_STUDENT_NO_SHOW ||
        ctx.settings.featurePermissions.no_show
      : undefined) ||
    (action === "CALL_NEXT_STUDENT"
      ? ctx.settings.featurePermissions.next
      : undefined);
  if (
    action !== "verify" &&
    action !== "coursework" &&
    action !== "support_open" &&
    ctx.settings.advancedPermissionsEnabled &&
    permissionRoles?.length &&
    !permissionRoles.some((r) => member.roles.cache.has(r))
  )
    throw new DomainError(
      "PERMISSION",
      "Your roles cannot use this feature.",
      403,
    );
  if (action.startsWith("support_") && action !== "support_open")
    requireStaff(member, ctx.settings);
  if (i.isButton()) {
    const button = i;
    const reply = (options: InteractionReplyOptions) =>
      acknowledge(() => button.reply(options));
    const showModal = (document: ModalBuilder) =>
      acknowledge(() => button.showModal(document));
    if (action === "support_close") {
      if (!target) throw new DomainError("TICKET", "Choose a support ticket.");
      return showModal(
        modal(`ta:support_close:${target}`, th.supportClose, [
          input("note", th.closureReason, TextInputStyle.Paragraph, true),
        ]),
      );
    }
    if (action === "verify") {
      const existing = await db.student.findUnique({
        where: { guildId_discordId: { guildId, discordId: userId } },
      });
      if (
        existing?.registration === "REGISTERED" &&
        member.roles.cache.has(ctx.settings.studentRole)
      )
        return reply({
          content: th.alreadyVerified,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
      return showModal(
        modal("ta:verify", th.verifyTitle, [input("id", th.studentId)]),
      );
    }
    if (action === "start" || action === "session_settings") {
      const session = await db.tASession.findFirst({
        where: { guildId, taId: userId, status: { not: "COMPLETED" } },
      });
      await authorizeTA(guildId, userId, true);
      if (action === "start" && session?.status === "ACCEPTING")
        return reply({
          content:
            "คุณเปิดรับคิวอยู่แล้ว หากต้องการเปลี่ยนจำนวนที่รับ กรุณาใช้เมนูตั้งค่าการรับคิว",
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
      return showModal(
        modal(`ta:${action}${target ? `:${target}` : ""}`, th.startTitle, [
          input(
            "capacity",
            discordText("capacity", {
              min: ctx.settings.minCapacity,
              max: ctx.settings.maxCapacity,
            }),
            TextInputStyle.Short,
            true,
            String(session?.capacity || ctx.settings.defaultCapacity),
          ),
          input(
            "courses",
            th.courseIds,
            TextInputStyle.Short,
            false,
            session?.courseworkIds.join(","),
            1000,
          ),
          input(
            "note",
            th.sessionNote,
            TextInputStyle.Paragraph,
            false,
            session?.note,
          ),
        ]),
      );
    }
    if (action === "support_open") {
      return showModal(
        modal("ta:support_open", th.supportOpen, [
          new LabelBuilder().setLabel(th.category).setStringSelectMenuComponent(
            new StringSelectMenuBuilder()
              .setCustomId("category")
              .setPlaceholder(th.chooseCategory)
              .setRequired(true)
              .addOptions(
                ctx.settings.supportCategories.map((name) => ({
                  label: name,
                  value: name,
                })),
              ),
          ),
          input(
            "subject",
            th.subject,
            TextInputStyle.Paragraph,
            true,
            undefined,
            1000,
          ),
          input("description", th.description, TextInputStyle.Paragraph),
          input("additional", th.additional, TextInputStyle.Paragraph, false),
        ]),
      );
    }
    if (["note", "support_reply", "support_assign"].includes(action))
      return showModal(
        modal(
          `ta:${action}${target ? `:${target}` : ""}`,
          action === "support_assign" ? th.assignStaff : th.addNote,
          [
            input(
              "note",
              action === "support_assign" ? th.staffId : th.note,
              action === "support_assign"
                ? TextInputStyle.Short
                : TextInputStyle.Paragraph,
            ),
          ],
        ),
      );
  }
  let message = "";
  if (action === "verify" && i.isModalSubmit()) {
    const studentId = studentSchema.shape.studentId.parse(
      i.fields.getTextInputValue("id"),
    );
    const student = await register(guildId, userId, studentId);
    message =
      student.registration === "APPROVAL_PENDING"
        ? th.approvalPending
        : discordText("verified", {
            name: `${student.name} ${student.lastname}`,
          });
  } else if (action === "join") {
    requireRole(member, ctx.settings.studentRole);
    if (
      !member.voice.channelId ||
      !ctx.channels("waiting_voice").includes(member.voice.channelId)
    )
      throw new DomainError(
        "WAITING_VOICE",
        "Join an authorized waiting voice channel before requesting a ticket.",
      );
    const selection = await db.draftSelection.findUnique({
      where: { guildId_discordId: { guildId, discordId: userId } },
    });
    if (!selection || selection.expiresAt < new Date())
      throw new DomainError(
        "SELECTION",
        "Select coursework again, then click Join Queue.",
      );
    if (
      !ctx.settings.requireIdentity &&
      !(await db.student.findUnique({
        where: { guildId_discordId: { guildId, discordId: userId } },
      }))
    )
      await locked(guildId, (tx) =>
        tx.student.upsert({
          where: { guildId_discordId: { guildId, discordId: userId } },
          create: {
            guildId,
            discordId: userId,
            studentId: `discord-${userId}`,
            name: member.displayName,
            lastname: "Discord member",
            registration: "ROLE_ONLY",
          },
          update: {},
        }),
      );
    const ticket = await admission(
      guildId,
      userId,
      i.id,
      selection.courseworkId,
      () =>
        !!member.voice.channelId &&
        ctx.channels("waiting_voice").includes(member.voice.channelId) &&
        member.roles.cache.has(ctx.settings.studentRole),
    );
    const position = await db.queueTicket.count({
      where: {
        guildId,
        reservation: { isNot: null },
        sequence: { lte: ticket.sequence },
      },
    });
    message = discordText("admitted", {
      number: ticket.sequence,
      name: `${ticket.student.name} ${ticket.student.lastname}`,
      course: ticket.coursework.name,
      position,
      created: thaiDateTime(ticket.createdAt, ctx.settings.timezone),
      status: discordStatus(ticket.status),
    });
  } else if (action === "status") {
    const t = await personalTicket(guildId, userId);
    if (!t) message = th.noTicket;
    else {
      const position = await db.queueTicket.count({
        where: {
          guildId,
          reservation: { isNot: null },
          sequence: { lte: t.sequence },
        },
      });
      message = discordText("ticketStatus", {
        number: t.sequence,
        course: t.coursework.name,
        status: discordStatus(t.status),
        position,
      });
    }
  } else if (action === "cancel") {
    const t = await cancelTicket(guildId, userId, i.id);
    message = discordText("cancelled", { number: t.sequence });
  } else if (
    ["start", "session_settings"].includes(action) &&
    i.isModalSubmit()
  ) {
    const verified = await authorizeTA(guildId, userId, true);
    const capacity = z.coerce
      .number()
      .int()
      .parse(i.fields.getTextInputValue("capacity"));
    const courses = i.fields
      .getTextInputValue("courses")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    const s = await startSession(
      guildId,
      userId,
      i.id,
      {
        taName: member.displayName,
        voiceChannelId: verified.room.id,
        capacity,
        courseworkIds: courses,
        roleIds: [...member.roles.cache.keys()],
        note: i.fields.getTextInputValue("note"),
      },
      action === "session_settings" ? "SETTINGS" : "START",
    );
    message = discordText("accepting", {
      capacity: s.capacity,
      room: s.voiceChannelId,
    });
  } else if (action === "stop") {
    await stopSession(guildId, userId, i.id);
    message = th.stopped;
  } else if (action === "CALL_NEXT_STUDENT") {
    const verified = await authorizeTA(guildId, userId, true);
    const claimed = await claimNext(guildId, userId, i.id, {
      taName: member.displayName,
      voiceChannelId: verified.room.id,
      roleIds: [...member.roles.cache.keys()],
      voiceEligible: () =>
        verified.member.voice.channelId === verified.room.id &&
        verified.member.roles.cache.has(ctx.settings.taRole),
    });
    message = discordText("claimed", { number: claimed.sequence });
  } else if (action === "complete") {
    const verified = await authorizeTA(guildId, userId);
    const op = await requestCompletion(guildId, userId, i.id, verified.room.id);
    await processCompletion(op.ticketId);
    const completed = await db.inspectionCompletion.findUniqueOrThrow({
      where: { ticketId: op.ticketId },
    });
    if (completed.state !== "SUCCEEDED")
      throw new DomainError("COMPLETION_PENDING", "Completion is pending.");
    message = discordText("inspectionComplete", {
      number: (
        await db.queueTicket.findUniqueOrThrow({ where: { id: op.ticketId } })
      ).sequence,
    });
  } else if (action === "MARK_STUDENT_NO_SHOW") {
    const verified = await authorizeTA(guildId, userId);
    const tickets = await db.queueTicket.findMany({
      where: {
        guildId,
        status: "IN_PROGRESS",
        inspection: { taId: userId, completedAt: null },
      },
      include: { student: true, inspection: true, completion: true },
    });
    if (!tickets.length)
      throw new DomainError("NO_INSPECTION", "No active inspection.");
    if (tickets.length !== 1)
      throw new DomainError(
        "AMBIGUOUS_INSPECTION",
        "Select one inspection through administrator recovery.",
      );
    const ticket = tickets[0];
    if (ticket.completion) {
      if (ticket.completion.outcome !== "NO_SHOW")
        throw new DomainError(
          "COMPLETION_PENDING",
          "A different completion decision is pending.",
        );
      const response = await finishNoShow(
        guildId,
        userId,
        i.id,
        verified.room.id,
        ticket.id,
      );
      if (silent)
        await i.followUp({
          content: response,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        });
      else
        await i.editReply({
          content: response,
          allowedMentions: { parse: [] },
        });
      return;
    }
    const student = await ctx.guild.members.fetch(ticket.student.discordId!);
    if (
      student.voice.channelId !== verified.room.id ||
      ticket.inspection!.voiceChannelId !== verified.room.id
    )
      throw new DomainError("VOICE", "Student is not in this inspection room.");
    await mutate(guildId, userId, "no_show_confirmation", i.id, async (tx) => {
      const current = await tx.queueTicket.findFirst({
        where: {
          id: ticket.id,
          guildId,
          status: "IN_PROGRESS",
          inspection: { taId: userId, completedAt: null },
          completion: null,
        },
      });
      if (!current)
        throw new DomainError(
          "CONFIRMATION_EXPIRED",
          "Inspection state changed.",
        );
      return {
        ticketId: ticket.id,
        roomId: verified.room.id,
        channelId: i.channelId,
        panelMessageId: target ? i.message?.id : null,
        mapped: !!target,
        expiresAt: Date.now() + 120000,
      };
    });
    const response = {
      content:
        "**ยืนยันการบันทึกว่าไม่ตอบกลับ**\nต้องการยุติการตรวจงานและตัดการเชื่อมต่อเสียงของนักศึกษาคนนี้หรือไม่?",
      components: [
        {
          type: 1 as const,
          components: [
            {
              type: 2 as const,
              style: 4 as const,
              label: "ยืนยัน",
              custom_id: `ta:no_show_confirm:${i.id}`,
            },
            {
              type: 2 as const,
              style: 2 as const,
              label: "ยกเลิก",
              custom_id: `ta:no_show_cancel:${i.id}`,
            },
          ],
        },
      ],
      allowedMentions: { parse: [] as [] },
    };
    if (silent)
      await i.followUp({ ...response, flags: MessageFlags.Ephemeral });
    else await i.editReply(response);
    return;
  } else if (action === "no_show_confirm" || action === "no_show_cancel") {
    const record = await db.idempotencyRecord.findUnique({
      where: { key: `${guildId}:${userId}:no_show_confirmation:${target}` },
    });
    const confirmation = record?.result as
      | {
          ticketId: string;
          roomId: string;
          channelId: string;
          panelMessageId: string | null;
          mapped: boolean;
          expiresAt: number;
        }
      | undefined;
    if (
      !confirmation ||
      confirmation.expiresAt < Date.now() ||
      confirmation.channelId !== i.channelId
    )
      throw new DomainError(
        "CONFIRMATION_EXPIRED",
        "Confirmation expired or belongs to another actor/channel.",
      );
    if (action === "no_show_cancel") {
      await db.idempotencyRecord.update({
        where: { key: record!.key },
        data: { result: { ...confirmation, expiresAt: 0 } },
      });
      await i.editReply({
        content: "ยกเลิกการบันทึกแล้ว",
        allowedMentions: { parse: [] },
      });
      return;
    }
    const verified = await authorizeTA(guildId, userId, true);
    if (verified.room.id !== confirmation.roomId)
      throw new DomainError(
        "ROOM_PANEL",
        "Return to the original inspection room.",
      );
    if (confirmation.mapped) {
      const mapping = await db.tARoomPanel.findFirst({
        where: { guildId, voiceChannelId: confirmation.roomId, enabled: true },
        include: { publishedPanel: true },
      });
      if (
        !mapping?.publishedPanel?.active ||
        mapping.destinationChannelId !== i.channelId ||
        mapping.publishedPanel.messageId !== confirmation.panelMessageId
      )
        throw new DomainError(
          "ROOM_PANEL",
          "The original room panel is no longer active.",
        );
    }
    message = await finishNoShow(
      guildId,
      userId,
      i.id,
      verified.room.id,
      confirmation.ticketId,
    );
  } else if (action === "my_queue") {
    const tickets = await db.queueTicket.findMany({
      where: {
        guildId,
        OR: [{ session: { taId: userId } }, { status: "QUEUED" }],
        status: { in: [...ACTIVE] },
      },
      include: { student: true, coursework: true },
      orderBy: { sequence: "asc" },
    });
    message =
      tickets
        .map(
          (t) =>
            `#${t.sequence} · ${t.student.name} ${t.student.lastname} · ${t.coursework.name} · ${discordStatus(t.status)}`,
        )
        .join("\n") || th.noOutstanding;
  } else if (action === "retry" || action === "return" || action === "note") {
    const applicable = await db.queueTicket.findMany({
      where: {
        guildId,
        session: { taId: userId },
        status: {
          in:
            action === "retry"
              ? ["MOVE_FAILED", "NEEDS_REVIEW"]
              : ["IN_PROGRESS"],
        },
      },
      orderBy: { sequence: "asc" },
    });
    if (applicable.length > 1)
      throw new DomainError(
        "AMBIGUOUS_INSPECTION",
        "Choose a specific inspection through administrator recovery.",
      );
    const ticket = applicable[0];
    if (!ticket)
      throw new DomainError("TICKET", "No applicable ticket in your queue.");
    if (action === "retry") {
      await retryMove(guildId, userId, i.id, ticket.id);
      message = th.retryQueued;
    } else if (action === "note" && i.isModalSubmit()) {
      await mutate(guildId, userId, "inspection_note", i.id, async (tx) => {
        await tx.inspection.update({
          where: { ticketId: ticket.id },
          data: { note: i.fields.getTextInputValue("note").slice(0, 2000) },
        });
        await event(
          tx,
          guildId,
          userId,
          "inspection.note",
          "Inspection note updated.",
          { ticketId: ticket.id },
        );
      });
      message = th.noteSaved;
    } else if (action === "return") {
      await authorizeTA(guildId, userId);
      await mutate(guildId, userId, "return_student", i.id, async (tx) => {
        if (
          await tx.inspectionCompletion.findUnique({
            where: { ticketId: ticket.id },
          })
        )
          throw new DomainError(
            "COMPLETION_PENDING",
            "Resolve the pending completion first.",
          );
        const current = await tx.queueTicket.findFirst({
          where: {
            id: ticket.id,
            guildId,
            status: "IN_PROGRESS",
            inspection: { taId: userId, completedAt: null },
          },
        });
        if (!current)
          throw new DomainError(
            "NO_INSPECTION",
            "Inspection is no longer active.",
          );
        const pending = await tx.serviceOperation.findFirst({
          where: {
            guildId,
            action: "return_student",
            status: { in: ["PENDING", "RUNNING"] },
            data: { path: ["ticketId"], equals: ticket.id },
          },
        });
        if (pending) return pending;
        return tx.serviceOperation.create({
          data: {
            guildId,
            actorId: userId,
            action: "return_student",
            data: { ticketId: ticket.id },
          },
        });
      });
      message = th.returnRequested;
    }
  } else if (action === "support_open" && i.isModalSubmit()) {
    const category = i.fields.getStringSelectValues("category")[0];
    if (!ctx.settings.supportCategories.includes(category))
      throw new DomainError(
        "CATEGORY",
        `Choose: ${ctx.settings.supportCategories.join(", ")}.`,
      );
    const submitted = supportInputSchema.safeParse({
      category,
      subject: i.fields.getTextInputValue("subject"),
      description: i.fields.getTextInputValue("description"),
      additional: i.fields.getTextInputValue("additional"),
    });
    if (!submitted.success) {
      await i.editReply({
        content: th.subjectInvalid,
        allowedMentions: { parse: [] },
      });
      return;
    }
    const ticket = await locked(guildId, async (tx) => {
      const existing = await tx.idempotencyRecord.findUnique({
        where: { key: `support:${i.id}` },
      });
      if (existing)
        return tx.supportTicket.findUniqueOrThrow({
          where: { id: existing.result as string },
        });
      if (
        (await tx.supportTicket.count({
          where: { guildId, creatorId: userId, status: { not: "CLOSED" } },
        })) >= ctx.settings.maxOpenSupport
      )
        throw new DomainError(
          "SUPPORT_LIMIT",
          "You already have the maximum open support tickets.",
        );
      const recent = await tx.supportTicket.count({
        where: {
          guildId,
          creatorId: userId,
          createdAt: { gte: new Date(Date.now() - 60000) },
        },
      });
      if (recent)
        throw new DomainError(
          "RATE_LIMIT",
          "Wait one minute before opening another ticket.",
        );
      const ticket = await tx.supportTicket.create({
        data: {
          guildId,
          creatorId: userId,
          ...submitted.data,
        },
      });
      await tx.serviceOperation.create({
        data: {
          guildId,
          actorId: userId,
          action: "create_support",
          data: { ticketId: ticket.id },
        },
      });
      await tx.idempotencyRecord.create({
        data: {
          key: `support:${i.id}`,
          guildId,
          actorId: userId,
          action: "support_create",
          result: ticket.id,
        },
      });
      await event(
        tx,
        guildId,
        userId,
        "support.requested",
        "Support ticket creation requested.",
        { ticketId: ticket.id },
      );
      return ticket;
    });
    message = discordText("supportRequested", { id: ticket.id.slice(-8) });
  } else if (action.startsWith("support_") && target) {
    const note = i.isModalSubmit() ? i.fields.getTextInputValue("note") : "";
    const assignedId =
      action === "support_assign"
        ? z
            .string()
            .regex(/^\d{17,20}$/)
            .parse(note)
        : undefined;
    await locked(guildId, async (tx) => {
      await tx.supportTicket.findFirstOrThrow({
        where: { id: target, guildId },
      });
      await tx.serviceOperation.create({
        data: {
          guildId,
          actorId: userId,
          action: "support_action",
          data: {
            ticketId: target,
            action: action.replace("support_", ""),
            note: assignedId ? "" : note,
            ...(assignedId ? { assignedId } : {}),
          },
        },
      });
    });
    message = th.supportUpdated;
  } else if (action === "refresh") {
    await locked(guildId, (tx) =>
      tx.serviceOperation.create({
        data: { guildId, actorId: userId, action: "refresh_panels" },
      }),
    );
    return;
  } else
    throw new DomainError(
      "STALE",
      "Unsupported or stale interaction. Refresh the panel.",
    );
  if (silent) {
    if (action === "my_queue")
      await i.followUp({
        content: message.slice(0, 1900),
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    return;
  }
  await i.editReply({
    content: message.slice(0, 1900),
    allowedMentions: { parse: [] },
  });
}
const recentInteractions = new Map<string, number>();
client.on("interactionCreate", async (i) => {
  if (!i.isButton() && !i.isModalSubmit() && !i.isStringSelectMenu()) return;
  const now = Date.now();
  for (const [id, expiresAt] of recentInteractions) {
    if (expiresAt > now) break;
    recentInteractions.delete(id);
  }
  // The first delivery owns acknowledgment and feedback; domain idempotency remains in PostgreSQL.
  if (recentInteractions.has(i.id)) return;
  if (recentInteractions.size >= 2048)
    recentInteractions.delete(recentInteractions.keys().next().value!);
  recentInteractions.set(i.id, now + 15 * 60000);
  try {
    await handleInteraction(i);
  } catch (error) {
    const message =
      error instanceof DomainError
        ? discordError(error.code)
        : error instanceof z.ZodError
          ? th.invalidInput
          : th.operationFailed;
    if (i.customId.split(":")[1] === "coursework" && i.isStringSelectMenu()) {
      // A deferred update points to the shared panel; selection failures must never edit it.
      const { logger } = await import("../../../packages/config/src/index");
      logger.warn(
        {
          interactionId: i.id,
          code: error instanceof DomainError ? error.code : "SELECTION_FAILED",
        },
        "Coursework selection was not saved",
      );
    } else if (
      (i.customId.split(":")[1] === "refresh" ||
        (i.customId.split(":").length > 2 &&
          taRoomActions.includes(
            i.customId.split(":")[1] as (typeof taRoomActions)[number],
          )) ||
        /^ta:(next|help):/.test(i.customId)) &&
      i.isButton() &&
      i.deferred
    )
      await i
        .followUp({
          content: message,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        })
        .catch(() => {});
    else if (i.deferred || i.replied)
      await i
        .editReply({ content: message, allowedMentions: { parse: [] } })
        .catch(() => {});
    else
      await i
        .reply({
          content: message,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        })
        .catch(() => {});
    if (!(error instanceof DomainError)) {
      const { logger } = await import("../../../packages/config/src/index");
      logger.error(
        { err: error, interactionId: i.id },
        "Discord interaction failed",
      );
      if (i.guildId)
        await locked(i.guildId, (tx) =>
          event(
            tx,
            i.guildId!,
            i.user.id,
            "interaction.failed",
            "Discord interaction failed.",
            { interactionId: i.id },
            "error",
          ),
        ).catch((e) =>
          logger.error({ err: e }, "Failed to persist interaction error"),
        );
    }
  }
});
