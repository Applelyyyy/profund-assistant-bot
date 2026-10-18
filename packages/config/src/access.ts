import { createHash } from "node:crypto";
import { PermissionFlagsBits as P } from "discord.js";
import { db, Prisma } from "../../database/src/index";
import { Settings, DomainError, defaultAccess } from "../../shared/src/index";

type Bits = Record<string, boolean | null>;
export type AccessChannel = {
  id: string;
  name: string;
  type: number;
  parent_id?: string | null;
  permission_overwrites?: {
    id: string;
    type: number;
    allow: string;
    deny: string;
  }[];
};
export type AccessRole = {
  id: string;
  name: string;
  permissions: string;
  position: number;
  managed?: boolean;
};
export type AccessChange = {
  channelId: string;
  channelName: string;
  channelType?: number;
  inheritedFrom?: string;
  targetId: string;
  targetName: string;
  targetType: number;
  before: Bits;
  permissions: Bits;
  original: Bits;
  applied: Bits;
};
export type AccessMember = {
  user: { id: string; username?: string };
  roles: string[];
};
export type AccessPlan = {
  effective?: {
    channelId: string;
    member: string;
    before: boolean;
    after: boolean;
    exempt: boolean;
  }[];
  fingerprint: string;
  changes: AccessChange[];
  warnings: string[];
};
export const channelKinds = (feature: string) =>
  feature.includes("voice") || feature === "post_inspection"
    ? [2]
    : feature === "ticket_category"
      ? [4]
      : [0, 5];
export function validateAccessRoles(
  guildId: string,
  settings: Settings,
  roles: AccessRole[],
) {
  const ids = [
    settings.studentRole,
    settings.taRole,
    ...settings.supportRoles,
    ...settings.adminRoles,
    ...settings.moderatorRoles,
  ].filter(Boolean);
  for (const id of ids)
    if (id === guildId || !roles.some((r) => r.id === id))
      throw new DomainError(
        "ROLE",
        "Select existing server roles; @everyone is automatic and cannot be assigned as Student/TA/Support/Admin.",
        400,
      );
  if (settings.studentRole && settings.studentRole === settings.taRole)
    throw new DomainError(
      "ROLE",
      "Student and TA must use different roles.",
      400,
    );
  if (
    settings.studentRole &&
    [...settings.supportRoles, ...settings.adminRoles].includes(
      settings.studentRole,
    )
  )
    throw new DomainError(
      "ROLE",
      "Student role cannot also be a Support or Admin role.",
      400,
    );
  const student = roles.find((r) => r.id === settings.studentRole);
  if (
    student &&
    (student.managed ||
      BigInt(student.permissions) &
        (P.Administrator | P.ManageRoles | P.ManageGuild))
  )
    throw new DomainError(
      "ROLE",
      "Student role must be assignable and must not grant administrator/server/role management.",
      400,
    );
}
export function overwriteBits(
  channel: AccessChannel,
  targetId: string,
  keys: string[],
): Bits {
  const overwrite = channel.permission_overwrites?.find(
    (o) => o.id === targetId,
  );
  return Object.fromEntries(
    keys.map((key) => [
      key,
      !overwrite
        ? null
        : BigInt(overwrite.allow) & P[key as keyof typeof P]
          ? true
          : BigInt(overwrite.deny) & P[key as keyof typeof P]
            ? false
            : null,
    ]),
  );
}
export function accessPlan(
  guildId: string,
  settings: Settings,
  bindings: { feature: string; channelIds: string[] }[],
  channels: AccessChannel[],
  roles: AccessRole[],
  bot: { id: string; roles: string[] },
  managed: {
    channelId: string;
    targetId: string;
    targetType: number;
    original: unknown;
    applied: unknown;
  }[],
  members: AccessMember[] = [],
  ownerId?: string,
  privateChannelIds: string[] = [],
): AccessPlan {
  validateAccessRoles(guildId, settings, roles);
  const student = roles.find((r) => r.id === settings.studentRole);
  const highest = Math.max(
    0,
    ...roles.filter((r) => bot.roles.includes(r.id)).map((r) => r.position),
  );
  if (student && student.position >= highest)
    throw new DomainError(
      "BOT_HIERARCHY",
      "Move the bot role above the selected Student role before syncing verification access.",
      400,
    );
  for (const id of [
    ...settings.taStudentChannelExceptions,
    ...settings.taStudentConnectChannels,
  ])
    if (!channels.some((c) => c.id === id))
      throw new DomainError(
        "CHANNEL",
        "Select existing guild channels for TA assistance access.",
        400,
      );
  if (
    settings.taStudentConnectChannels.some(
      (id) =>
        !channels.some((c) => c.id === id && c.type === 2) ||
        !bindings.some(
          (b) => b.feature === "waiting_voice" && b.channelIds.includes(id),
        ),
    )
  )
    throw new DomainError(
      "CHANNEL",
      "TA waiting connections require authorized Waiting Voice bindings.",
      400,
    );
  const privateIds = new Set([
    ...privateChannelIds,
    ...bindings
      .filter((b) =>
        [
          "ticket_category",
          "error_log",
          "audit_log",
          "system_status",
          "ta_dashboard",
          "queue_alert",
        ].includes(b.feature),
      )
      .flatMap((b) => b.channelIds),
  ]);
  const studentChannels = new Set(
    bindings
      .filter(
        (b) =>
          (settings.featureAccess[b.feature] || defaultAccess[b.feature]) ===
            "STUDENTS" ||
          ["student_queue", "public_queue", "waiting_voice"].includes(
            b.feature,
          ),
      )
      .flatMap((b) => b.channelIds),
  );
  for (const rule of settings.channelVisibility)
    if (rule.policy === "STUDENTS") studentChannels.add(rule.channelId);
  const taViews = (id: string) =>
    settings.taStudentChannelAccess &&
    !!settings.taRole &&
    studentChannels.has(id) &&
    !privateIds.has(id) &&
    !settings.taStudentChannelExceptions.includes(id) &&
    !settings.channelVisibility.some(
      (r) =>
        r.channelId === id &&
        (["ADMINS", "TAS", "SUPPORT", "CUSTOM", "UNVERIFIED_ONLY"].includes(
          r.policy,
        ) ||
          r.deniedRoleIds.includes(settings.taRole)),
    );
  const desired = new Map<
    string,
    { channel: AccessChannel; targetId: string; targetType: number; bits: Bits }
  >();
  const warnings = [
    "Discord Administrator and server owner bypass channel restrictions. Unrelated member/role overrides remain unchanged; review them for extra access.",
    "Avoid editing the same permission overwrite while synchronization runs; Discord has no atomic conditional update for individual permission bits.",
  ];
  if (!settings.advancedPermissionsEnabled)
    warnings.push(
      "Simple presets enforce Student, TA and Support role checks. Extra advanced action restrictions are disabled; their stored rules are preserved.",
    );
  const groups: Record<string, string[]> = {
    EVERYONE: [],
    STUDENTS: [settings.studentRole],
    TAS: [settings.taRole],
    SUPPORT: settings.supportRoles,
    ADMINS: settings.adminRoles,
  };
  const roleIds = [
    ...new Set(
      [
        settings.studentRole,
        settings.taRole,
        ...settings.supportRoles,
        ...settings.adminRoles,
      ].filter(Boolean),
    ),
  ];
  function put(
    channel: AccessChannel,
    targetId: string,
    targetType: number,
    bits: Bits,
  ) {
    const key = channel.id + ":" + targetId,
      old = desired.get(key);
    if (old)
      for (const [name, value] of Object.entries(bits))
        if (name in old.bits && old.bits[name] !== value)
          throw new DomainError(
            "CHANNEL_CONFLICT",
            `#${channel.name} is bound to features with conflicting ${name} access. Use separate channels.`,
            400,
          );
    desired.set(key, {
      channel,
      targetId,
      targetType,
      bits: { ...old?.bits, ...bits },
    });
  }
  for (const binding of bindings)
    for (const id of binding.channelIds) {
      const channel = channels.find((c) => c.id === id);
      if (!channel || !channelKinds(binding.feature).includes(channel.type))
        throw new DomainError(
          "CHANNEL",
          `Choose an existing ${binding.feature} channel of the correct type.`,
          400,
        );
      const preset =
        settings.featureAccess[binding.feature] ||
        defaultAccess[binding.feature];
      if (!preset) continue;
      if (["registration", "onboarding_readme"].includes(binding.feature))
        continue;
      if (
        ["error_log", "audit_log", "system_status"].includes(binding.feature) &&
        preset !== "ADMINS"
      )
        throw new DomainError(
          "LOG_ACCESS",
          "Administrative log/status channels must use Administrators access.",
          400,
        );
      const allowed = new Set([
        ...(groups[preset] || []),
        ...settings.adminRoles,
      ]);
      if (binding.feature === "ta_voice") {
        if (!settings.taRole)
          throw new DomainError(
            "TA_ROLE",
            "Configure the TA role before binding inspection voice rooms.",
            400,
          );
        allowed.add(settings.taRole);
      }
      if (taViews(channel.id)) allowed.add(settings.taRole);
      if (
        preset !== "EVERYONE" &&
        !(groups[preset] || []).filter(Boolean).length
      )
        throw new DomainError(
          "ROLE",
          `Configure the ${preset.toLowerCase()} role before restricting #${channel.name}.`,
          400,
        );
      if (preset !== "EVERYONE")
        for (const overwrite of channel.permission_overwrites || []) {
          if (
            BigInt(overwrite.allow) & P.ViewChannel &&
            overwrite.id !== bot.id &&
            overwrite.id !== guildId &&
            !roleIds.includes(overwrite.id)
          )
            warnings.push(
              `#${channel.name}: unrelated explicit access for ${roles.find((r) => r.id === overwrite.id)?.name || overwrite.id} remains unchanged. Review access for unverified members.`,
            );
        }
      const voice = channel.type === 2;
      put(channel, guildId, 0, {
        ViewChannel: preset === "EVERYONE",
        ...(!voice && preset === "EVERYONE"
          ? { ReadMessageHistory: true }
          : {}),
        ...(voice ? { Connect: false } : {}),
      });
      for (const roleId of roleIds) {
        const view =
          binding.feature === "ta_voice" && roleId === settings.studentRole
            ? settings.studentVoiceVisible
            : preset === "EVERYONE" || allowed.has(roleId);
        const roleBits: Bits = {
          ViewChannel: view,
          ...(voice
            ? {
                ...(binding.feature === "ta_voice" &&
                (roleId === settings.studentRole ||
                  roleId === settings.taRole ||
                  settings.adminRoles.includes(roleId))
                  ? { Speak: true, UseVAD: true }
                  : {}),
                Connect:
                  binding.feature === "ta_voice"
                    ? roleId === settings.taRole ||
                      settings.adminRoles.includes(roleId)
                    : roleId === settings.taRole && taViews(channel.id)
                      ? settings.taStudentConnectChannels.includes(
                          channel.id,
                        ) ||
                        overwriteBits(channel, roleId, ["Connect"]).Connect ===
                          true
                      : view,
              }
            : { ...(view ? { ReadMessageHistory: true } : {}) }),
        };
        if (
          roleId === settings.taRole &&
          taViews(channel.id) &&
          voice &&
          !settings.taStudentConnectChannels.includes(channel.id) &&
          binding.feature !== "ta_voice"
        )
          roleBits.Connect = overwriteBits(channel, roleId, [
            "Connect",
          ]).Connect;
        put(channel, roleId, 0, roleBits);
      }
      put(channel, bot.id, 1, {
        ViewChannel: true,
        ReadMessageHistory: true,
        ...(voice
          ? { Connect: true, MoveMembers: true }
          : { SendMessages: true, EmbedLinks: true }),
      });
    }
  const visibility = [...settings.channelVisibility];
  for (const binding of bindings.filter((b) =>
    ["onboarding_readme", "registration"].includes(b.feature),
  ))
    for (const channelId of binding.channelIds)
      if (!visibility.some((r) => r.channelId === channelId))
        visibility.push({
          channelId,
          policy: "UNVERIFIED_ONLY",
          roleIds: [],
          deniedRoleIds: [],
          autoSync: true,
        });
  for (const rule of visibility) {
    if (
      privateChannelIds.includes(rule.channelId) &&
      !["SUPPORT", "ADMINS"].includes(rule.policy)
    )
      throw new DomainError(
        "PRIVATE_CHANNEL",
        "Private support tickets cannot use student/public visibility policies.",
        400,
      );
    const channel = channels.find((c) => c.id === rule.channelId);
    if (!channel || ![0, 2, 4, 5].includes(channel.type))
      throw new DomainError(
        "CHANNEL",
        "Choose an existing channel or category for visibility. Threads inherit their parent policy.",
        400,
      );
    const selected = rule.roleIds.length
      ? rule.roleIds
      : rule.policy === "UNVERIFIED_ONLY" || rule.policy === "STUDENTS"
        ? [settings.studentRole]
        : groups[rule.policy] || [];
    if (
      [...selected, ...rule.deniedRoleIds].some(
        (id) => !id || id === guildId || !roles.some((r) => r.id === id),
      )
    )
      throw new DomainError(
        "ROLE",
        "Choose existing visibility roles; configure the Student role for Unverified Only.",
        400,
      );
    if (!["EVERYONE", "ADMINS"].includes(rule.policy) && !selected.length)
      throw new DomainError(
        "ROLE",
        "Select roles for this visibility policy.",
        400,
      );
    const allowed = new Set([
      ...settings.adminRoles,
      ...(rule.policy === "UNVERIFIED_ONLY" ? [] : selected),
      ...(taViews(channel.id) ? [settings.taRole] : []),
    ]);
    put(channel, guildId, 0, {
      ViewChannel: ["EVERYONE", "UNVERIFIED_ONLY"].includes(rule.policy),
      ReadMessageHistory: true,
    });
    const targets = new Set([...roleIds, ...selected, ...rule.deniedRoleIds]);
    for (const id of targets)
      put(channel, id, 0, {
        ViewChannel:
          rule.policy === "EVERYONE" ||
          allowed.has(id) ||
          (rule.policy === "UNVERIFIED_ONLY" &&
            !selected.includes(id) &&
            !rule.deniedRoleIds.includes(id)),
      });
    put(channel, bot.id, 1, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: true,
      EmbedLinks: true,
    });
    if (rule.policy === "UNVERIFIED_ONLY") {
      for (const member of members) {
        if (!member.roles.some((id) => selected.includes(id))) continue;
        const exempt =
          member.user.id === ownerId ||
          member.roles.some(
            (id) =>
              settings.adminRoles.includes(id) ||
              !!(
                BigInt(roles.find((r) => r.id === id)?.permissions || "0") &
                P.Administrator
              ),
          );
        if (exempt) {
          warnings.push(
            `#${channel.name}: ${member.user.username || member.user.id} has administrator access and will remain visible.`,
          );
          continue;
        }
        if (
          effectiveView(
            guildId,
            applyPlannedBits(
              channel,
              [...desired.values()].map(
                (v) =>
                  ({
                    channelId: v.channel.id,
                    targetId: v.targetId,
                    targetType: v.targetType,
                    permissions: v.bits,
                  }) as AccessChange,
              ),
            ),
            roles,
            member,
            ownerId,
          )
        )
          warnings.push(
            `#${channel.name}: ${member.user.username || member.user.id} needs a managed member denial; another role/member allow overrides the Student-role denial.`,
          );
        put(channel, member.user.id, 1, { ViewChannel: false });
      }
      if (!rule.autoSync)
        warnings.push(
          `#${channel.name}: automatic sync is disabled. Role removals may require Sync Channel Visibility to restore managed member permissions.`,
        );
    }
  }
  for (const channel of channels.filter((c) => taViews(c.id))) {
    const key = channel.id + ":" + settings.taRole;
    const existing = desired.get(key);
    desired.set(key, {
      channel,
      targetId: settings.taRole,
      targetType: 0,
      bits: {
        ...existing?.bits,
        ViewChannel: true,
        ReadMessageHistory: true,
        ...(channel.type === 2 &&
        settings.taStudentConnectChannels.includes(channel.id)
          ? { Connect: true }
          : {}),
      },
    });
  }
  for (const channel of new Map(
    [...desired.values()].map((v) => [v.channel.id, v.channel]),
  ).values()) {
    const effective = effectivePermissions(
      guildId,
      channel,
      roles,
      { user: { id: bot.id }, roles: bot.roles },
      ownerId,
    );
    const required = P.ViewChannel | P.ManageRoles;
    if (!(effective & P.Administrator) && (effective & required) !== required)
      throw new DomainError(
        "BOT_PERMISSIONS",
        `Bot needs View Channel and Manage Roles in #${channel.name} before permission synchronization.`,
        400,
      );
  }
  const all = new Set([
    ...desired.keys(),
    ...managed.map((m) => m.channelId + ":" + m.targetId),
  ]);
  const changes: AccessChange[] = [];
  for (const key of [...all].sort()) {
    const want = desired.get(key),
      old = managed.find((m) => m.channelId + ":" + m.targetId === key);
    const channel =
      want?.channel || channels.find((c) => c.id === old?.channelId);
    if (!channel) {
      warnings.push(
        "A previously managed channel is missing; no Discord deletion or overwrite will be attempted.",
      );
      continue;
    }
    const targetId = want?.targetId || old!.targetId;
    if (
      targetId !== bot.id &&
      (want?.targetType ?? old!.targetType) === 0 &&
      !roles.some((r) => r.id === targetId)
    )
      continue;
    const previous = (old?.applied || {}) as Bits,
      original = (old?.original || {}) as Bits;
    const keys = [
      ...new Set([...Object.keys(previous), ...Object.keys(want?.bits || {})]),
    ];
    const before = overwriteBits(channel, targetId, keys),
      permissions: Bits = {},
      baseline: Bits = {};
    for (const name of keys) {
      if (want && name in want.bits) {
        permissions[name] = want.bits[name];
        baseline[name] = name in original ? original[name] : before[name];
      } else if (before[name] === previous[name])
        permissions[name] = original[name] ?? null;
      else
        warnings.push(
          `Preserving externally changed ${name} for ${targetId} in #${channel.name}.`,
        );
    }
    const parent = channels.find(
      (c) => c.id === channel.parent_id && c.type === 4,
    );
    const normalized = (c: AccessChannel) =>
      JSON.stringify(
        (c.permission_overwrites || [])
          .map((o) => [o.id, o.type, o.allow, o.deny])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      );
    const inheritedFrom =
      parent && normalized(parent) === normalized(channel)
        ? parent.id
        : undefined;
    changes.push({
      channelType: channel.type,
      ...(inheritedFrom ? { inheritedFrom } : {}),
      channelId: channel.id,
      channelName: channel.name,
      targetId,
      targetName:
        roles.find((r) => r.id === targetId)?.name ||
        members.find((m) => m.user.id === targetId)?.user.username ||
        (targetId === bot.id ? "Bot" : targetId),
      targetType: want?.targetType ?? old!.targetType,
      before,
      permissions,
      original: baseline,
      applied: want?.bits || {},
    });
  }
  const effective = visibility.flatMap((rule) => {
    const channel = channels.find((c) => c.id === rule.channelId)!;
    const patched = applyPlannedBits(channel, changes);
    return [
      {
        user: { id: "sample-unverified", username: "Sample @everyone" },
        roles: [],
      },
      {
        user: { id: "sample-student", username: "Sample Student role" },
        roles: [settings.studentRole],
      },
      {
        user: { id: "sample-ta", username: "TA role without Student role" },
        roles: [settings.taRole],
      },
      ...members,
    ].map((member) => ({
      channelId: channel.id,
      member: member.user.username || member.user.id,
      before: effectiveView(guildId, channel, roles, member, ownerId),
      after: effectiveView(guildId, patched, roles, member, ownerId),
      exempt:
        member.user.id === ownerId ||
        member.roles.some(
          (id) =>
            settings.adminRoles.includes(id) ||
            !!(
              BigInt(roles.find((r) => r.id === id)?.permissions || "0") &
              P.Administrator
            ),
        ),
    }));
  });
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ changes, visibility, effective }))
    .digest("hex");
  return { fingerprint, changes, warnings, effective };
}
export async function prepareAccess(
  guildId: string,
  read: (path: string) => Promise<unknown>,
  settings: Settings,
  bindings: { feature: string; channelIds: string[] }[],
) {
  const [channels, roles, bot, managed, tickets] = await Promise.all([
    read(`guilds/${guildId}/channels`),
    read(`guilds/${guildId}/roles`),
    read("users/@me"),
    db.managedPermission.findMany({ where: { guildId } }),
    db.supportTicket.findMany({
      where: { guildId, channelId: { not: null } },
      select: { channelId: true },
    }),
  ]);
  const user = bot as { id: string };
  const member = (await read(`guilds/${guildId}/members/${user.id}`)) as {
    roles: string[];
  };
  const needsMembers =
    settings.channelVisibility.some((r) => r.policy === "UNVERIFIED_ONLY") ||
    bindings.some(
      (b) =>
        ["onboarding_readme", "registration"].includes(b.feature) &&
        b.channelIds.length,
    );
  const members: AccessMember[] = [];
  let ownerId: string | undefined;
  if (needsMembers) {
    ownerId = ((await read(`guilds/${guildId}`)) as { owner_id: string })
      .owner_id;
    let after = "";
    for (let page = 0; page < 10; page++) {
      const batch = (await read(
        `guilds/${guildId}/members?limit=1000${after ? `&after=${after}` : ""}`,
      )) as AccessMember[];
      members.push(...batch);
      if (batch.length < 1000) break;
      after = batch[batch.length - 1].user.id;
      if (page === 9)
        throw new DomainError(
          "MEMBERS",
          "Visibility sync supports up to 10,000 members; reduce scope before syncing.",
        );
    }
  }
  return accessPlan(
    guildId,
    settings,
    bindings,
    channels as AccessChannel[],
    roles as AccessRole[],
    { ...user, roles: member.roles },
    managed,
    members,
    ownerId,
    tickets.map((t) => t.channelId!),
  );
}
export const accessSettingsKeys = [
  "studentRole",
  "taRole",
  "supportRoles",
  "adminRoles",
  "studentVoiceVisible",
  "channelVisibility",
  "featureAccess",
  "advancedPermissionsEnabled",
  "taStudentChannelAccess",
  "taStudentChannelExceptions",
  "taStudentConnectChannels",
] as const;
export function accessSettings(input: Settings) {
  return Object.fromEntries(accessSettingsKeys.map((k) => [k, input[k]]));
}
export async function rememberPermission(
  guildId: string,
  change: AccessChange,
) {
  await db.managedPermission.upsert({
    where: {
      guildId_channelId_targetId: {
        guildId,
        channelId: change.channelId,
        targetId: change.targetId,
      },
    },
    create: {
      guildId,
      channelId: change.channelId,
      targetId: change.targetId,
      targetType: change.targetType,
      original: change.original as Prisma.InputJsonValue,
      applied: change.applied as Prisma.InputJsonValue,
    },
    update: {
      original: change.original as Prisma.InputJsonValue,
      applied: change.applied as Prisma.InputJsonValue,
    },
  });
}

export function effectivePermissions(
  guildId: string,
  channel: AccessChannel,
  roles: AccessRole[],
  member: AccessMember,
  ownerId?: string,
) {
  let bits = roles
    .filter((r) => r.id === guildId || member.roles.includes(r.id))
    .reduce((n, r) => n | BigInt(r.permissions), 0n);
  if (member.user.id === ownerId || bits & P.Administrator)
    return bits | P.Administrator | P.ViewChannel;
  const overwrites = channel.permission_overwrites || [];
  const everyone = overwrites.find((o) => o.id === guildId);
  if (everyone) bits = (bits & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
  const selected = overwrites.filter(
    (o) => o.type === 0 && o.id !== guildId && member.roles.includes(o.id),
  );
  bits =
    (bits & ~selected.reduce((n, o) => n | BigInt(o.deny), 0n)) |
    selected.reduce((n, o) => n | BigInt(o.allow), 0n);
  const own = overwrites.find((o) => o.type === 1 && o.id === member.user.id);
  if (own) bits = (bits & ~BigInt(own.deny)) | BigInt(own.allow);
  return bits;
}
export function applyPlannedBits(
  channel: AccessChannel,
  changes: AccessChange[],
): AccessChannel {
  const overwrites = (channel.permission_overwrites || []).map((o) => ({
    ...o,
  }));
  for (const change of changes.filter((c) => c.channelId === channel.id)) {
    let entry = overwrites.find((o) => o.id === change.targetId);
    if (!entry) {
      entry = {
        id: change.targetId,
        type: change.targetType,
        allow: "0",
        deny: "0",
      };
      overwrites.push(entry);
    }
    let allow = BigInt(entry.allow),
      deny = BigInt(entry.deny);
    for (const [key, value] of Object.entries(change.permissions)) {
      const bit = P[key as keyof typeof P];
      allow &= ~bit;
      deny &= ~bit;
      if (value === true) allow |= bit;
      if (value === false) deny |= bit;
    }
    entry.allow = String(allow);
    entry.deny = String(deny);
  }
  return { ...channel, permission_overwrites: overwrites };
}

export function effectiveView(
  guildId: string,
  channel: AccessChannel,
  roles: AccessRole[],
  member: AccessMember,
  ownerId?: string,
) {
  return !!(
    effectivePermissions(guildId, channel, roles, member, ownerId) &
    P.ViewChannel
  );
}
