import { PermissionFlagsBits as P, Routes } from "discord.js";
import { db } from "../../../packages/database/src/index";
import {
  AccessChange,
  AccessChannel,
  overwriteBits,
  rememberPermission,
} from "../../../packages/config/src/access";
import { DomainError } from "../../../packages/shared/src/index";
import { context, rest } from "./discord";

export async function applyAccess(guildId: string, changes: AccessChange[]) {
  await context(guildId);
  const applied = new Set<string>();
  // Categories propagate to synced children. Accept only the parent bits this same approved operation applied.
  for (const change of [...changes].sort(
    (a, b) => Number(b.channelType === 4) - Number(a.channelType === 4),
  )) {
    const parent =
      change.inheritedFrom &&
      applied.has(`${change.inheritedFrom}:${change.targetId}`)
        ? changes.find(
            (c) =>
              c.channelId === change.inheritedFrom &&
              c.targetId === change.targetId,
          )
        : undefined;
    const channel = (await rest.get(
      Routes.channel(change.channelId),
    )) as AccessChannel;
    const keys = Object.keys(change.permissions);
    const actual = overwriteBits(channel, change.targetId, keys);
    for (const key of keys)
      if (
        actual[key] !== change.before[key] &&
        actual[key] !== change.permissions[key] &&
        !(
          parent &&
          key in parent.permissions &&
          actual[key] === parent.permissions[key]
        )
      )
        throw new DomainError(
          "PERMISSION_CHANGED",
          `#${change.channelName} permissions changed after preview. Preview and sync again.`,
        );
    const existing = channel.permission_overwrites?.find(
      (o) => o.id === change.targetId,
    );
    let allow = BigInt(existing?.allow || 0),
      deny = BigInt(existing?.deny || 0);
    for (const [key, value] of Object.entries(change.permissions)) {
      const bit = P[key as keyof typeof P];
      if (!bit)
        throw new DomainError("PERMISSION", "Unsupported managed permission.");
      allow &= ~bit;
      deny &= ~bit;
      if (value === true) allow |= bit;
      if (value === false) deny |= bit;
    }
    // Persist original bits before Discord writes so an interrupted sync can safely resume.
    await rememberPermission(guildId, change);
    if (
      allow !== BigInt(existing?.allow || 0) ||
      deny !== BigInt(existing?.deny || 0)
    )
      await rest.put(
        Routes.channelPermission(change.channelId, change.targetId),
        {
          body: {
            type: change.targetType,
            allow: allow.toString(),
            deny: deny.toString(),
          },
          reason: "Profun Roles & Access: approved permission preview",
        },
      );
    applied.add(`${change.channelId}:${change.targetId}`);
    if (!Object.keys(change.applied).length)
      await db.managedPermission.deleteMany({
        where: {
          guildId,
          channelId: change.channelId,
          targetId: change.targetId,
        },
      });
  }
}

let visibilityFlight: Promise<void> | undefined;
let visibilityDirty = false;
let manualVisibility = false;
let studentVisibility = false;
export function syncChannelVisibility(
  guildId: string,
  manual = false,
  includeStudentAccess = false,
) {
  studentVisibility ||= includeStudentAccess;
  manualVisibility ||= manual;
  visibilityDirty = true;
  return (visibilityFlight ??= (async () => {
    while (visibilityDirty) {
      visibilityDirty = false;
      const force = manualVisibility;
      const assistance = studentVisibility;
      studentVisibility = false;
      manualVisibility = false;
      const ctx = await context(guildId);
      const ids = new Set(
        ctx.settings.channelVisibility
          .filter((r) => r.autoSync || force)
          .map((r) => r.channelId),
      );
      for (const id of [
        ...ctx.channels("onboarding_readme"),
        ...ctx.channels("registration"),
      ])
        if (
          force ||
          !ctx.settings.channelVisibility.some(
            (r) => r.channelId === id && !r.autoSync,
          )
        )
          ids.add(id);
      const allBindings = await db.channelBinding.findMany({
        where: { guildId },
      });
      for (const binding of assistance &&
      ctx.settings.studentRole &&
      ctx.settings.taRole
        ? allBindings
        : [])
        if (
          ["student_queue", "public_queue", "waiting_voice"].includes(
            binding.feature,
          ) ||
          (ctx.settings.featureAccess[binding.feature] ||
            (await import("../../../packages/shared/src/index")).defaultAccess[
              binding.feature
            ]) === "STUDENTS"
        )
          for (const id of binding.channelIds)
            if (
              !ctx.settings.channelVisibility.some(
                (r) => r.channelId === id && !r.autoSync,
              ) ||
              force
            )
              ids.add(id);
      if (!ids.size) return;
      const { prepareAccess } =
        await import("../../../packages/config/src/access");
      const bindings = await db.channelBinding.findMany({ where: { guildId } });
      const plan = await prepareAccess(
        guildId,
        (path) => rest.get(`/${path}`),
        ctx.settings,
        assistance && ctx.settings.studentRole && ctx.settings.taRole
          ? bindings
          : bindings.filter((b) =>
              ["onboarding_readme", "registration"].includes(b.feature),
            ),
      );
      await applyAccess(
        guildId,
        plan.changes.filter(
          (c) =>
            ids.has(c.channelId) &&
            (c.targetId === ctx.settings.taRole ||
              ctx.settings.channelVisibility.some(
                (r) => r.channelId === c.channelId,
              ) ||
              [
                ...ctx.channels("onboarding_readme"),
                ...ctx.channels("registration"),
              ].includes(c.channelId)),
        ),
      );
    }
  })().finally(() => {
    visibilityFlight = undefined;
  }));
}
