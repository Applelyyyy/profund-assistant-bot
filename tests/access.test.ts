import { test, expect, vi } from "vitest";
import { PermissionFlagsBits as P } from "discord.js";
import {
  accessPlan,
  overwriteBits,
  AccessChannel,
} from "../packages/config/src/access";
import { settingsSchema } from "../packages/shared/src/index";
import { PanelSyncScheduler } from "../apps/bot/src/panel-sync";
const guild = "100000000000000001",
  student = "100000000000000002",
  ta = "100000000000000003",
  bot = "100000000000000004",
  admin = "100000000000000005";
const roles = [
  { id: guild, name: "@everyone", permissions: "0", position: 0 },
  { id: student, name: "Student", permissions: "0", position: 1 },
  { id: ta, name: "TA", permissions: "0", position: 2 },
  { id: admin, name: "Admin", permissions: "8", position: 10 },
];
const settings = settingsSchema.parse({
  studentRole: student,
  taRole: ta,
  adminRoles: [admin],
});
const member = { id: bot, roles: [admin] };
const channel = (id: string, type = 0): AccessChannel => ({
  id,
  name: id,
  type,
  permission_overwrites: [],
});
test("public verification, restricted student/TA rooms and safe baseline @everyone permissions", () => {
  const plan = accessPlan(
    guild,
    settings,
    [
      { feature: "registration", channelIds: ["verify"] },
      { feature: "student_queue", channelIds: ["queue"] },
      { feature: "ta_dashboard", channelIds: ["ta"] },
      { feature: "ta_voice", channelIds: ["voice"] },
    ],
    [channel("verify"), channel("queue"), channel("ta"), channel("voice", 2)],
    roles,
    member,
    [],
  );
  const find = (id: string, target: string) =>
    plan.changes.find((c) => c.channelId === id && c.targetId === target)!;
  expect(find("verify", guild).permissions.ViewChannel).toBe(true);
  expect(find("verify", guild).permissions.ReadMessageHistory).toBe(true);
  expect(find("queue", guild).permissions.ViewChannel).toBe(false);
  expect(find("queue", student).permissions.ViewChannel).toBe(true);
  expect(find("ta", student).permissions.ViewChannel).toBe(false);
  expect(find("ta", ta).permissions.ViewChannel).toBe(true);
  expect(find("voice", student).permissions).toMatchObject({
    ViewChannel: true,
    Connect: false,
    Speak: true,
    UseVAD: true,
  });
  expect(find("voice", guild).permissions.Connect).toBe(false);
  expect(find("voice", ta).permissions.Connect).toBe(true);
  expect(find("ta", admin).permissions.ViewChannel).toBe(true);
  expect(find("queue", bot).permissions.ViewChannel).toBe(true);
});
test("permission previews reject mismatched roles, channels, bot authority and conflicting feature access", () => {
  const create = (
    s = settings,
    b = [{ feature: "registration", channelIds: ["verify"] }],
    r = roles,
    m = member,
    c = [channel("verify")],
  ) => accessPlan(guild, s, b, c, r, m, []);
  expect(() => create({ ...settings, studentRole: guild })).toThrow(
    "@everyone",
  );
  expect(() => create({ ...settings, studentRole: ta })).toThrow(
    "different roles",
  );
  expect(() =>
    create(
      settings,
      undefined,
      roles.map((r) => (r.id === student ? { ...r, permissions: "8" } : r)),
    ),
  ).toThrow("must not grant");
  expect(() =>
    create(settings, undefined, undefined, { id: bot, roles: [ta] }),
  ).toThrow("Manage Roles");
  expect(() =>
    create(settings, [{ feature: "waiting_voice", channelIds: ["verify"] }]),
  ).toThrow("correct type");
  const unverified = create({
    ...settings,
    featureAccess: { registration: "STUDENTS" },
  });
  expect(
    unverified.changes.find(
      (c) => c.channelId === "verify" && c.targetId === guild,
    )?.permissions.ViewChannel,
  ).toBe(true);
  expect(
    unverified.changes.find(
      (c) => c.channelId === "verify" && c.targetId === student,
    )?.permissions.ViewChannel,
  ).toBe(false);
  expect(() =>
    create(settings, [
      { feature: "registration", channelIds: ["verify"] },
      { feature: "ta_dashboard", channelIds: ["verify"] },
    ]),
  ).toThrow("conflicting");
});
test("removing managed access restores original bits and preserves external and unrelated overrides", () => {
  const c = channel("queue");
  c.permission_overwrites = [
    {
      id: student,
      type: 0,
      allow: (P.ViewChannel | P.AttachFiles).toString(),
      deny: "0",
    },
    { id: "unrelated", type: 1, allow: P.SendMessages.toString(), deny: "0" },
  ];
  const plan = accessPlan(guild, settings, [], [c], roles, member, [
    {
      channelId: "queue",
      targetId: student,
      targetType: 0,
      original: { ViewChannel: null },
      applied: { ViewChannel: true },
    },
  ]);
  expect(plan.changes[0].permissions).toEqual({ ViewChannel: null });
  expect(plan.changes[0].applied).toEqual({});
  expect(overwriteBits(c, student, ["AttachFiles"])).toEqual({
    AttachFiles: true,
  });
  expect(c.permission_overwrites).toHaveLength(2);
  c.permission_overwrites[0].allow = P.AttachFiles.toString();
  c.permission_overwrites[0].deny = P.ViewChannel.toString();
  const changed = accessPlan(guild, settings, [], [c], roles, member, [
    {
      channelId: "queue",
      targetId: student,
      targetType: 0,
      original: { ViewChannel: null },
      applied: { ViewChannel: true },
    },
  ]);
  expect(changed.changes[0].permissions).toEqual({});
  expect(changed.warnings.join(" ")).toContain("externally changed");
});
test("panel events debounce, periodic reconciliation checks existing messages and settings reload without a second timer", async () => {
  const sync = vi.fn(async () => {}),
    scheduler = new PanelSyncScheduler(sync);
  const s = { ...settings, embedAutoRefreshEnabled: false };
  await scheduler.tick(s, 1, 100);
  await scheduler.tick(s, 2, 500);
  await scheduler.tick(s, 3, 1599);
  expect(sync).not.toHaveBeenCalled();
  await scheduler.tick(s, 3, 1600);
  expect(sync).toHaveBeenCalledExactlyOnceWith(false);
  await scheduler.tick(s, 3, 100000);
  expect(sync).toHaveBeenCalledTimes(1);
  await scheduler.tick(
    { ...s, embedAutoRefreshEnabled: true, embedRefreshIntervalSeconds: 5 },
    3,
    100001,
  );
  expect(sync).toHaveBeenLastCalledWith(true);
  scheduler.request(101000, 100);
  await scheduler.tick(s, 3, 101100);
  expect(sync).toHaveBeenCalledTimes(3);
});
test("panel scheduler retains requests during an active sync and retries a failed synchronization", async () => {
  let resolve: () => void = () => {};
  const sync = vi.fn(
    () =>
      new Promise<void>((r) => {
        resolve = r;
      }),
  );
  const scheduler = new PanelSyncScheduler(sync);
  const s = {
    ...settings,
    embedAutoRefreshEnabled: false,
    embedUpdateDebounceMs: 100,
  };
  await scheduler.tick(s, 1, 0);
  const pending = scheduler.tick(s, 1, 100);
  scheduler.request(150, 100);
  resolve();
  await pending;
  const again = scheduler.tick(s, 1, 250);
  expect(sync).toHaveBeenCalledTimes(2);
  resolve();
  await again;
  const failure = vi
    .fn()
    .mockRejectedValueOnce(new Error("Discord unavailable"))
    .mockResolvedValue(undefined);
  const retry = new PanelSyncScheduler(failure);
  await retry.tick(s, 1, 0);
  await expect(retry.tick(s, 1, 100)).rejects.toThrow("Discord unavailable");
  await retry.tick(s, 1, 200);
  expect(failure).toHaveBeenCalledTimes(2);
});
test("TA room visibility can be hidden while TA Connect remains available for every visibility preset", () => {
  const plan = accessPlan(
    guild,
    {
      ...settings,
      studentVoiceVisible: false,
      featureAccess: { ta_voice: "EVERYONE" },
    },
    [{ feature: "ta_voice", channelIds: ["voice"] }],
    [channel("voice", 2)],
    roles,
    member,
    [],
  );
  expect(
    plan.changes.find((c) => c.targetId === student)?.permissions,
  ).toMatchObject({ ViewChannel: false, Connect: false });
  expect(
    plan.changes.find((c) => c.targetId === ta)?.permissions,
  ).toMatchObject({ ViewChannel: true, Connect: true });
});

test("Unverified Only uses member denial for conflicting roles and restores managed denial after Student role removal", async () => {
  const { effectiveView, applyPlannedBits } =
    await import("../packages/config/src/access");
  const extra = "100000000000000020",
    person = "100000000000000021";
  const readme = channel("100000000000000022");
  readme.permission_overwrites = [
    { id: extra, type: 0, allow: String(P.ViewChannel), deny: "0" },
    { id: person, type: 1, allow: String(P.SendMessages), deny: "0" },
  ];
  const selected = {
    ...settings,
    channelVisibility: [
      {
        channelId: readme.id,
        policy: "UNVERIFIED_ONLY" as const,
        roleIds: [],
        deniedRoleIds: [],
        autoSync: true,
      },
    ],
  };
  const extended = [
    ...roles,
    { id: extra, name: "Extra", permissions: "0", position: 1 },
  ];
  const actual = {
    user: { id: person, username: "Verified" },
    roles: [student, extra],
  };
  const plan = accessPlan(
    guild,
    selected,
    [],
    [readme],
    extended,
    member,
    [],
    [actual],
  );
  expect(
    effectiveView(
      guild,
      applyPlannedBits(readme, plan.changes),
      extended,
      actual,
    ),
  ).toBe(false);
  expect(
    effectiveView(guild, applyPlannedBits(readme, plan.changes), extended, {
      user: { id: "unverified" },
      roles: [],
    }),
  ).toBe(true);
  expect(plan.warnings.some((w) => w.includes("managed member denial"))).toBe(
    true,
  );
  const changed = applyPlannedBits(readme, plan.changes);
  expect(
    BigInt(changed.permission_overwrites!.find((o) => o.id === person)!.allow) &
      P.SendMessages,
  ).toBe(P.SendMessages);
  const managed = plan.changes.map((c) => ({
    ...c,
    original: c.original,
    applied: c.applied,
  }));
  const restore = accessPlan(
    guild,
    selected,
    [],
    [changed],
    extended,
    member,
    managed,
    [{ ...actual, roles: [extra] }],
  );
  expect(
    effectiveView(guild, applyPlannedBits(changed, restore.changes), extended, {
      ...actual,
      roles: [extra],
    }),
  ).toBe(true);
  expect(
    restore.changes.find((c) => c.targetId === person)!.permissions.ViewChannel,
  ).toBe(null);
});
test("README administrators remain visible and standalone policies validate bot permissions", () => {
  const readme = channel("100000000000000030");
  const rule = {
    channelId: readme.id,
    policy: "UNVERIFIED_ONLY" as const,
    roleIds: [],
    deniedRoleIds: [],
    autoSync: true,
  };
  const plan = accessPlan(
    guild,
    { ...settings, channelVisibility: [rule] },
    [],
    [readme],
    roles,
    member,
    [],
    [{ user: { id: "owner" }, roles: [student, admin] }],
  );
  expect(plan.effective?.find((r) => r.member === "owner")).toMatchObject({
    after: true,
    exempt: true,
  });
  expect(() =>
    accessPlan(
      guild,
      { ...settings, channelVisibility: [rule] },
      [],
      [readme],
      roles,
      { id: bot, roles: [ta] },
      [],
    ),
  ).toThrow("Bot needs");
});

test("README and registration default to Unverified Only while public support remains available", async () => {
  const { effectiveView, applyPlannedBits } =
    await import("../packages/config/src/access");
  const person = "100000000000000030",
    extra = "100000000000000031";
  const channels = [
    channel("readme"),
    channel("registration"),
    channel("queue"),
    channel("support"),
  ];
  channels[1].permission_overwrites = [
    { id: extra, type: 0, allow: String(P.ViewChannel), deny: "0" },
  ];
  const actual = { user: { id: person }, roles: [student, extra] };
  const extended = [
    ...roles,
    { id: extra, name: "Extra", permissions: "0", position: 1 },
  ];
  const plan = accessPlan(
    guild,
    { ...settings, featureAccess: { support: "EVERYONE" } },
    [
      { feature: "onboarding_readme", channelIds: ["readme"] },
      { feature: "registration", channelIds: ["registration"] },
      { feature: "student_queue", channelIds: ["queue"] },
      { feature: "support", channelIds: ["support"] },
    ],
    channels,
    extended,
    member,
    [],
    [actual],
  );
  const view = (id: string, target = actual) =>
    effectiveView(
      guild,
      applyPlannedBits(channels.find((c) => c.id === id)!, plan.changes),
      extended,
      target,
    );
  expect(view("registration")).toBe(false);
  expect(view("readme")).toBe(false);
  expect(view("queue")).toBe(true);
  expect(view("support")).toBe(true);
  const unverified = { user: { id: "new-unverified" }, roles: [] };
  expect(view("registration", unverified)).toBe(true);
  expect(view("readme", unverified)).toBe(true);
  expect(view("queue", unverified)).toBe(false);
  expect(view("support", unverified)).toBe(true);
  expect(
    view("registration", { user: { id: "owner" }, roles: [student, admin] }),
  ).toBe(true);
  const override = accessPlan(
    guild,
    {
      ...settings,
      channelVisibility: [
        {
          channelId: "registration",
          policy: "EVERYONE",
          roleIds: [],
          deniedRoleIds: [],
          autoSync: true,
        },
      ],
    },
    [{ feature: "registration", channelIds: ["registration"] }],
    [channels[1]],
    extended,
    member,
    [],
    [actual],
  );
  expect(
    effectiveView(
      guild,
      applyPlannedBits(channels[1], override.changes),
      extended,
      actual,
    ),
  ).toBe(true);
});

test("TA student-channel access grants only visibility/history, protects private resources and honors exceptions", () => {
  const channels = [
    channel("queue"),
    channel("waiting", 2),
    channel("coursework"),
    channel("ticket"),
    channel("log"),
    channel("staff"),
  ];
  const configured = settingsSchema.parse({
    ...settings,
    channelVisibility: [
      { channelId: "100000000000000099", policy: "STUDENTS" },
    ],
  });
  // Pure planner fixture IDs can be human-readable; validated settings IDs use actual snowflake-shaped values.
  const config = {
    ...configured,
    channelVisibility: [
      {
        channelId: "coursework",
        policy: "STUDENTS" as const,
        roleIds: [],
        deniedRoleIds: [],
        autoSync: true,
      },
      {
        channelId: "staff",
        policy: "SUPPORT" as const,
        roleIds: [admin],
        deniedRoleIds: [],
        autoSync: true,
      },
    ],
  };
  const bindings = [
    { feature: "student_queue", channelIds: ["queue"] },
    { feature: "waiting_voice", channelIds: ["waiting"] },
    { feature: "error_log", channelIds: ["log"] },
  ];
  const plan = accessPlan(
    guild,
    config,
    bindings,
    channels,
    roles,
    member,
    [],
    [],
    undefined,
    ["ticket"],
  );
  const find = (id: string) =>
    plan.changes.find((c) => c.channelId === id && c.targetId === ta);
  expect(find("queue")?.permissions.ViewChannel).toBe(true);
  expect(find("coursework")?.permissions.ViewChannel).toBe(true);
  expect(find("waiting")?.permissions.ViewChannel).toBe(true);
  expect(find("waiting")?.permissions.Connect).not.toBe(true);
  expect(find("ticket")?.permissions.ViewChannel).not.toBe(true);
  expect(find("log")?.permissions.ViewChannel).toBe(false);
  expect(find("staff")?.permissions.ViewChannel).toBe(false);
  expect(
    plan.changes
      .filter((c) => c.targetId === ta)
      .some(
        (c) =>
          "ManageMembers" in c.permissions || "MuteMembers" in c.permissions,
      ),
  ).toBe(false);
  const except = accessPlan(
    guild,
    { ...config, taStudentChannelExceptions: ["queue"] },
    bindings,
    channels,
    roles,
    member,
    [],
    [],
    undefined,
    ["ticket"],
  );
  expect(
    except.changes.find((c) => c.channelId === "queue" && c.targetId === ta)
      ?.permissions.ViewChannel,
  ).toBe(false);
  const connect = accessPlan(
    guild,
    { ...config, taStudentConnectChannels: ["waiting"] },
    bindings,
    channels,
    roles,
    member,
    [],
    [],
    undefined,
    ["ticket"],
  );
  expect(
    connect.changes.find((c) => c.channelId === "waiting" && c.targetId === ta)
      ?.permissions.Connect,
  ).toBe(true);
});

test("TA visibility preserves an existing waiting Connect restriction, even when an earlier sync originally allowed it", () => {
  const waiting = channel("100000000000000006", 2);
  waiting.permission_overwrites = [
    {
      id: ta,
      type: 0,
      allow: "0",
      deny: (P.ViewChannel | P.Connect).toString(),
    },
  ];
  const plan = accessPlan(
    guild,
    settings,
    [{ feature: "waiting_voice", channelIds: [waiting.id] }],
    [waiting],
    roles,
    member,
    [
      {
        channelId: waiting.id,
        targetId: ta,
        targetType: 0,
        original: { ViewChannel: null, Connect: true },
        applied: { ViewChannel: false, Connect: false },
      },
    ],
  );
  const change = plan.changes.find(
    (c) => c.channelId === waiting.id && c.targetId === ta,
  )!;
  expect(change.permissions.ViewChannel).toBe(true);
  expect(change.permissions.Connect).toBe(false);
  expect(change.permissions).not.toHaveProperty("MuteMembers");
});
