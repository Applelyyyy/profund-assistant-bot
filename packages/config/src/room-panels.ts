import { createHash } from "node:crypto";
import { db } from "../../database/src/index";
import {
  DomainError,
  Settings,
  roomPanelSchema,
  studentIdDisclosureWarning,
} from "../../shared/src/index";
import {
  AccessChannel,
  AccessRole,
  prepareAccess,
  applyPlannedBits,
  effectivePermissions,
} from "./access";
import { PermissionFlagsBits as P } from "discord.js";
import { roomPanelTemplateSchema } from "../../discord-ui/src/index";
export async function prepareRoomPanel(
  guildId: string,
  input: unknown,
  read: (path: string) => Promise<unknown>,
) {
  const data = roomPanelSchema.parse(input);
  data.studentIdDisclosureAcknowledged =
    data.visibility === "FULL_INSPECTION_DETAILS" &&
    data.studentIdDisclosureAcknowledged;
  const settings = (
    await import("../../shared/src/index")
  ).settingsSchema.parse(
    (await db.guild.findUniqueOrThrow({ where: { id: guildId } })).settings,
  );
  const bindings = await db.channelBinding.findMany({ where: { guildId } });
  if (
    !bindings
      .find((b) => b.feature === "ta_voice")
      ?.channelIds.includes(data.voiceChannelId)
  )
    throw new DomainError(
      "ROOM",
      "Select a configured TA inspection voice room.",
      400,
    );
  const channels = (await read(
    `guilds/${guildId}/channels`,
  )) as AccessChannel[];
  if (!channels.some((c) => c.id === data.voiceChannelId && c.type === 2))
    throw new DomainError(
      "ROOM",
      "Inspection voice room no longer exists.",
      400,
    );
  const active = (await read(`guilds/${guildId}/threads/active`)) as {
    threads: AccessChannel[];
  };
  const target = [...channels, ...active.threads].find(
    (c) => c.id === data.destinationChannelId,
  );
  if (
    !target ||
    (data.mode === "VOICE"
      ? target.id !== data.voiceChannelId || target.type !== 2
      : ![0, 5, 10, 11, 12].includes(target.type))
  )
    throw new DomainError(
      "DESTINATION",
      "Select the room voice chat or an accessible companion text channel/active thread.",
      400,
    );
  if (
    data.mode === "VOICE" &&
    !["PUBLIC", "FULL_INSPECTION_DETAILS"].includes(data.visibility)
  )
    throw new DomainError(
      "VISIBILITY",
      "Voice chat shares room visibility. Use a TA-only companion channel for restricted access.",
      400,
    );
  const template = await db.embedTemplate.findFirst({
    where: { id: data.templateId, guildId, feature: "ta_room_queue_panel" },
  });
  if (!template)
    throw new DomainError(
      "TEMPLATE",
      "Select a TA Room Queue Panel template.",
      400,
    );
  roomPanelTemplateSchema.parse(template.document);
  const old = await db.tARoomPanel.findUnique({
    where: {
      guildId_voiceChannelId: { guildId, voiceChannelId: data.voiceChannelId },
    },
  });
  const visibility = [...settings.channelVisibility];
  if (
    data.mode === "COMPANION" &&
    data.visibility !== "FULL_INSPECTION_DETAILS"
  ) {
    const channelId = [10, 11, 12].includes(target.type)
      ? target.parent_id
      : target.id;
    if (!channelId || !channels.some((c) => c.id === channelId))
      throw new DomainError("THREAD", "Thread parent no longer exists.", 400);
    const policy = data.visibility === "TAS" ? "TAS" : "EVERYONE";
    const existing = visibility.find((r) => r.channelId === channelId);
    if (
      existing &&
      (existing.policy !== policy ||
        existing.roleIds.length ||
        existing.deniedRoleIds.length)
    )
      throw new DomainError(
        "VISIBILITY_CONFLICT",
        "This destination has a different Channel Visibility policy. Change it in Roles & Access, then preview the room panel again.",
        400,
      );
    if (!existing)
      visibility.push({
        channelId,
        policy,
        roleIds: [],
        deniedRoleIds: [],
        autoSync: true,
      });
  }
  const proposed: Settings = { ...settings, channelVisibility: visibility };
  const plan =
    data.visibility === "FULL_INSPECTION_DETAILS"
      ? { changes: [], warnings: [studentIdDisclosureWarning], fingerprint: "" }
      : await prepareAccess(guildId, read, proposed, bindings);
  const bot = (await read("users/@me")) as { id: string };
  const botMember = (await read(`guilds/${guildId}/members/${bot.id}`)) as {
    roles: string[];
  };
  const roles = (await read(`guilds/${guildId}/roles`)) as AccessRole[];
  const permissionsChannel = [10, 11, 12].includes(target.type)
    ? channels.find((c) => c.id === target.parent_id)!
    : target;
  const patched = applyPlannedBits(permissionsChannel, plan.changes);
  const permissions = effectivePermissions(guildId, patched, roles, {
    user: bot,
    roles: botMember.roles,
  });
  const required =
    P.ViewChannel |
    P.ReadMessageHistory |
    P.EmbedLinks |
    ([10, 11, 12].includes(target.type)
      ? P.SendMessagesInThreads
      : P.SendMessages);
  if (!(permissions & P.Administrator) && (permissions & required) !== required)
    throw new DomainError(
      "PANEL_PERMISSIONS",
      "Bot needs View Channel, Read Message History, Embed Links and Send Messages (in Threads for a thread).",
      400,
    );
  if (
    target.type === 12 &&
    !(permissions & (P.Administrator | P.ManageThreads))
  )
    await read(`channels/${target.id}/thread-members/${bot.id}`);
  if (data.visibility === "TAS") {
    const allowed = new Set([
      guildId,
      settings.taRole,
      ...settings.adminRoles,
      bot.id,
    ]);
    const conflict = patched.permission_overwrites?.some(
      (o) =>
        !allowed.has(o.id) &&
        !!(BigInt(o.allow) & P.ViewChannel) &&
        !(
          o.type === 0 &&
          !!(
            BigInt(roles.find((r) => r.id === o.id)?.permissions || "0") &
            P.Administrator
          )
        ),
    );
    if (conflict)
      throw new DomainError(
        "VISIBILITY_CONFLICT",
        "Unrelated role/member allows still expose this companion channel. Remove that access in Discord before selecting TA-only visibility.",
        400,
      );
  }
  plan.fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        access: plan.fingerprint,
        data,
        templateVersion: template.version,
        permissionsChannel,
        roles,
        botMember,
      }),
    )
    .digest("hex");
  return {
    data,
    old,
    proposed,
    plan,
    originalVisibility: settings.channelVisibility,
  };
}
