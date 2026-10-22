import { beforeAll, afterAll, beforeEach, test, expect, vi } from "vitest";
import type { Guild, GuildMember, Collection, OAuth2Guild } from "discord.js";
import {
  PermissionFlagsBits,
  Collection as DiscordCollection,
} from "discord.js";
import { randomUUID } from "node:crypto";
import type { Interaction } from "../apps/bot/src/interactions";
import { db } from "../packages/database/src/index";
import { env } from "../packages/config/src/index";
import { settingsSchema } from "../packages/shared/src/index";
import {
  startSession,
  admission,
  claimNext,
  completeInspection,
} from "../packages/queue-engine/src/index";
import {
  client,
  rest,
  processTransfer,
  waitingMute,
  cleanupMute,
  register,
  createSupportChannel,
  supportAction,
  cleanupSupportTicket,
} from "../apps/bot/src/discord";
const guildId = env().DISCORD_GUILD_ID;
const studentRole = "100000000000000002";
const taRole = "100000000000000003";
const staffRole = "100000000000000004";
let counter = 0;
const channels = new DiscordCollection();
const members = new Map();
const guild = {
  id: guildId,
  available: true,
  voiceStates: { cache: new Map() },
  members: {
    fetch: vi.fn(async (id: string) => {
      const m = members.get(id);
      if (!m) throw new Error("Member left");
      return m;
    }),
    fetchMe: vi.fn(async () => ({
      permissions: { has: () => true },
      roles: { highest: { position: 10 } },
    })),
  },
  roles: { fetch: vi.fn(async () => ({ id: studentRole, position: 1 })) },
  channels: {
    fetch: vi.fn(async (id?: string) => (id ? channels.get(id) : channels)),
    create: vi.fn(async (options: Record<string, unknown>) => {
      const channel = {
        id: `support-${Date.now()}-${++counter}`,
        type: 0,
        topic: options.topic,
        send: vi.fn(async () => ({ id: "message" })),
        delete: vi.fn(async () => {
          channels.delete(channel.id);
        }),
        permissionOverwrites: { edit: vi.fn() },
        messages: { fetch: vi.fn(async () => new DiscordCollection()) },
      };
      channels.set(channel.id, channel);
      return channel;
    }),
  },
  fetchAuditLogs: vi.fn(),
};
function member(id: string, channelId: string | null, role = studentRole) {
  const data = {
    id,
    guild,
    displayName: "Test member",
    manageable: true,
    permissions: { has: () => false },
    roles: { cache: new Map([[role, true]]), add: vi.fn() },
    setNickname: vi.fn(),
    send: vi.fn(async () => ({})),
    voice: {
      channelId,
      serverMute: false,
      channel: { permissionsFor: () => ({ has: () => true }) },
      setMute: vi.fn(async (value: boolean) => {
        data.voice.serverMute = value;
      }),
      disconnect: vi.fn(async () => {
        data.voice.channelId = null;
      }),
      setChannel: vi.fn(async (channel: { id: string }) => {
        data.voice.channelId = channel.id;
      }),
    },
  };
  members.set(id, data);
  return data;
}
beforeAll(async () => {
  if (
    !process.env.TEST_DATABASE_URL ||
    !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
  )
    throw new Error("Use a dedicated test database ending in _test.");
  await db.guild.upsert({
    where: { id: guildId },
    create: {
      id: guildId,
      name: "Discord Adapter Test",
      settings: settingsSchema.parse({
        minCapacity: 1,
        defaultCapacity: 1,
        studentRole,
        taRole,
        supportRoles: [staffRole],
      }),
    },
    update: {
      settings: settingsSchema.parse({
        minCapacity: 1,
        defaultCapacity: 1,
        studentRole,
        taRole,
        supportRoles: [staffRole],
      }),
    },
  });
  await db.channelBinding.upsert({
    where: { guildId_feature: { guildId, feature: "waiting_voice" } },
    create: { guildId, feature: "waiting_voice", channelIds: ["waiting"] },
    update: {},
  });
  await db.channelBinding.upsert({
    where: { guildId_feature: { guildId, feature: "ticket_category" } },
    create: { guildId, feature: "ticket_category", channelIds: ["category"] },
    update: {},
  });
  vi.spyOn(client.guilds, "fetch").mockResolvedValue(
    guild as unknown as Collection<string, OAuth2Guild>,
  );
  Object.defineProperty(client, "user", {
    value: { id: "bot" },
    configurable: true,
  });
});
async function resetQueue() {
  if (
    !process.env.TEST_DATABASE_URL ||
    !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
  )
    throw new Error(
      "Refusing queue cleanup outside a dedicated test database.",
    );
  // Each adapter test uses the configured guild; clear only its synthetic queue state in this dedicated test database.
  await db.inspectionCompletion.deleteMany({ where: { ticket: { guildId } } });
  await db.voiceTransferOperation.deleteMany({
    where: { ticket: { guildId } },
  });
  await db.inspection.deleteMany({ where: { ticket: { guildId } } });
  await db.queueReservation.deleteMany({ where: { ticket: { guildId } } });
  await db.queueTicket.deleteMany({ where: { guildId } });
  await db.tASession.deleteMany({ where: { guildId } });
  const arrivals = await db.systemEvent.findMany({
    where: { guildId, type: "transfer.succeeded" },
    select: { id: true },
  });
  await db.notificationDelivery.deleteMany({
    where: { eventId: { in: arrivals.map((e) => e.id) } },
  });
  await db.systemEvent.deleteMany({
    where: { id: { in: arrivals.map((e) => e.id) } },
  });
}
beforeEach(async () => {
  vi.spyOn(rest, "get").mockResolvedValue([]);
  guild.available = true;
  await resetQueue();
  channels.set("category", { id: "category", type: 4 });
  guild.fetchAuditLogs.mockReset();
});
afterAll(async () => {
  await resetQueue();
  await db.$disconnect();
});
async function transferFixture(reset = true) {
  if (reset) await resetQueue();
  const n = `${Date.now()}-${++counter}`;
  const taId = `ta-${n}`;
  const studentId = `student-${n}`;
  const target = `voice-${n}`;
  channels.set(target, {
    id: target,
    type: 2,
    permissionsFor: () => ({ has: () => true }),
    send: vi.fn(),
    guild,
  });
  member(taId, target, taRole);
  const user = member(studentId, "waiting");
  const course = await db.coursework.create({ data: { guildId, name: n } });
  await db.student.create({
    data: {
      guildId,
      studentId: n,
      name: "Test",
      lastname: "Student",
      discordId: studentId,
      registration: "REGISTERED",
    },
  });
  const session = await startSession(guildId, taId, n, {
    taName: n,
    voiceChannelId: target,
    capacity: 1,
    courseworkIds: [course.id],
    roleIds: [taRole],
    note: "",
  });
  await db.channelBinding.upsert({
    where: { guildId_feature: { guildId, feature: "ta_voice" } },
    create: { guildId, feature: "ta_voice", channelIds: [target] },
    update: { channelIds: [target] },
  });
  const ticket = await admission(guildId, studentId, n, course.id);
  const claim = await claimNext(guildId, taId, n);
  return { user, ta: members.get(taId), session, target, ticket, claim };
}
test("voice move reaches exact room; restart observes success without a second move", async () => {
  const f = await transferFixture();
  await processTransfer(f.claim.operationId);
  expect(f.user.voice.setChannel).toHaveBeenCalledTimes(1);
  expect(f.user.voice.channelId).toBe(f.target);
  expect(
    (await db.queueTicket.findUniqueOrThrow({ where: { id: f.ticket.id } }))
      .status,
  ).toBe("IN_PROGRESS");
  await processTransfer(f.claim.operationId);
  expect(f.user.voice.setChannel).toHaveBeenCalledTimes(1);
  expect(await db.inspection.count({ where: { ticketId: f.ticket.id } })).toBe(
    1,
  );
  const g = await transferFixture();
  g.user.voice.channelId = g.target;
  g.ta.voice.channelId = null;
  await processTransfer(g.claim.operationId);
  expect(g.user.voice.setChannel).not.toHaveBeenCalled();
  expect(
    (await db.queueTicket.findUniqueOrThrow({ where: { id: g.ticket.id } }))
      .status,
  ).toBe("IN_PROGRESS");
});
test("TA departure, student departure, missing room and API failure retain reservations", async () => {
  const cases = ["ta_left", "student_left", "missing_room", "api_failure"];
  for (const kind of cases) {
    const f = await transferFixture();
    if (kind === "ta_left") f.ta.voice.channelId = null;
    if (kind === "student_left") f.user.voice.channelId = null;
    if (kind === "missing_room") channels.delete(f.target);
    if (kind === "api_failure")
      f.user.voice.setChannel.mockRejectedValueOnce(
        new Error("Discord unavailable"),
      );
    await processTransfer(f.claim.operationId);
    expect(
      await db.queueReservation.count({ where: { ticketId: f.ticket.id } }),
    ).toBe(1);
    expect(
      (await db.queueTicket.findUniqueOrThrow({ where: { id: f.ticket.id } }))
        .status,
    ).toBe(kind === "api_failure" ? "NEEDS_REVIEW" : "MOVE_FAILED");
  }
});
test("owned mute cleanup preserves external moderation mutes", async () => {
  const settings = settingsSchema.parse({ autoMute: true, studentRole });
  const user = member(`mute-${randomUUID()}`, "waiting");
  await waitingMute(user as unknown as GuildMember, settings);
  expect(user.voice.serverMute).toBe(true);
  guild.fetchAuditLogs.mockResolvedValueOnce({
    entries: new DiscordCollection([
      [
        "entry",
        {
          targetId: user.id,
          executorId: "bot",
          createdTimestamp: Date.now(),
          changes: [{ key: "mute" }],
        },
      ],
    ]),
  });
  await cleanupMute(user as unknown as GuildMember, settings);
  expect(user.voice.serverMute).toBe(false);
  user.voice.serverMute = true;
  await waitingMute(user as unknown as GuildMember, settings);
  expect(
    await db.muteOwnership.findUnique({
      where: { guildId_discordId: { guildId, discordId: user.id } },
    }),
  ).toBeNull();
  await db.muteOwnership.create({
    data: { guildId, discordId: user.id, state: "OWNED" },
  });
  guild.fetchAuditLogs.mockResolvedValueOnce({
    entries: new DiscordCollection([
      [
        "entry",
        {
          targetId: user.id,
          executorId: "moderator",
          createdTimestamp: Date.now(),
          changes: [{ key: "mute" }],
        },
      ],
    ]),
  });
  await cleanupMute(user as unknown as GuildMember, settings);
  expect(user.voice.serverMute).toBe(true);
  expect(
    (
      await db.muteOwnership.findUniqueOrThrow({
        where: { guildId_discordId: { guildId, discordId: user.id } },
      })
    ).state,
  ).toBe("REVIEW");
});
test("registration links identity, sets nickname and role; failed role sync never reports registered", async () => {
  const n = randomUUID();
  const user = member(`identity-${n}`, "waiting");
  const student = await db.student.create({
    data: {
      guildId,
      studentId: `00${Date.now()}`,
      name: "First",
      lastname: "Last",
    },
  });
  await register(guildId, user.id, student.studentId);
  expect(user.setNickname).toHaveBeenCalledWith(
    "First Last",
    "Student verification",
  );
  expect(user.roles.add).toHaveBeenCalled();
  expect(
    (await db.student.findUniqueOrThrow({ where: { id: student.id } }))
      .registration,
  ).toBe("REGISTERED");
  user.roles.cache.set(studentRole, true);
  const registered = await db.student.findUniqueOrThrow({
    where: { id: student.id },
  });
  const nicknameCalls = user.setNickname.mock.calls.length;
  await register(guildId, user.id, student.studentId);
  expect(
    await db.student.findUniqueOrThrow({ where: { id: student.id } }),
  ).toEqual(registered);
  expect(user.setNickname).toHaveBeenCalledTimes(nicknameCalls);
  await expect(
    register(guildId, member(`another-${n}`, "waiting").id, student.studentId),
  ).rejects.toMatchObject({ code: "LINKED" });
  await expect(register(guildId, user.id, "missing")).rejects.toMatchObject({
    code: "STUDENT_NOT_FOUND",
  });
  const other = member(`failing-${n}`, "waiting");
  other.roles.add.mockRejectedValueOnce(new Error("Role hierarchy"));
  const record = await db.student.create({
    data: {
      guildId,
      studentId: n.replaceAll("-", ""),
      name: "Failure",
      lastname: "Test",
    },
  });
  await expect(
    register(guildId, other.id, record.studentId),
  ).rejects.toMatchObject({ code: "IDENTITY_SYNC" });
  expect(
    (await db.student.findUniqueOrThrow({ where: { id: record.id } }))
      .registration,
  ).toBe("SYNC_FAILED");
});
test("support creates private overwrites; closure deletes channel after durable history; reopen creates a new private channel", async () => {
  member("staff", null, staffRole);
  const ticket = await db.supportTicket.create({
    data: {
      guildId,
      creatorId: `support-user-${randomUUID()}`,
      category: "Coursework",
      subject: "Help",
      description: "Details",
    },
  });
  await createSupportChannel(ticket.id);
  const options = guild.channels.create.mock.calls.at(-1)![0] as {
    permissionOverwrites: { id: string; deny?: bigint[]; allow?: bigint[] }[];
  };
  expect(
    options.permissionOverwrites.find((x) => x.id === guildId)?.deny,
  ).toContain(PermissionFlagsBits.ViewChannel);
  expect(
    options.permissionOverwrites.find((x) => x.id === ticket.creatorId)?.allow,
  ).toContain(PermissionFlagsBits.ViewChannel);
  const saved = await db.supportTicket.findUniqueOrThrow({
    where: { id: ticket.id },
  });
  await expect(
    supportAction(guildId, member("unauthorized", null).id, ticket.id, "close"),
  ).rejects.toMatchObject({ code: "STAFF" });
  member("staff-two", null, staffRole);
  const claims = await Promise.allSettled(
    ["staff", "staff-two"].map((id) =>
      supportAction(guildId, id, ticket.id, "claim"),
    ),
  );
  expect(claims.filter((result) => result.status === "fulfilled")).toHaveLength(
    1,
  );
  expect(claims.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  );
  await supportAction(guildId, "staff", ticket.id, "close");
  const closed = await db.supportTicket.findUniqueOrThrow({
    where: { id: ticket.id },
    include: { events: true },
  });
  expect(closed.status).toBe("CLOSED");
  expect(closed.closedBy).toBe("staff");
  expect(closed.channelDeletedAt).not.toBeNull();
  expect(closed.events.some((e) => e.action === "cleanup_prepared")).toBe(true);
  expect(channels.has(saved.channelId)).toBe(false);
  const events = closed.events.length;
  await supportAction(guildId, "staff", ticket.id, "close");
  expect(
    await db.supportTicketEvent.count({ where: { ticketId: ticket.id } }),
  ).toBe(events);
  await supportAction(guildId, "staff", ticket.id, "reopen");
  const reopened = await db.supportTicket.findUniqueOrThrow({
    where: { id: ticket.id },
  });
  expect(reopened.status).toBe("OPEN");
  expect(reopened.channelId).not.toBe(saved.channelId);
  expect(channels.has(reopened.channelId)).toBe(true);
});
test("Discord error notifications exclude private event data and deduplicate deliveries", async () => {
  const { notifyEvents } = await import("../apps/bot/src/notifications");
  const { rest } = await import("../apps/bot/src/discord");
  await db.channelBinding.upsert({
    where: { guildId_feature: { guildId, feature: "error_log" } },
    create: { guildId, feature: "error_log", channelIds: ["error-channel"] },
    update: { channelIds: ["error-channel"] },
  });
  const record = await db.systemEvent.create({
    data: {
      guildId,
      actorId: "system",
      type: "test.failed",
      severity: "error",
      message: "Transfer failed.",
      correlationId: randomUUID(),
      data: { sensitive: "private-student-data" },
    },
  });
  const send = vi.spyOn(rest, "post").mockResolvedValue({ id: "message" });
  await notifyEvents();
  const delivery = await db.notificationDelivery.findUniqueOrThrow({
    where: { id: `${record.id}:error-channel` },
  });
  expect(delivery.status).toBe("SENT");
  const bodies = send.mock.calls.map((c) => JSON.stringify(c[1]));
  expect(bodies.some((b) => b.includes(record.correlationId))).toBe(true);
  expect(bodies.some((b) => b.includes("private-student-data"))).toBe(false);
  const count = send.mock.calls.filter((c) =>
    JSON.stringify(c[1]).includes(record.correlationId),
  ).length;
  await notifyEvents();
  expect(
    send.mock.calls.filter((c) =>
      JSON.stringify(c[1]).includes(record.correlationId),
    ).length,
  ).toBe(count);
  send.mockRestore();
});
test("support modal uses supported labelled inputs and a category dropdown", async () => {
  const { handleInteraction } = await import("../apps/bot/src/interactions");
  const user = member(`modal-${randomUUID()}`, null);
  const showModal = vi.fn();
  await handleInteraction({
    customId: "ta:support_open",
    guildId,
    user: { id: user.id },
    isButton: () => true,
    showModal,
  } as unknown as Interaction);
  const data = showModal.mock.calls[0][0].toJSON();
  expect(data.components).toHaveLength(4);
  expect(data.components[0]).toMatchObject({
    type: 18,
    label: "ประเภทปัญหา",
    component: { type: 3, custom_id: "category" },
  });
  expect(data.components[0].component.options).toHaveLength(3);
  expect(data.components[1].component).toMatchObject({
    custom_id: "subject",
    style: 2,
    max_length: 1000,
  });
  for (const component of data.components)
    expect(component.label.length).toBeLessThanOrEqual(45);
});
test("verified transfer stays successful if mute cleanup fails, and owned cleanup can retry", async () => {
  const f = await transferFixture();
  f.user.voice.serverMute = true;
  f.user.voice.setMute.mockRejectedValueOnce(
    new Error("Temporary mute permission failure"),
  );
  await db.muteOwnership.create({
    data: { guildId, discordId: f.user.id, state: "OWNED" },
  });
  guild.fetchAuditLogs.mockResolvedValue({
    entries: new DiscordCollection([
      [
        "mute",
        {
          targetId: f.user.id,
          executorId: "bot",
          createdTimestamp: Date.now(),
          changes: [{ key: "mute" }],
        },
      ],
    ]),
  });
  await processTransfer(f.claim.operationId);
  expect(
    await db.queueTicket.findUnique({ where: { id: f.ticket.id } }),
  ).toMatchObject({ status: "IN_PROGRESS" });
  expect(
    await db.voiceTransferOperation.findUnique({
      where: { id: f.claim.operationId },
    }),
  ).toMatchObject({ state: "SUCCEEDED" });
  expect(
    await db.queueReservation.count({ where: { ticketId: f.ticket.id } }),
  ).toBe(0);
  expect(f.user.voice.serverMute).toBe(true);
  await cleanupMute(
    f.user as unknown as GuildMember,
    settingsSchema.parse({ muteCleanup: false }),
    true,
  );
  expect(f.user.voice.serverMute).toBe(false);
  expect(await db.inspection.count({ where: { ticketId: f.ticket.id } })).toBe(
    1,
  );
});
test("panel synchronization coalesces concurrent calls and recreates missing or incompatible messages with a fresh durable nonce", async () => {
  const { syncPanels, rest } = await import("../apps/bot/src/discord");
  const { defaults } = await import("../packages/discord-ui/src/index");
  await db.publishedPanel.deleteMany({ where: { guildId } });
  const template = await db.embedTemplate.create({
    data: {
      guildId,
      name: "Recovery test",
      feature: "registration",
      document: defaults.registration,
    },
  });
  const panel = await db.publishedPanel.create({
    data: { guildId, channelId: "panel-test", templateId: template.id },
  });
  const messages = new Map<
    string,
    { id: string; delete: ReturnType<typeof vi.fn> }
  >();
  channels.set("panel-test", {
    id: "panel-test",
    isTextBased: () => true,
    messages: {
      fetch: async (options: { message: string; force: boolean }) => {
        expect(options.force).toBe(true);
        const message = messages.get(options.message);
        if (!message)
          throw Object.assign(new Error("Missing message"), { code: 10008 });
        return message;
      },
    },
  });
  const send = vi.spyOn(rest, "post").mockImplementation(async () => {
    const id = `panel-message-${++counter}`;
    messages.set(id, {
      id,
      delete: vi.fn(async () => {
        messages.delete(id);
      }),
    });
    return { id };
  });
  const patch = vi.spyOn(rest, "patch").mockImplementation(async (route) => ({
    id: String(route).split("/").at(-1),
  }));
  try {
    await Promise.all([syncPanels(), syncPanels()]);
    expect(send).toHaveBeenCalledTimes(1);
    await syncPanels();
    expect(send).toHaveBeenCalledTimes(1);
    await db.publishedPanel.update({
      where: { id: panel.id },
      data: { error: "Transient lookup failure" },
    });
    await syncPanels(true);
    expect(
      (await db.publishedPanel.findUniqueOrThrow({ where: { id: panel.id } }))
        .error,
    ).toBeNull();
    expect(patch).not.toHaveBeenCalled();
    messages.clear();
    await syncPanels(true);
    expect(send).toHaveBeenCalledTimes(2);
    await db.embedTemplate.update({
      where: { id: template.id },
      data: {
        document: { ...defaults.registration, mode: "V2" },
        version: { increment: 1 },
      },
    });
    await syncPanels();
    expect(send).toHaveBeenCalledTimes(3);
    const bodies = send.mock.calls.map(
      (call) => call[1]!.body as Record<string, unknown>,
    );
    expect(new Set(bodies.map((body) => body.nonce)).size).toBe(3);
    expect(bodies[2]).toHaveProperty("flags", 32768);
    expect(bodies[2]).not.toHaveProperty("embeds");
    expect(
      await db.publishedPanel.findUnique({ where: { id: panel.id } }),
    ).toMatchObject({ generation: 2, mode: "V2" });
  } finally {
    send.mockRestore();
    patch.mockRestore();
    await db.publishedPanel.delete({ where: { id: panel.id } });
  }
});

test("changed panels PATCH directly, reconcile missing messages and retain periodic verification", async () => {
  const { syncPanels, rest } = await import("../apps/bot/src/discord");
  const { defaults } = await import("../packages/discord-ui/src/index");
  await db.publishedPanel.deleteMany({ where: { guildId } });
  const template = await db.embedTemplate.create({
    data: {
      guildId,
      name: randomUUID(),
      feature: "registration",
      document: defaults.registration,
    },
  });
  const panel = await db.publishedPanel.create({
    data: { guildId, channelId: "edit-without-fetch", templateId: template.id },
  });
  const fetch = vi.fn(async () => ({ id: "direct-message" }));
  channels.set("edit-without-fetch", {
    id: "edit-without-fetch",
    isTextBased: () => true,
    messages: { fetch },
  });
  const send = vi
    .spyOn(rest, "post")
    .mockResolvedValue({ id: "direct-message" });
  const patch = vi
    .spyOn(rest, "patch")
    .mockResolvedValue({ id: "direct-message" });
  try {
    await syncPanels();
    send.mockClear();
    await db.embedTemplate.update({
      where: { id: template.id },
      data: {
        document: { ...defaults.registration, description: "Changed content" },
        version: { increment: 1 },
      },
    });
    await syncPanels();
    expect(fetch).not.toHaveBeenCalled();
    expect(patch).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    await syncPanels();
    expect(patch).toHaveBeenCalledOnce();
    await syncPanels(true);
    expect(fetch).toHaveBeenCalledOnce();
    expect(patch).toHaveBeenCalledOnce();
    await db.embedTemplate.update({
      where: { id: template.id },
      data: {
        document: { ...defaults.registration, description: "Changed again" },
        version: { increment: 1 },
      },
    });
    patch.mockRejectedValueOnce(
      Object.assign(new Error("Unknown Message"), { code: 10008 }),
    );
    await syncPanels();
    expect(send).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(
      await db.publishedPanel.findUniqueOrThrow({ where: { id: panel.id } }),
    ).toMatchObject({
      generation: 1,
      messageId: "direct-message",
      error: null,
    });
    await db.embedTemplate.update({
      where: { id: template.id },
      data: {
        document: { ...defaults.registration, description: "Forbidden edit" },
        version: { increment: 1 },
      },
    });
    patch.mockRejectedValueOnce(
      Object.assign(new Error("Missing Permissions"), { code: 50013 }),
    );
    await syncPanels();
    expect(send).toHaveBeenCalledOnce();
    expect(
      (await db.publishedPanel.findUniqueOrThrow({ where: { id: panel.id } }))
        .error,
    ).toBeTruthy();
    expect(
      (await db.publishedPanel.findUniqueOrThrow({ where: { id: panel.id } }))
        .messageId,
    ).toBe("direct-message");
  } finally {
    send.mockRestore();
    patch.mockRestore();
    await db.publishedPanel.delete({ where: { id: panel.id } });
  }
});

test("@everyone can verify despite legacy advanced restrictions; unverified queue interactions are rejected", async () => {
  const { handleInteraction } = await import("../apps/bot/src/interactions");
  const original = (
    await db.guild.findUniqueOrThrow({ where: { id: guildId } })
  ).settings;
  const settings = settingsSchema.parse(original);
  await db.guild.update({
    where: { id: guildId },
    data: {
      settings: {
        ...settings,
        advancedPermissionsEnabled: true,
        featurePermissions: { verify: [studentRole] },
      },
    },
  });
  const user = member(`everyone-${randomUUID()}`, "waiting", guildId);
  const showModal = vi.fn(),
    deferReply = vi.fn(),
    editReply = vi.fn();
  const interaction = {
    id: randomUUID(),
    customId: "ta:verify",
    guildId,
    user: { id: user.id },
    isButton: () => true,
    isModalSubmit: () => false,
    showModal,
    deferReply,
    editReply,
  };
  try {
    await handleInteraction(interaction as unknown as Interaction);
    expect(showModal).toHaveBeenCalledOnce();
    await expect(
      handleInteraction({
        ...interaction,
        customId: "ta:join",
      } as unknown as Interaction),
    ).rejects.toMatchObject({ code: "ROLE" });
    const student = await db.student.create({
      data: {
        guildId,
        studentId: "000" + Date.now(),
        name: "Public",
        lastname: "Verification",
      },
    });
    user.roles.add.mockImplementation(async () => {
      user.roles.cache.set(studentRole, true);
    });
    await handleInteraction({
      ...interaction,
      isButton: () => false,
      isModalSubmit: () => true,
      fields: { getTextInputValue: () => student.studentId },
    } as unknown as Interaction);
    expect(user.roles.cache.has(studentRole)).toBe(true);
    expect(user.setNickname).toHaveBeenCalledWith(
      "Public Verification",
      "Student verification",
    );
    expect(editReply.mock.calls[0][0].content).toContain("ยืนยันตัวตนแล้ว:");
  } finally {
    await db.guild.update({
      where: { id: guildId },
      data: { settings: original! },
    });
  }
});
test("verification lookup attempts are rate limited; administrator approval reserves identity without granting roles", async () => {
  const user = member(`limited-${randomUUID()}`, null, guildId);
  for (let i = 0; i < 5; i++)
    await expect(register(guildId, user.id, "missing")).rejects.toMatchObject({
      code: "STUDENT_NOT_FOUND",
    });
  await expect(register(guildId, user.id, "missing")).rejects.toMatchObject({
    code: "RATE_LIMIT",
  });
  const original = (
    await db.guild.findUniqueOrThrow({ where: { id: guildId } })
  ).settings;
  try {
    await db.guild.update({
      where: { id: guildId },
      data: {
        settings: {
          ...settingsSchema.parse(original),
          verificationMode: "ADMIN_APPROVAL",
        },
      },
    });
    const applicant = member(`approval-${randomUUID()}`, null, guildId);
    const student = await db.student.create({
      data: {
        guildId,
        studentId: randomUUID(),
        name: "Pending",
        lastname: "Approval",
      },
    });
    expect(
      (await register(guildId, applicant.id, student.studentId)).registration,
    ).toBe("APPROVAL_PENDING");
    expect(applicant.roles.add).not.toHaveBeenCalled();
    expect(applicant.setNickname).not.toHaveBeenCalled();
    await expect(
      register(guildId, user.id, student.studentId),
    ).rejects.toMatchObject({ code: "RATE_LIMIT" });
    await expect(
      register(
        guildId,
        member(`other-${randomUUID()}`, null, guildId).id,
        student.studentId,
      ),
    ).rejects.toMatchObject({ code: "LINKED" });
  } finally {
    await db.guild.update({
      where: { id: guildId },
      data: { settings: original! },
    });
  }
});
test("support cleanup persists metadata and transcript before delete, retains failures, recovers expired lease and missing channel", async () => {
  const config = await import("../packages/config/src/index");
  const configuration = config.env();
  const override = vi.spyOn(config, "env").mockReturnValue({
    ...configuration,
    DISCORD_MESSAGE_CONTENT_ENABLED: "true",
  });
  const original = (
    await db.guild.findUniqueOrThrow({ where: { id: guildId } })
  ).settings;
  await db.guild.update({
    where: { id: guildId },
    data: {
      settings: { ...settingsSchema.parse(original), retainTranscripts: true },
    },
  });
  member("cleanup-staff", null, staffRole);
  try {
    const ticket = await db.supportTicket.create({
      data: {
        guildId,
        creatorId: "cleanup-" + randomUUID(),
        category: "Technical issue",
        subject: "Cleanup",
        description: "Keep history",
      },
    });
    await createSupportChannel(ticket.id);
    const saved = await db.supportTicket.findUniqueOrThrow({
      where: { id: ticket.id },
    });
    const channel = channels.get(saved.channelId) as {
      messages: { fetch: ReturnType<typeof vi.fn> };
      delete: ReturnType<typeof vi.fn>;
    };
    channel.messages.fetch.mockResolvedValue(
      new DiscordCollection([
        [
          "transcript",
          {
            id: "transcript",
            author: { id: "author" },
            content: "Preserve this conversation",
            createdAt: new Date(),
          },
        ],
      ]),
    );
    channel.delete.mockImplementationOnce(async () => {
      const durable = await db.supportTicket.findUniqueOrThrow({
        where: { id: ticket.id },
        include: { events: true },
      });
      expect(durable.status).toBe("CLOSING");
      expect(durable.closureReason).toBe("Resolved");
      expect(JSON.stringify(durable.transcript)).toContain(
        "Preserve this conversation",
      );
      expect(durable.events.some((e) => e.action === "cleanup_prepared")).toBe(
        true,
      );
      throw Object.assign(new Error("Missing Manage Channels"), {
        code: 50013,
      });
    });
    await supportAction(
      guildId,
      "cleanup-staff",
      ticket.id,
      "close",
      "Resolved",
    );
    const failed = await db.supportTicket.findUniqueOrThrow({
      where: { id: ticket.id },
    });
    expect(failed.status).toBe("CLOSING");
    expect(failed.cleanupError).not.toBeNull();
    expect(failed.closedAt).toBeNull();
    expect(channels.has(saved.channelId)).toBe(true);
    // Simulate a crash after Discord deletion but before database finalization.
    channels.delete(saved.channelId);
    await db.supportTicket.update({
      where: { id: ticket.id },
      data: {
        cleanupLeaseToken: "abandoned",
        cleanupLeaseUntil: new Date(0),
        cleanupNextAttemptAt: new Date(0),
      },
    });
    await cleanupSupportTicket(ticket.id);
    const recovered = await db.supportTicket.findUniqueOrThrow({
      where: { id: ticket.id },
    });
    expect(recovered.status).toBe("CLOSED");
    expect(recovered.description).toBe("Keep history");
    expect(recovered.closedBy).toBe("cleanup-staff");
    expect(recovered.transcript).toEqual(failed.transcript);
    await cleanupSupportTicket(ticket.id);
    expect(
      await db.supportTicketEvent.count({
        where: { ticketId: ticket.id, action: "close" },
      }),
    ).toBe(1);
  } finally {
    override.mockRestore();
    await db.guild.update({
      where: { id: guildId },
      data: { settings: original! },
    });
  }
});

test("approved permission sync preserves unrelated bits, records ownership and resumes without duplicate writes", async () => {
  const { rest } = await import("../apps/bot/src/discord");
  const { applyAccess } = await import("../apps/bot/src/permissions");
  const channelId = "permission-" + randomUUID();
  const raw = {
    id: channelId,
    name: "QA",
    type: 0,
    permission_overwrites: [
      {
        id: studentRole,
        type: 0,
        allow: (
          PermissionFlagsBits.ViewChannel | PermissionFlagsBits.AttachFiles
        ).toString(),
        deny: "0",
      },
      {
        id: "unrelated-member",
        type: 1,
        allow: PermissionFlagsBits.SendMessages.toString(),
        deny: "0",
      },
    ],
  };
  const get = vi.spyOn(rest, "get").mockResolvedValue(raw);
  const put = vi
    .spyOn(rest, "put")
    .mockImplementation(async (_route, options) => {
      const body = options!.body as { allow: string; deny: string };
      raw.permission_overwrites[0] = {
        ...raw.permission_overwrites[0],
        ...body,
      };
      return {};
    });
  const change = {
    channelId,
    channelName: "QA",
    targetId: studentRole,
    targetName: "Student",
    targetType: 0,
    before: { ViewChannel: true },
    permissions: { ViewChannel: false },
    original: { ViewChannel: true },
    applied: { ViewChannel: false },
  };
  try {
    await applyAccess(guildId, [change]);
    expect(put).toHaveBeenCalledTimes(1);
    expect(
      BigInt(raw.permission_overwrites[0].allow) &
        PermissionFlagsBits.AttachFiles,
    ).toBe(PermissionFlagsBits.AttachFiles);
    expect(raw.permission_overwrites[1].id).toBe("unrelated-member");
    expect(
      (
        await db.managedPermission.findUniqueOrThrow({
          where: {
            guildId_channelId_targetId: {
              guildId,
              channelId,
              targetId: studentRole,
            },
          },
        })
      ).original,
    ).toEqual({ ViewChannel: true });
    await applyAccess(guildId, [change]);
    expect(put).toHaveBeenCalledTimes(1);
    raw.permission_overwrites[0].deny = "0";
    await expect(applyAccess(guildId, [change])).rejects.toMatchObject({
      code: "PERMISSION_CHANGED",
    });
  } finally {
    get.mockRestore();
    put.mockRestore();
  }
});
test("committed queue events update stored panel messages automatically and skip unchanged edits", async () => {
  const { syncPanels, rest } = await import("../apps/bot/src/discord");
  const { PanelSyncScheduler } = await import("../apps/bot/src/panel-sync");
  const { defaults } = await import("../packages/discord-ui/src/index");
  await db.publishedPanel.deleteMany({ where: { guildId } });
  const template = await db.embedTemplate.create({
    data: {
      guildId,
      name: "Live test",
      feature: "public_queue",
      document: defaults.public_queue,
    },
  });
  const panel = await db.publishedPanel.create({
    data: { guildId, channelId: "live-panel", templateId: template.id },
  });
  const message = { id: "live-message", delete: vi.fn() };
  channels.set("live-panel", {
    id: "live-panel",
    isTextBased: () => true,
    messages: { fetch: vi.fn(async () => message) },
  });
  const post = vi.spyOn(rest, "post").mockResolvedValue({ id: message.id });
  const patch = vi.spyOn(rest, "patch").mockResolvedValue({ id: message.id });
  try {
    await syncPanels();
    expect(post).toHaveBeenCalledOnce();
    const before = (
      await db.publishedPanel.findUniqueOrThrow({ where: { id: panel.id } })
    ).fingerprint;
    const fixture = await transferFixture();
    await db.tASession.update({
      where: { id: fixture.session.id },
      data: { taName: "PRIVATE-TA-NAME" },
    });
    await db.draftSelection.upsert({
      where: { guildId_discordId: { guildId, discordId: fixture.user.id } },
      create: {
        guildId,
        discordId: fixture.user.id,
        courseworkId: fixture.ticket.courseworkId,
        expiresAt: new Date(Date.now() + 1800000),
      },
      update: { courseworkId: fixture.ticket.courseworkId },
    });
    const scheduler = new PanelSyncScheduler(syncPanels);
    const settings = settingsSchema.parse({
      embedAutoRefreshEnabled: false,
      embedUpdateDebounceMs: 100,
    });
    await scheduler.tick(settings, 1, 100);
    await scheduler.tick(settings, 1, 200);
    expect(patch).toHaveBeenCalledOnce();
    const publicBody = JSON.stringify(patch.mock.calls[0][1]);
    expect(publicBody).not.toContain("PRIVATE-TA-NAME");
    expect(publicBody).not.toContain(fixture.target);
    expect(publicBody).toContain(fixture.ticket.coursework.name);
    expect(post).toHaveBeenCalledOnce();
    expect(
      (await db.publishedPanel.findUniqueOrThrow({ where: { id: panel.id } }))
        .fingerprint,
    ).not.toBe(before);
    await scheduler.tick(
      {
        ...settings,
        embedAutoRefreshEnabled: true,
        embedRefreshIntervalSeconds: 5,
      },
      1,
      6000,
    );
    expect(patch).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledOnce();
    expect(
      (
        await db.draftSelection.findUniqueOrThrow({
          where: { guildId_discordId: { guildId, discordId: fixture.user.id } },
        })
      ).courseworkId,
    ).toBe(fixture.ticket.courseworkId);
    channels.set("live-panel", {
      id: "live-panel",
      isTextBased: () => true,
      messages: {
        fetch: vi.fn(async () => {
          throw Object.assign(new Error("Missing message"), { code: 10008 });
        }),
      },
    });
    await scheduler.tick(
      {
        ...settings,
        embedAutoRefreshEnabled: true,
        embedRefreshIntervalSeconds: 5,
      },
      1,
      12000,
    );
    expect(post).toHaveBeenCalledTimes(2);
  } finally {
    post.mockRestore();
    patch.mockRestore();
    await db.publishedPanel.delete({ where: { id: panel.id } });
  }
});
test("cleanup uses bounded retries but reconciles a crash on the final attempt", async () => {
  member("bounded-staff", null, staffRole);
  const ticket = await db.supportTicket.create({
    data: {
      guildId,
      creatorId: "bounded-" + randomUUID(),
      category: "Technical issue",
      subject: "Retry limit",
      description: "Durable",
    },
  });
  await createSupportChannel(ticket.id);
  const saved = await db.supportTicket.findUniqueOrThrow({
    where: { id: ticket.id },
  });
  const channel = channels.get(saved.channelId) as {
    delete: ReturnType<typeof vi.fn>;
  };
  channel.delete.mockRejectedValue(new Error("Missing permissions"));
  await supportAction(guildId, "bounded-staff", ticket.id, "close");
  for (let i = 1; i < 5; i++) {
    await db.supportTicket.update({
      where: { id: ticket.id },
      data: { cleanupNextAttemptAt: new Date(0) },
    });
    await cleanupSupportTicket(ticket.id);
  }
  expect(channel.delete).toHaveBeenCalledTimes(5);
  await cleanupSupportTicket(ticket.id);
  expect(channel.delete).toHaveBeenCalledTimes(5);
  channels.delete(saved.channelId);
  await db.supportTicket.update({
    where: { id: ticket.id },
    data: {
      cleanupLeaseToken: "crashed-final-attempt",
      cleanupLeaseUntil: new Date(0),
      cleanupNextAttemptAt: new Date(0),
    },
  });
  await cleanupSupportTicket(ticket.id);
  expect(
    (await db.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } }))
      .status,
  ).toBe("CLOSED");
});
test("legacy closure cleanup keeps its original timestamp and does not touch another guild", async () => {
  const closedAt = new Date("2026-10-01T00:00:00.000Z");
  const ticket = await db.supportTicket.create({
    data: {
      guildId,
      creatorId: "legacy-" + randomUUID(),
      channelId: "legacy-missing-" + randomUUID(),
      category: "Technical issue",
      subject: "Legacy",
      description: "Retain original history",
      status: "CLOSED",
      closedAt,
      events: {
        create: {
          actorId: "legacy-staff",
          action: "close",
          note: "Original reason",
        },
      },
    },
  });
  await cleanupSupportTicket(ticket.id);
  const saved = await db.supportTicket.findUniqueOrThrow({
    where: { id: ticket.id },
    include: { events: true },
  });
  expect(saved.status).toBe("CLOSED");
  expect(saved.closedAt).toEqual(closedAt);
  expect(saved.closedBy).toBe("legacy-staff");
  expect(saved.closureReason).toBe("Original reason");
  expect(saved.channelDeletedAt).not.toBeNull();
  expect(saved.events.filter((e) => e.action === "close")).toHaveLength(1);
  const otherGuild = "8" + Date.now() + "0002";
  await db.guild.create({
    data: { id: otherGuild, name: "Unconfigured guild" },
  });
  const other = await db.supportTicket.create({
    data: {
      guildId: otherGuild,
      creatorId: "other",
      channelId: "other-missing-" + randomUUID(),
      category: "Help",
      subject: "Other",
      description: "Untouched",
      status: "CLOSED",
      closedAt,
    },
  });
  await cleanupSupportTicket(other.id);
  expect(
    await db.supportTicket.findUnique({ where: { id: other.id } }),
  ).toEqual(other);
});
test("required transcript failure never closes or deletes the support channel", async () => {
  const original = (
    await db.guild.findUniqueOrThrow({ where: { id: guildId } })
  ).settings;
  await db.guild.update({
    where: { id: guildId },
    data: {
      settings: { ...settingsSchema.parse(original), retainTranscripts: true },
    },
  });
  member("transcript-staff", null, staffRole);
  try {
    const ticket = await db.supportTicket.create({
      data: {
        guildId,
        creatorId: "transcript-" + randomUUID(),
        category: "Technical issue",
        subject: "Required transcript",
        description: "Preserve conversation",
      },
    });
    await createSupportChannel(ticket.id);
    const saved = await db.supportTicket.findUniqueOrThrow({
      where: { id: ticket.id },
    });
    await expect(
      supportAction(guildId, "transcript-staff", ticket.id, "close"),
    ).rejects.toMatchObject({ code: "TRANSCRIPT_INTENT" });
    expect(
      (await db.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } }))
        .status,
    ).toBe("OPEN");
    expect(channels.has(saved.channelId)).toBe(true);
  } finally {
    await db.guild.update({
      where: { id: guildId },
      data: { settings: original! },
    });
  }
});
test("administrator approval is authorized, audited and synchronized without trusting a supplied actor", async () => {
  const { POST } = await import("../apps/web/app/api/[...path]/route");
  const { NextRequest } = await import("next/server");
  const { tokenHash } = await import("../packages/shared/src/auth");
  const admin = await db.adminUser.create({
    data: {
      username: "approval-" + randomUUID(),
      passwordHash: "unusable-test-only-hash",
      role: "ADMIN",
    },
  });
  const raw = randomUUID(),
    csrf = randomUUID();
  await db.adminSession.create({
    data: {
      id: tokenHash(raw),
      adminId: admin.id,
      csrf,
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  const user = member("approval-api-" + randomUUID(), null, guildId);
  const student = await db.student.create({
    data: {
      guildId,
      studentId: randomUUID(),
      discordId: user.id,
      name: "Approved",
      lastname: "Student",
      registration: "APPROVAL_PENDING",
    },
  });
  const response = await POST(
    new NextRequest(
      env().APP_BASE_URL + "/api/students/" + student.id + "/approve",
      {
        method: "POST",
        headers: {
          cookie: "ta_session=" + raw,
          origin: env().APP_BASE_URL,
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ actorId: "forged" }),
      },
    ),
    { params: Promise.resolve({ path: ["students", student.id, "approve"] }) },
  );
  expect(response.status).toBe(200);
  const operation = await response.json();
  expect(operation.actorId).toBe(admin.id);
  expect(operation.action).toBe("sync_identity");
  expect(user.roles.add).not.toHaveBeenCalled();
  expect(
    (await db.student.findUniqueOrThrow({ where: { id: student.id } }))
      .registration,
  ).toBe("SYNC_PENDING");
  const { syncIdentity } = await import("../apps/bot/src/discord");
  await syncIdentity(student.id);
  expect(user.roles.add).toHaveBeenCalledOnce();
  expect(
    (await db.student.findUniqueOrThrow({ where: { id: student.id } }))
      .registration,
  ).toBe("REGISTERED");
  expect(
    (
      await db.systemEvent.findFirstOrThrow({
        where: { guildId, type: "identity.approved", actorId: admin.id },
      })
    ).actorId,
  ).toBe(admin.id);
});

test("Everyone support accepts an unverified member at button and modal, but keeps private channels and limits", async () => {
  const { handleInteraction } = await import("../apps/bot/src/interactions");
  const saved = (await db.guild.findUniqueOrThrow({ where: { id: guildId } }))
    .settings;
  await db.guild.update({
    where: { id: guildId },
    data: {
      settings: settingsSchema.parse({
        ...(saved as object),
        featureAccess: { support: "EVERYONE" },
        advancedPermissionsEnabled: true,
        featurePermissions: { support_open: [staffRole] },
      }),
    },
  });
  const id = `public-support-${randomUUID()}`;
  member(id, null, guildId);
  const showModal = vi.fn();
  const base = {
    guildId,
    user: { id },
    customId: "ta:support_open",
    id: randomUUID(),
    isButton: () => true,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    showModal,
  };
  try {
    await handleInteraction(base as unknown as Interaction);
    expect(showModal).toHaveBeenCalledOnce();
    const reply = vi.fn(),
      modal = {
        ...base,
        id: randomUUID(),
        isButton: () => false,
        isModalSubmit: () => true,
        deferReply: vi.fn(),
        editReply: reply,
        fields: {
          getStringSelectValues: () => ["Coursework"],
          getTextInputValue: (key: string) =>
            ({
              subject: "Unverified support",
              description: "Cannot verify",
              additional: "",
            })[key as "subject"],
        },
      };
    await handleInteraction(modal as unknown as Interaction);
    const ticket = await db.supportTicket.findFirstOrThrow({
      where: { guildId, creatorId: id },
    });
    await createSupportChannel(ticket.id);
    const options = guild.channels.create.mock.calls.at(-1)![0];
    const overwrites = options.permissionOverwrites as {
      id: string;
      allow?: bigint[];
      deny?: bigint[];
    }[];
    expect(overwrites.find((o) => o.id === guildId)?.deny).toContain(
      PermissionFlagsBits.ViewChannel,
    );
    expect(overwrites.find((o) => o.id === id)?.allow).toContain(
      PermissionFlagsBits.ViewChannel,
    );
    expect(overwrites.some((o) => o.id === studentRole)).toBe(false);
    await expect(
      handleInteraction({
        ...modal,
        id: randomUUID(),
      } as unknown as Interaction),
    ).rejects.toMatchObject({ code: "SUPPORT_LIMIT" });
    await db.guild.update({
      where: { id: guildId },
      data: {
        settings: settingsSchema.parse({
          ...(saved as object),
          featureAccess: { support: "STUDENTS" },
        }),
      },
    });
    await expect(
      handleInteraction(base as unknown as Interaction),
    ).rejects.toMatchObject({ code: "ROLE" });
  } finally {
    await db.guild.update({
      where: { id: guildId },
      data: { settings: saved! },
    });
  }
});
test("arrival follows verified target/coursework, preserves privacy, deduplicates, retries and uses only an explicit fallback", async () => {
  const { notifyArrivals } = await import("../apps/bot/src/notifications");
  const { defaults } = await import("../packages/discord-ui/src/index");
  const { rest } = await import("../apps/bot/src/discord");
  const f = await transferFixture();
  const config = settingsSchema.parse(
    (await db.guild.findUniqueOrThrow({ where: { id: guildId } })).settings,
  );
  await db.guild.update({
    where: { id: guildId },
    data: { settings: { ...config, routineAnnouncements: true } },
  });
  const arrivalTemplate = await db.embedTemplate.findFirstOrThrow({
    where: { guildId, feature: "arrival" },
    orderBy: { id: "asc" },
  });
  await db.embedTemplate.update({
    where: { id: arrivalTemplate.id },
    data: {
      document: {
        ...defaults.arrival,
        fields: [
          ...defaults.arrival.fields,
          { name: "Student ID", value: "{student.id}", inline: false },
        ],
      },
    },
  });
  await db.student.update({
    where: { id: f.ticket.student.id },
    data: { studentId: "PRIVATE-ARRIVAL-" + randomUUID() },
  });
  await processTransfer(f.claim.operationId);
  const post = vi
    .spyOn(rest, "post")
    .mockResolvedValue({ id: "arrival-message" });
  await notifyArrivals();
  const calls = post.mock.calls.filter(
    ([route]) => route === `/channels/${f.target}/messages`,
  );
  expect(calls).toHaveLength(1);
  const body = JSON.stringify(calls[0][1]);
  expect(body).toContain(f.ticket.sequence.toString());
  expect(body).toContain(f.ticket.coursework.name);
  expect(body).toContain(f.ticket.student.name);
  expect(body).not.toContain("PRIVATE-ARRIVAL-");
  expect(body).toContain('"parse":[]');
  await notifyArrivals();
  expect(
    post.mock.calls.filter(
      ([route]) => route === `/channels/${f.target}/messages`,
    ),
  ).toHaveLength(1);
  const record = await db.systemEvent.findFirstOrThrow({
    where: {
      guildId,
      type: "transfer.succeeded",
      data: { path: ["ticketId"], equals: f.ticket.id },
    },
  });
  await db.notificationDelivery.delete({
    where: { id: `arrival:${record.id}` },
  });
  post.mockRejectedValueOnce(new Error("Temporary notification failure"));
  await notifyArrivals();
  expect(
    (
      await db.notificationDelivery.findUniqueOrThrow({
        where: { id: `arrival:${record.id}` },
      })
    ).status,
  ).toBe("FAILED");
  const failedCalls = post.mock.calls.length;
  await notifyArrivals();
  expect(post.mock.calls.length).toBe(failedCalls);
  await db.notificationDelivery.update({
    where: { id: `arrival:${record.id}` },
    data: { status: "PENDING" },
  });
  await notifyArrivals();
  expect(
    (
      await db.notificationDelivery.findUniqueOrThrow({
        where: { id: `arrival:${record.id}` },
      })
    ).status,
  ).toBe("SENT");
  await db.notificationDelivery.delete({
    where: { id: `arrival:${record.id}` },
  });
  channels.delete(f.target);
  await notifyArrivals();
  expect(
    (
      await db.notificationDelivery.findUniqueOrThrow({
        where: { id: `arrival:${record.id}` },
      })
    ).channelId,
  ).toBe("");
  await db.notificationDelivery.update({
    where: { id: `arrival:${record.id}` },
    data: { status: "PENDING" },
  });
  const template = await db.embedTemplate.findFirstOrThrow({
    where: { guildId, feature: "arrival" },
    orderBy: { id: "asc" },
  });
  await db.embedTemplate.update({
    where: { id: template.id },
    data: {
      document: {
        ...defaults.arrival,
        fallbackChannelId: "100000000000000099",
      },
    },
  });
  channels.set("100000000000000099", {
    id: "100000000000000099",
    type: 0,
    guild,
    permissionsFor: () => ({ has: () => true }),
  });
  await notifyArrivals();
  expect(
    post.mock.calls.some(
      ([route]) => route === "/channels/100000000000000099/messages",
    ),
  ).toBe(true);
  post.mockRestore();
  await db.embedTemplate.update({
    where: { id: template.id },
    data: { document: defaults.arrival },
  });
});

test("voice completion correction is admin-only, audited and removes voided credit from rankings", async () => {
  const f = await transferFixture();
  await processTransfer(f.claim.operationId);
  f.user.voice.channelId = null;
  const { reconcileStudentVoice } = await import("../apps/bot/src/discord");
  guild.available = false;
  expect(
    await reconcileStudentVoice(f.user as unknown as GuildMember),
  ).toBeNull();
  expect(
    (await db.queueTicket.findUniqueOrThrow({ where: { id: f.ticket.id } }))
      .status,
  ).toBe("IN_PROGRESS");
  guild.available = true;
  await reconcileStudentVoice(
    f.user as unknown as GuildMember,
    new Date(),
    f.target,
  );
  const inspection = await db.inspection.findUniqueOrThrow({
    where: { ticketId: f.ticket.id },
  });
  expect(inspection.completionReason).toBe("VOICE_LEFT");
  const { POST, GET } = await import("../apps/web/app/api/[...path]/route");
  const { NextRequest } = await import("next/server");
  const { tokenHash } = await import("../packages/shared/src/auth");
  const admin = await db.adminUser.create({
    data: {
      username: "correction-" + randomUUID(),
      passwordHash: "unusable-test-hash",
      role: "OPERATOR",
    },
  });
  const raw = randomUUID(),
    csrf = randomUUID();
  await db.adminSession.create({
    data: {
      id: tokenHash(raw),
      adminId: admin.id,
      csrf,
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  const request = () =>
    new NextRequest(env().APP_BASE_URL + "/api/inspections/" + inspection.id, {
      method: "POST",
      headers: {
        cookie: "ta_session=" + raw,
        origin: env().APP_BASE_URL,
        "x-csrf-token": csrf,
      },
      body: JSON.stringify({
        completedAt: inspection.completedAt!.toISOString(),
        note: "Incorrect completion; verified by administrator",
        voided: true,
        actorId: "forged",
      }),
    });
  expect(
    (
      await POST(request(), {
        params: Promise.resolve({ path: ["inspections", inspection.id] }),
      })
    ).status,
  ).toBe(403);
  await db.adminUser.update({
    where: { id: admin.id },
    data: { role: "ADMIN" },
  });
  expect(
    (
      await POST(request(), {
        params: Promise.resolve({ path: ["inspections", inspection.id] }),
      })
    ).status,
  ).toBe(200);
  const audit = await db.systemEvent.findFirstOrThrow({
    where: { guildId, type: "inspection.corrected", actorId: admin.id },
  });
  expect(audit.actorId).toBe(admin.id);
  const result = await GET(
    new NextRequest(env().APP_BASE_URL + "/api/analytics", {
      headers: { cookie: "ta_session=" + raw },
    }),
    { params: Promise.resolve({ path: ["analytics"] }) },
  );
  expect((await result.json()).completed).toBe(0);
});

test("student speech restrictions stop transfer without granting Connect or overriding moderation", async () => {
  const f = await transferFixture();
  const room = channels.get(f.target) as {
    permissionsFor: (member: unknown) => unknown;
  };
  room.permissionsFor = (m: unknown) => ({
    has: () => (m as { id?: string }).id !== f.user.id,
  });
  await processTransfer(f.claim.operationId);
  expect(f.user.voice.setChannel).not.toHaveBeenCalled();
  expect(
    (await db.queueTicket.findUniqueOrThrow({ where: { id: f.ticket.id } }))
      .status,
  ).toBe("MOVE_FAILED");
  expect(
    await db.queueReservation.count({ where: { ticketId: f.ticket.id } }),
  ).toBe(1);
});

test("category propagation during approved sync preserves each child feature's own access", async () => {
  const { accessPlan } = await import("../packages/config/src/access");
  const { applyAccess } = await import("../apps/bot/src/permissions");
  const { rest } = await import("../apps/bot/src/discord");
  const categoryId = "category-" + randomUUID(),
    childId = "child-" + randomUUID();
  const original = [
    {
      id: guildId,
      type: 0,
      allow: "0",
      deny: PermissionFlagsBits.ViewChannel.toString(),
    },
  ];
  const category = {
    id: categoryId,
    name: "Private category",
    type: 4,
    permission_overwrites: structuredClone(original),
  };
  const child = {
    id: childId,
    name: "Student queue",
    type: 0,
    parent_id: categoryId,
    permission_overwrites: structuredClone(original),
  };
  const roles = [
    { id: guildId, name: "@everyone", permissions: "0", position: 0 },
    { id: studentRole, name: "Student", permissions: "0", position: 1 },
    { id: staffRole, name: "Support", permissions: "0", position: 2 },
    { id: "bot-role", name: "Bot", permissions: "8", position: 10 },
  ];
  const settings = settingsSchema.parse({
    studentRole,
    supportRoles: [staffRole],
  });
  const plan = accessPlan(
    guildId,
    settings,
    [
      { feature: "ticket_category", channelIds: [categoryId] },
      { feature: "student_queue", channelIds: [childId] },
    ],
    [category, child],
    roles,
    { id: "bot", roles: ["bot-role"] },
    [],
  );
  const get = vi
    .spyOn(rest, "get")
    .mockImplementation(async (route) =>
      structuredClone(String(route).includes(categoryId) ? category : child),
    );
  const put = vi
    .spyOn(rest, "put")
    .mockImplementation(async (route, options) => {
      const current = String(route).includes(categoryId) ? category : child;
      const synced =
        JSON.stringify(category.permission_overwrites) ===
        JSON.stringify(child.permission_overwrites);
      const targetId = String(route).split("/").at(-1)!;
      const body = options!.body as {
        allow: string;
        deny: string;
        type: number;
      };
      const overwrite = { id: targetId, ...body };
      const index = current.permission_overwrites.findIndex(
        (o) => o.id === targetId,
      );
      if (index === -1) current.permission_overwrites.push(overwrite);
      else current.permission_overwrites[index] = overwrite;
      if (current === category && synced)
        child.permission_overwrites = structuredClone(
          category.permission_overwrites,
        );
      return {};
    });
  try {
    await applyAccess(guildId, plan.changes);
    const parent = category.permission_overwrites.find(
        (o) => o.id === studentRole,
      )!,
      student = child.permission_overwrites.find((o) => o.id === studentRole)!;
    expect(BigInt(parent.deny) & PermissionFlagsBits.ViewChannel).toBe(
      PermissionFlagsBits.ViewChannel,
    );
    expect(BigInt(student.allow) & PermissionFlagsBits.ViewChannel).toBe(
      PermissionFlagsBits.ViewChannel,
    );
  } finally {
    get.mockRestore();
    put.mockRestore();
  }
});

test("unified Call Next and legacy buttons allow a TA who never started, deny students, and move to the clicking TA's room", async () => {
  const { handleInteraction } = await import("../apps/bot/src/interactions");
  for (const action of ["CALL_NEXT_STUDENT", "next", "help"]) {
    const f = await transferFixture();
    await db.voiceTransferOperation.delete({
      where: { id: f.claim.operationId },
    });
    await db.queueTicket.update({
      where: { id: f.ticket.id },
      data: { status: "QUEUED", sessionId: null },
    });
    const roomId = `new-ta-room-${action}`,
      taId = `never-started-${action}`;
    member(taId, roomId, taRole);
    channels.set(roomId, {
      id: roomId,
      guild,
      type: 2,
      send: vi.fn(),
      permissionsFor: (who: { id?: string }) => ({
        has: (permission: unknown) =>
          who?.id === studentRole && permission === PermissionFlagsBits.Connect
            ? false
            : true,
      }),
    });
    await db.channelBinding.update({
      where: { guildId_feature: { guildId, feature: "ta_voice" } },
      data: { channelIds: [f.target, roomId] },
    });
    guild.roles.fetch.mockResolvedValueOnce({ id: studentRole, position: 1 });
    const i = {
      guildId,
      customId: `ta:${action}`,
      user: { id: taId },
      id: randomUUID(),
      isButton: () => true,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
      deferReply: vi.fn(),
      editReply: vi.fn(),
    };
    await handleInteraction(i as unknown as Interaction);
    expect(i.editReply.mock.calls[0][0].content).toMatch(/[ก-๙]/);
    const ticket = await db.queueTicket.findUniqueOrThrow({
      where: { id: f.ticket.id },
      include: { session: true, transfers: true },
    });
    expect(ticket.session).toMatchObject({ taId, capacity: 0 });
    expect(ticket.transfers[0].targetChannelId).toBe(roomId);
    const ordinary = member(`ordinary-${action}`, roomId, studentRole);
    await expect(
      handleInteraction({
        ...i,
        id: randomUUID(),
        user: { id: ordinary.id },
      } as unknown as Interaction),
    ).rejects.toMatchObject({ code: "ROLE" });
    await processTransfer(ticket.transfers[0].id);
    expect(f.user.voice.channelId).toBe(roomId);
    await completeInspection(guildId, taId, randomUUID());
  }
});

test("long Thai support subject survives modal submission, private message, history and channel deletion", async () => {
  const { handleInteraction } = await import("../apps/bot/src/interactions");
  const subject =
    "ไม่สามารถยืนยันตัวตนด้วยรหัสนักศึกษาได้ 🧑‍💻\n@everyone / <test> ".repeat(
      15,
    );
  expect(subject.length).toBeGreaterThan(500);
  expect(subject.length).toBeLessThanOrEqual(1000);
  const creator = member(`long-subject-${randomUUID()}`, null, studentRole);
  const i = {
    guildId,
    user: { id: creator.id },
    customId: "ta:support_open",
    id: randomUUID(),
    isButton: () => false,
    isModalSubmit: () => true,
    isStringSelectMenu: () => false,
    deferReply: vi.fn(),
    deferUpdate: vi.fn(),
    editReply: vi.fn(),
    fields: {
      getStringSelectValues: () => ["Coursework"],
      getTextInputValue: (key: string) =>
        ({
          subject,
          description: "Independent problem description",
          additional: "ก".repeat(2000),
        })[key as "subject"],
    },
  };
  await handleInteraction(i as unknown as Interaction);
  const ticket = await db.supportTicket.findFirstOrThrow({
    where: { guildId, creatorId: creator.id },
  });
  expect(ticket.subject).toBe(subject);
  expect(ticket.description).toBe("Independent problem description");
  await createSupportChannel(ticket.id);
  const options = guild.channels.create.mock.calls.at(-1)![0];
  expect(options.name).toBe(`help-${ticket.id.slice(-8)}`);
  const saved = await db.supportTicket.findUniqueOrThrow({
    where: { id: ticket.id },
  });
  const channel = channels.get(saved.channelId!) as {
    send: ReturnType<typeof vi.fn>;
  };
  const message = channel.send.mock.calls[0][0];
  expect(
    message.embeds[0].fields.find(
      (f: { name: string }) => f.name === "หัวข้อปัญหา",
    ).value,
  ).toBe(subject);
  expect(message.allowedMentions).toEqual({ parse: [] });
  expect(
    message.embeds[0].fields.reduce(
      (sum: number, f: { value: string }) => sum + f.value.length,
      0,
    ),
  ).toBeLessThan(6000);
  member("long-support-staff", null, staffRole);
  await supportAction(
    guildId,
    "long-support-staff",
    ticket.id,
    "close",
    "Resolved",
  );
  await cleanupSupportTicket(ticket.id);
  const closed = await db.supportTicket.findUniqueOrThrow({
    where: { id: ticket.id },
    include: { events: true },
  });
  expect(closed).toMatchObject({ subject, status: "CLOSED" });
  expect(
    closed.events.some((e) => e.action === "created" && e.note === subject),
  ).toBe(true);
});

test("student leaving during the call notification is not pulled back into a TA room", async () => {
  const f = await transferFixture();
  const room = channels.get(f.target) as { send: ReturnType<typeof vi.fn> };
  room.send.mockImplementationOnce(async () => {
    f.user.voice.channelId = "unrelated-room";
    return { id: "called" };
  });
  await processTransfer(f.claim.operationId);
  expect(f.user.voice.setChannel).not.toHaveBeenCalled();
  const ticket = await db.queueTicket.findUniqueOrThrow({
    where: { id: f.ticket.id },
    include: { reservation: true },
  });
  expect(ticket.status).toBe("MOVE_FAILED");
  expect(ticket.reservation).not.toBeNull();
});

test("room panel calls global next without Start, rejects wrong-room and disabled panels, and preserves capacity", async () => {
  const { handleInteraction } = await import("../apps/bot/src/interactions");
  const { defaults, roomPanelTemplateSchema, scopeRoomActions, render } =
    await import("../packages/discord-ui/src/index");
  const f = await transferFixture();
  await processTransfer(f.claim.operationId);
  await completeInspection(guildId, f.ta.id, randomUUID());
  const next = await db.student.create({
    data: {
      guildId,
      studentId: randomUUID(),
      name: "Room",
      lastname: "Next",
      discordId: randomUUID(),
      registration: "REGISTERED",
    },
  });
  member(next.discordId!, "waiting");
  const course = await db.coursework.findFirstOrThrow({
    where: { id: f.ticket.courseworkId },
  });
  await admission(guildId, next.discordId!, randomUUID(), course.id);
  const helperId = `helper-room-${randomUUID()}`,
    roomId = `helper-voice-${randomUUID()}`;
  member(helperId, roomId, taRole);
  channels.set(roomId, {
    id: roomId,
    type: 2,
    name: "Helper room",
    guild,
    permissionsFor: (who: { id?: string }) => ({
      has: (permission: unknown) =>
        who?.id === studentRole && permission === PermissionFlagsBits.Connect
          ? false
          : true,
    }),
    send: vi.fn(async () => ({ id: "notification" })),
  });
  const binding = await db.channelBinding.findUniqueOrThrow({
    where: { guildId_feature: { guildId, feature: "ta_voice" } },
  });
  await db.channelBinding.update({
    where: { id: binding.id },
    data: { channelIds: [...binding.channelIds, roomId] },
  });
  const template = await db.embedTemplate.create({
    data: {
      guildId,
      feature: "ta_room_queue_panel",
      name: "Room fixture",
      document: defaults.ta_room_queue_panel,
    },
  });
  const panel = await db.publishedPanel.create({
    data: {
      guildId,
      channelId: roomId,
      templateId: template.id,
      messageId: "room-button-message",
    },
  });
  const mapping = await db.tARoomPanel.create({
    data: {
      guildId,
      voiceChannelId: roomId,
      destinationChannelId: roomId,
      templateId: template.id,
      publishedPanelId: panel.id,
    },
  });
  const i = {
    guildId,
    message: { id: "room-button-message" },
    channelId: roomId,
    user: { id: helperId },
    customId: `ta:CALL_NEXT_STUDENT:${roomId}`,
    id: randomUUID(),
    isButton: () => true,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    deferReply: vi.fn(),
    deferUpdate: vi.fn(),
    editReply: vi.fn(),
  };
  await expect(
    handleInteraction({
      ...i,
      channelId: "another-channel",
    } as unknown as Interaction),
  ).rejects.toMatchObject({ code: "ROOM_PANEL" });
  const capacity = (await import("../packages/queue-engine/src/index"))
    .snapshot;
  const before = (await capacity(guildId)).metrics.capacity;
  await handleInteraction(i as unknown as Interaction);
  const claimed = await db.queueTicket.findFirstOrThrow({
    where: { guildId, session: { taId: helperId } },
    include: { session: true, transfers: true },
  });
  expect(i.deferUpdate).toHaveBeenCalled();
  expect(i.editReply).not.toHaveBeenCalled();
  expect(claimed.session!.capacity).toBe(0);
  expect(claimed.transfers[0].targetChannelId).toBe(roomId);
  expect((await capacity(guildId)).metrics.capacity).toBe(before);
  await db.tARoomPanel.update({
    where: { id: mapping.id },
    data: { enabled: false },
  });
  await expect(
    handleInteraction({ ...i, id: randomUUID() } as unknown as Interaction),
  ).rejects.toMatchObject({ code: "ROOM_PANEL" });
  expect(() =>
    roomPanelTemplateSchema.parse({
      ...defaults.ta_room_queue_panel,
      description: "{ta.table}",
    }),
  ).toThrow();
  const scoped = JSON.stringify(
    scopeRoomActions(
      render(defaults.ta_room_queue_panel, {
        "queue.top": "",
        "queue.available": 1,
        "queue.waiting": 1,
        "queue.active_tas": 1,
      }),
      roomId,
    ),
  );
  expect(scoped).toContain(`ta:CALL_NEXT_STUDENT:${roomId}`);
  await processTransfer(claimed.transfers[0].id);
  await completeInspection(guildId, helperId, randomUUID());
  await db.tARoomPanel.delete({ where: { id: mapping.id } });
  await db.publishedPanel.delete({ where: { id: panel.id } });
  await db.embedTemplate.delete({ where: { id: template.id } });
});

test("two persistent room panels coalesce updates, scope actions, recover missing messages and preserve custom templates", async () => {
  const { syncPanels, rest } = await import("../apps/bot/src/discord");
  const { defaults } = await import("../packages/discord-ui/src/index");
  await db.publishedPanel.deleteMany({ where: { guildId } });
  const document = {
    ...defaults.ta_room_queue_panel,
    title: "คิวห้อง Custom preserved",
  };
  const template = await db.embedTemplate.create({
    data: {
      guildId,
      feature: "ta_room_queue_panel",
      name: randomUUID(),
      document,
    },
  });
  const mappings = [];
  const messages = new Map<
    string,
    { id: string; delete: () => Promise<void> }
  >();
  for (const room of ["panel-room-a", "panel-room-b"]) {
    channels.set(room, {
      id: room,
      isTextBased: () => true,
      messages: {
        fetch: async ({ message }: { message: string }) => {
          const old = messages.get(message);
          if (!old) throw Object.assign(new Error("Missing"), { code: 10008 });
          return old;
        },
      },
    });
    const panel = await db.publishedPanel.create({
      data: { guildId, channelId: room, templateId: template.id },
    });
    mappings.push(
      await db.tARoomPanel.create({
        data: {
          guildId,
          voiceChannelId: room,
          destinationChannelId: room,
          templateId: template.id,
          publishedPanelId: panel.id,
          refreshSeconds: 5,
        },
      }),
    );
  }
  const send = vi.spyOn(rest, "post").mockImplementation(async () => {
    const id = randomUUID();
    messages.set(id, {
      id,
      delete: async () => {
        messages.delete(id);
      },
    });
    return { id };
  });
  const patch = vi.spyOn(rest, "patch").mockImplementation(async (route) => ({
    id: String(route).split("/").at(-1),
  }));
  try {
    await Promise.all([syncPanels(), syncPanels()]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(send.mock.calls[0][1]!.body)).toContain(
      "ta:CALL_NEXT_STUDENT:panel-room-a",
    );
    await syncPanels();
    expect(send).toHaveBeenCalledTimes(2);
    expect(patch).not.toHaveBeenCalled();
    const first = await db.publishedPanel.findUniqueOrThrow({
      where: { id: mappings[0].publishedPanelId! },
    });
    messages.delete(first.messageId!);
    await db.publishedPanel.update({
      where: { id: first.id },
      data: { checkedAt: new Date(0) },
    });
    await syncPanels();
    expect(send).toHaveBeenCalledTimes(3);
    await db.embedTemplate.update({
      where: { id: template.id },
      data: {
        document: { ...document, description: "คิว: {queue.waiting}" },
        version: { increment: 1 },
      },
    });
    await syncPanels();
    expect(patch).toHaveBeenCalledTimes(2);
    expect(
      (await db.embedTemplate.findUniqueOrThrow({ where: { id: template.id } }))
        .document,
    ).toMatchObject({ title: document.title });
  } finally {
    send.mockRestore();
    patch.mockRestore();
    await db.tARoomPanel.deleteMany({
      where: { id: { in: mappings.map((m) => m.id) } },
    });
    await db.publishedPanel.deleteMany({ where: { templateId: template.id } });
    await db.embedTemplate.delete({ where: { id: template.id } });
  }
});

test("coursework select silently stores each user's durable draft; Join alone validates and replies", async () => {
  const { handleInteraction } = await import("../apps/bot/src/interactions");
  const f = await transferFixture();
  await processTransfer(f.claim.operationId);
  await completeInspection(guildId, f.ta.id, randomUUID());
  const other = member(`silent-${randomUUID()}`, "waiting");
  await db.student.create({
    data: {
      guildId,
      discordId: other.id,
      studentId: `000${Date.now()}`,
      name: "สมชาย",
      lastname: "ใจดี",
      registration: "REGISTERED",
    },
  });
  const second = member(`unverified-select-${randomUUID()}`, null, guildId);
  const otherCourse = await db.coursework.create({
    data: { guildId, name: "Second coursework" },
  });
  const i = {
    id: randomUUID(),
    customId: "ta:coursework",
    guildId,
    user: { id: other.id },
    values: [f.ticket.courseworkId],
    isButton: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => true,
    deferUpdate: vi.fn(),
    deferReply: vi.fn(),
    editReply: vi.fn(),
    reply: vi.fn(),
  };
  await handleInteraction(i as unknown as Interaction);
  await handleInteraction({
    ...i,
    id: randomUUID(),
    user: { id: second.id },
    values: [otherCourse.id],
  } as unknown as Interaction);
  expect(i.deferUpdate).toHaveBeenCalledTimes(2);
  expect(i.deferReply).not.toHaveBeenCalled();
  expect(i.editReply).not.toHaveBeenCalled();
  expect(i.reply).not.toHaveBeenCalled();
  expect(
    (
      await db.draftSelection.findUniqueOrThrow({
        where: { guildId_discordId: { guildId, discordId: other.id } },
      })
    ).courseworkId,
  ).toBe(f.ticket.courseworkId);
  expect(
    (
      await db.draftSelection.findUniqueOrThrow({
        where: { guildId_discordId: { guildId, discordId: second.id } },
      })
    ).courseworkId,
  ).toBe(otherCourse.id);
  const join = {
    ...i,
    id: randomUUID(),
    customId: "ta:join",
    isButton: () => true,
    isStringSelectMenu: () => false,
  };
  await handleInteraction({
    ...i,
    id: randomUUID(),
    values: ["unavailable-coursework"],
  } as unknown as Interaction);
  await expect(
    handleInteraction(join as unknown as Interaction),
  ).rejects.toMatchObject({ code: "COURSEWORK" });
  i.deferReply.mockClear();
  await handleInteraction({ ...i, id: randomUUID() } as unknown as Interaction);
  await handleInteraction(join as unknown as Interaction);
  expect(i.deferReply).toHaveBeenCalledOnce();
  expect(i.editReply).toHaveBeenCalledOnce();
  const response = JSON.stringify(i.editReply.mock.calls[0]);
  expect(response).toContain("รับบัตรคิวสำเร็จ");
  expect(response).not.toMatch(/<t:|คิวกลาง/);
  expect(
    await db.queueTicket.count({
      where: { guildId, student: { discordId: other.id }, status: "QUEUED" },
    }),
  ).toBe(1);
  await expect(
    handleInteraction({
      ...join,
      id: randomUUID(),
      user: { id: second.id },
    } as unknown as Interaction),
  ).rejects.toMatchObject({ code: "ROLE" });
  await db.draftSelection.update({
    where: { guildId_discordId: { guildId, discordId: other.id } },
    data: { expiresAt: new Date(0) },
  });
  await expect(
    handleInteraction({ ...join, id: randomUUID() } as unknown as Interaction),
  ).rejects.toMatchObject({ code: "SELECTION" });
});

test("default routine transfer announcements are suppressed; failures remain actionable", async () => {
  const { notifyArrivals } = await import("../apps/bot/src/notifications");
  const { rest } = await import("../apps/bot/src/discord");
  const config = settingsSchema.parse(
    (await db.guild.findUniqueOrThrow({ where: { id: guildId } })).settings,
  );
  await db.guild.update({
    where: { id: guildId },
    data: {
      settings: { ...config, notifications: true, routineAnnouncements: false },
    },
  });
  const f = await transferFixture();
  const post = vi
    .spyOn(rest, "post")
    .mockResolvedValue({ id: "unexpected-announcement" });
  try {
    await processTransfer(f.claim.operationId);
    await notifyArrivals();
    expect(
      (channels.get(f.target) as { send: ReturnType<typeof vi.fn> }).send,
    ).not.toHaveBeenCalled();
    expect(
      post.mock.calls.filter(
        ([route]) => route === `/channels/${f.target}/messages`,
      ),
    ).toHaveLength(0);
    expect(
      (await db.queueTicket.findUniqueOrThrow({ where: { id: f.ticket.id } }))
        .status,
    ).toBe("IN_PROGRESS");
    const failed = await transferFixture();
    failed.user.voice.channelId = null;
    await processTransfer(failed.claim.operationId);
    expect(
      (channels.get(failed.target) as { send: ReturnType<typeof vi.fn> }).send,
    ).toHaveBeenCalledOnce();
  } finally {
    post.mockRestore();
  }
});

test("mapped room message edits from calling to inspection to idle without another message", async () => {
  const { defaults } = await import("../packages/discord-ui/src/index");
  const { syncPanels, rest } = await import("../apps/bot/src/discord");
  const { observeStudentVoice } =
    await import("../packages/queue-engine/src/index");
  await db.publishedPanel.deleteMany({ where: { guildId } });
  const f = await transferFixture();
  const config = settingsSchema.parse(
    (await db.guild.findUniqueOrThrow({ where: { id: guildId } })).settings,
  );
  await db.guild.update({
    where: { id: guildId },
    data: { settings: { ...config, routineAnnouncements: false } },
  });
  const template = await db.embedTemplate.create({
    data: {
      guildId,
      feature: "ta_room_queue_panel",
      name: randomUUID(),
      document: defaults.ta_room_queue_panel,
    },
  });
  const panel = await db.publishedPanel.create({
    data: {
      guildId,
      templateId: template.id,
      channelId: f.target,
      messageId: "persistent-room-message",
    },
  });
  await db.tARoomPanel.create({
    data: {
      guildId,
      templateId: template.id,
      voiceChannelId: f.target,
      destinationChannelId: f.target,
      publishedPanelId: panel.id,
      visibility: "TAS",
    },
  });
  const room = channels.get(f.target) as {
    isTextBased?: () => boolean;
    messages?: unknown;
    send: ReturnType<typeof vi.fn>;
  };
  room.isTextBased = () => true;
  room.messages = { fetch: vi.fn(async () => ({ id: panel.messageId })) };
  const post = vi.spyOn(rest, "post").mockResolvedValue({ id: "unexpected" });
  const patch = vi
    .spyOn(rest, "patch")
    .mockResolvedValue({ id: panel.messageId });
  try {
    await syncPanels();
    expect(JSON.stringify(patch.mock.calls.at(-1))).toContain(
      "กำลังเรียกนักศึกษา",
    );
    expect(JSON.stringify(patch.mock.calls.at(-1))).toContain(
      f.ticket.student.studentId,
    );
    const registered = await db.student.findUniqueOrThrow({
      where: { guildId_discordId: { guildId, discordId: f.user.id } },
    });
    const verifiedStudentId = `00${Date.now()}${counter}`;
    await db.student.update({
      where: { id: registered.id },
      data: { studentId: verifiedStudentId },
    });
    f.user.displayName = "99999999 wrong nickname";
    await processTransfer(f.claim.operationId);
    await syncPanels();
    const actual = JSON.stringify(patch.mock.calls.at(-1));
    expect(actual).toContain("กำลังตรวจงาน");
    expect(actual).toContain(`🪪 รหัสนักศึกษา: ${verifiedStudentId}`);
    expect(actual).toContain(`🎫 หมายเลขคิว: #${f.ticket.sequence}`);
    expect(actual).not.toContain("99999999 wrong nickname");
    const persisted = await db.publishedPanel.findUniqueOrThrow({
      where: { id: panel.id },
    });
    await db.publishedPanel.update({
      where: { id: panel.id },
      data: { fingerprint: null },
    });
    await syncPanels(true);
    expect(JSON.stringify(patch.mock.calls.at(-1))).toContain(
      `🪪 รหัสนักศึกษา: ${verifiedStudentId}`,
    );
    expect(
      (await db.publishedPanel.findUniqueOrThrow({ where: { id: panel.id } }))
        .messageId,
    ).toBe(persisted.messageId);
    await db.student.update({
      where: { id: registered.id },
      data: { discordId: null },
    });
    await syncPanels();
    expect(JSON.stringify(patch.mock.calls.at(-1))).toContain(
      "ไม่พบรหัสนักศึกษา",
    );
    await db.student.update({
      where: { id: registered.id },
      data: { discordId: f.user.id },
    });
    await syncPanels();
    expect(JSON.stringify(patch.mock.calls.at(-1))).toContain(
      verifiedStudentId,
    );
    await db.tARoomPanel.update({
      where: { publishedPanelId: panel.id },
      data: { visibility: "PUBLIC" },
    });
    await syncPanels();
    expect(JSON.stringify(patch.mock.calls.at(-1))).not.toContain(
      verifiedStudentId,
    );
    await db.tARoomPanel.update({
      where: { publishedPanelId: panel.id },
      data: { visibility: "TAS" },
    });
    await observeStudentVoice(
      guildId,
      f.user.id,
      null,
      new Date(Date.now() + 100),
      f.target,
    );
    await syncPanels();
    expect(JSON.stringify(patch.mock.calls.at(-1))).toContain(
      "ขณะนี้ไม่มีนักศึกษากำลังตรวจงาน",
    );
    expect(
      (await db.publishedPanel.findUniqueOrThrow({ where: { id: panel.id } }))
        .messageId,
    ).toBe(panel.messageId);
    expect(
      await db.inspection.count({
        where: { ticketId: f.ticket.id, completedAt: { not: null } },
      }),
    ).toBe(1);
    expect(post).not.toHaveBeenCalled();
    expect(room.send).not.toHaveBeenCalled();
    const edits = patch.mock.calls.length;
    await syncPanels();
    expect(patch).toHaveBeenCalledTimes(edits);
  } finally {
    post.mockRestore();
    patch.mockRestore();
  }
});

async function completedFixture() {
  const f = await transferFixture();
  const room = channels.get(f.target) as {
    permissionsFor: (who: { id?: string }) => {
      has: (permission: unknown) => boolean;
    };
  };
  room.permissionsFor = (who: { id?: string }) => ({
    has: (permission: unknown) =>
      who.id === studentRole && permission === PermissionFlagsBits.Connect
        ? false
        : true,
  });
  await processTransfer(f.claim.operationId);
  return f;
}
test("complete and disconnect targets only the active inspection, preserves identity/roles and credits exactly once", async () => {
  const { requestCompletion } =
    await import("../packages/queue-engine/src/completion");
  const { processCompletion } = await import("../apps/bot/src/completion");
  const f = await completedFixture();
  const other = member("other-" + randomUUID(), f.target);
  const before = await db.student.findUniqueOrThrow({
    where: { guildId_discordId: { guildId, discordId: f.user.id } },
  });
  const operation = await requestCompletion(
    guildId,
    f.ta.id,
    "complete-once",
    f.target,
  );
  await Promise.all([
    processCompletion(operation.ticketId),
    processCompletion(operation.ticketId),
  ]);
  await processCompletion(operation.ticketId);
  expect(f.user.voice.disconnect).toHaveBeenCalledOnce();
  expect(other.voice.disconnect).not.toHaveBeenCalled();
  expect(f.ta.voice.disconnect).not.toHaveBeenCalled();
  expect(f.user.voice.channelId).toBeNull();
  expect(f.user.roles.cache.has(studentRole)).toBe(true);
  expect(
    await db.student.findUniqueOrThrow({ where: { id: before.id } }),
  ).toEqual(before);
  const inspection = await db.inspection.findUniqueOrThrow({
    where: { ticketId: f.ticket.id },
  });
  expect(inspection.completedAt).not.toBeNull();
  expect(inspection.completionReason).toBe("TA_COMPLETED_AND_DISCONNECTED");
  expect(
    await db.systemEvent.count({
      where: {
        guildId,
        type: "inspection.completed",
        data: { path: ["ticketId"], equals: f.ticket.id },
      },
    }),
  ).toBe(1);
});
test("voluntary departure races button completion and uses the same finalizer", async () => {
  const { requestCompletion } =
    await import("../packages/queue-engine/src/completion");
  const { processCompletion } = await import("../apps/bot/src/completion");
  const { observeStudentVoice } =
    await import("../packages/queue-engine/src/index");
  const f = await completedFixture();
  await requestCompletion(guildId, f.ta.id, randomUUID(), f.target);
  f.user.voice.disconnect.mockImplementation(async () => {
    f.user.voice.channelId = null;
    await observeStudentVoice(guildId, f.user.id, null, new Date(), f.target);
  });
  await processCompletion(f.ticket.id);
  await observeStudentVoice(guildId, f.user.id, null, new Date(), f.target);
  expect(
    await db.inspection.count({
      where: { ticketId: f.ticket.id, completedAt: { not: null } },
    }),
  ).toBe(1);
  expect(
    (
      await db.inspection.findUniqueOrThrow({
        where: { ticketId: f.ticket.id },
      })
    ).completionReason,
  ).toBe("TA_COMPLETED_AND_DISCONNECTED");
});
test("disconnect rejection preserves the in-progress inspection and permits safe retry", async () => {
  const { requestCompletion } =
    await import("../packages/queue-engine/src/completion");
  const { processCompletion } = await import("../apps/bot/src/completion");
  const f = await completedFixture();
  f.user.voice.disconnect.mockRejectedValueOnce(
    new Error("Missing permissions"),
  );
  await requestCompletion(guildId, f.ta.id, randomUUID(), f.target);
  await expect(processCompletion(f.ticket.id)).rejects.toMatchObject({
    code: "COMPLETION_FAILED",
  });
  expect(
    (await db.queueTicket.findUniqueOrThrow({ where: { id: f.ticket.id } }))
      .status,
  ).toBe("IN_PROGRESS");
  expect(
    (
      await db.inspection.findUniqueOrThrow({
        where: { ticketId: f.ticket.id },
      })
    ).completedAt,
  ).toBeNull();
  expect(
    (
      await db.inspectionCompletion.findUniqueOrThrow({
        where: { ticketId: f.ticket.id },
      })
    ).lastError,
  ).not.toBeNull();
  await requestCompletion(guildId, f.ta.id, randomUUID(), f.target);
  await processCompletion(f.ticket.id);
  expect(
    (
      await db.inspectionCompletion.findUniqueOrThrow({
        where: { ticketId: f.ticket.id },
      })
    ).state,
  ).toBe("SUCCEEDED");
});
test("restart after disconnect reclaims the expired durable lease without disconnecting again", async () => {
  const { requestCompletion, leaseCompletion } =
    await import("../packages/queue-engine/src/completion");
  const { processCompletion } = await import("../apps/bot/src/completion");
  const f = await completedFixture();
  await requestCompletion(guildId, f.ta.id, randomUUID(), f.target);
  await leaseCompletion(f.ticket.id);
  f.user.voice.channelId = null;
  await db.inspectionCompletion.update({
    where: { ticketId: f.ticket.id },
    data: { leaseUntil: new Date(0) },
  });
  await processCompletion(f.ticket.id);
  expect(f.user.voice.disconnect).not.toHaveBeenCalled();
  expect(
    (
      await db.inspectionCompletion.findUniqueOrThrow({
        where: { ticketId: f.ticket.id },
      })
    ).state,
  ).toBe("SUCCEEDED");
});
test("all mapped room controls and modal submissions reject wrong room or stale panel", async () => {
  const { handleInteraction } = await import("../apps/bot/src/interactions");
  const { defaults } = await import("../packages/discord-ui/src/index");
  const { taRoomActions } = await import("../packages/shared/src/index");
  const f = await completedFixture();
  await db.tARoomPanel.deleteMany({ where: { guildId } });
  const template = await db.embedTemplate.create({
    data: {
      guildId,
      feature: "ta_room_queue_panel",
      name: "Controls",
      document: defaults.ta_room_queue_panel,
    },
  });
  const panel = await db.publishedPanel.create({
    data: {
      guildId,
      channelId: f.target,
      messageId: "controls-message",
      templateId: template.id,
    },
  });
  const mapping = await db.tARoomPanel.create({
    data: {
      guildId,
      voiceChannelId: f.target,
      destinationChannelId: f.target,
      templateId: template.id,
      publishedPanelId: panel.id,
    },
  });
  const i = {
    guildId,
    channelId: "wrong-room",
    message: { id: panel.messageId },
    user: { id: f.ta.id },
    id: randomUUID(),
    isButton: () => true,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    isFromMessage: () => true,
    deferUpdate: vi.fn(),
    deferReply: vi.fn(),
    showModal: vi.fn(),
    editReply: vi.fn(),
    followUp: vi.fn(),
  };
  for (const action of taRoomActions)
    await expect(
      handleInteraction({
        ...i,
        customId: `ta:${action}:${f.target}`,
      } as unknown as Interaction),
    ).rejects.toMatchObject({ code: "ROOM_PANEL" });
  await handleInteraction({
    ...i,
    channelId: f.target,
    customId: `ta:session_settings:${f.target}`,
  } as unknown as Interaction);
  expect(i.showModal.mock.calls[0][0].data.custom_id).toBe(
    `ta:session_settings:${f.target}`,
  );
  await expect(
    handleInteraction({
      ...i,
      channelId: f.target,
      customId: `ta:session_settings:${f.target}`,
      message: { id: "stale" },
      isButton: () => false,
      isModalSubmit: () => true,
    } as unknown as Interaction),
  ).rejects.toMatchObject({ code: "ROOM_PANEL" });
  await handleInteraction({
    ...i,
    channelId: f.target,
    customId: `ta:complete:${f.target}`,
  } as unknown as Interaction);
  expect(i.editReply).not.toHaveBeenCalled();
  await db.tARoomPanel.delete({ where: { id: mapping.id } });
});
async function waitingAlertFixture() {
  const { observeWaitingMember } =
    await import("../apps/bot/src/waiting-alerts");
  await db.waitingRoomAlert.deleteMany({ where: { guildId } });
  await db.waitingPresence.deleteMany({ where: { guildId } });
  guild.voiceStates.cache.clear();
  const previous = (
    await db.guild.findUniqueOrThrow({ where: { id: guildId } })
  ).settings;
  const settings = settingsSchema.parse(previous);
  await db.guild.update({
    where: { id: guildId },
    data: {
      settings: {
        ...settings,
        waitingRoomAlerts: {
          ...settings.waitingRoomAlerts,
          enabled: true,
          roleIds: [taRole],
          graceSeconds: 5,
        },
      },
    },
  });
  await db.channelBinding.upsert({
    where: { guildId_feature: { guildId, feature: "queue_alert" } },
    create: { guildId, feature: "queue_alert", channelIds: ["alert-room"] },
    update: { channelIds: ["alert-room"] },
  });
  channels.set("alert-room", {
    id: "alert-room",
    type: 0,
    isSendable: () => true,
    permissionsFor: () => ({ has: () => true }),
  });
  const { rest } = await import("../apps/bot/src/discord");
  const post = vi
    .spyOn(rest, "post")
    .mockResolvedValue({ id: "waiting-alert-message" });
  const patch = vi
    .spyOn(rest, "patch")
    .mockResolvedValue({ id: "waiting-alert-message" });
  const get = vi.spyOn(rest, "get").mockResolvedValue([]);
  const student = member("unqueued-" + randomUUID(), "waiting");
  guild.voiceStates.cache.set(student.id, {
    id: student.id,
    channelId: "waiting",
  });
  await observeWaitingMember(student as unknown as GuildMember);
  return {
    student,
    post,
    patch,
    get,
    previous,
    cleanup: async () => {
      post.mockRestore();
      patch.mockRestore();
      get.mockRestore();
      guild.voiceStates.cache.clear();
      await db.waitingRoomAlert.deleteMany({ where: { guildId } });
      await db.waitingPresence.deleteMany({ where: { guildId } });
      await db.guild.update({
        where: { id: guildId },
        data: { settings: previous! },
      });
    },
  };
}
async function ageWaitingAlert() {
  await db.waitingPresence.updateMany({
    where: { guildId },
    data: { joinedAt: new Date(Date.now() - 6000) },
  });
  await db.waitingRoomAlert.updateMany({
    where: { guildId },
    data: { startedAt: new Date(Date.now() - 6000) },
  });
}
test("waiting without a ticket waits for grace, groups students, mentions once and resolves on departure", async () => {
  const { reconcileWaitingAlerts, observeWaitingMember } =
    await import("../apps/bot/src/waiting-alerts");
  const f = await waitingAlertFixture();
  try {
    await reconcileWaitingAlerts(guildId);
    expect(f.post).not.toHaveBeenCalled();
    await ageWaitingAlert();
    await reconcileWaitingAlerts(guildId);
    expect(f.post).toHaveBeenCalledOnce();
    expect(f.post.mock.calls[0][1]?.body).toMatchObject({
      allowed_mentions: { parse: [], roles: [taRole] },
    });
    const second = member("second-" + randomUUID(), "waiting");
    guild.voiceStates.cache.set(second.id, {
      id: second.id,
      channelId: "waiting",
    });
    await observeWaitingMember(second as unknown as GuildMember);
    await reconcileWaitingAlerts(guildId);
    expect(f.post).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.patch.mock.calls[0][1])).toContain("2 คน");
    expect(f.patch.mock.calls[0][1]?.body).toMatchObject({
      allowed_mentions: { parse: [], roles: [] },
    });
    f.student.voice.channelId = null;
    second.voice.channelId = null;
    guild.voiceStates.cache.clear();
    await reconcileWaitingAlerts(guildId);
    expect(
      (
        await db.waitingRoomAlert.findUniqueOrThrow({
          where: { guildId_scope: { guildId, scope: "all" } },
        })
      ).resolvedAt,
    ).not.toBeNull();
    const updates = f.patch.mock.calls.length;
    await reconcileWaitingAlerts(guildId);
    expect(f.patch.mock.calls.length).toBe(updates);
  } finally {
    await f.cleanup();
  }
});
test("ticket before grace cancels an alert; stale leases recover the same alert message without another mention", async () => {
  const { reconcileWaitingAlerts } =
    await import("../apps/bot/src/waiting-alerts");
  const f = await waitingAlertFixture();
  try {
    await reconcileWaitingAlerts(guildId);
    await ageWaitingAlert();
    f.get.mockResolvedValue([
      {
        id: "already-sent",
        author: { id: "bot" },
        embeds: [
          {
            footer: {
              text: `อ้างอิง ${(await import("node:crypto")).createHash("sha256").update(`${guildId}:all:0`).digest("hex").slice(0, 12)}`,
            },
          },
        ],
      },
    ]);
    await db.waitingRoomAlert.updateMany({
      where: { guildId },
      data: {
        leaseUntil: new Date(0),
        leaseToken: "crashed",
        mentionAttempted: true,
      },
    });
    await reconcileWaitingAlerts(guildId);
    expect(f.post).not.toHaveBeenCalled();
    expect(f.patch).toHaveBeenCalledOnce();
    expect(f.patch.mock.calls[0][1]?.body).toMatchObject({
      allowed_mentions: { roles: [] },
    });
    const course = await db.coursework.create({
      data: { guildId, name: "Alert admission" },
    });
    await db.student.create({
      data: {
        guildId,
        studentId: randomUUID(),
        discordId: f.student.id,
        name: "Alert",
        lastname: "Student",
        registration: "REGISTERED",
      },
    });
    const session = await startSession(guildId, "alert-ta", randomUUID(), {
      taName: "Alert TA",
      voiceChannelId: "alert-ta-room",
      capacity: 1,
      courseworkIds: [],
      roleIds: [taRole],
      note: "",
    });
    await admission(guildId, f.student.id, randomUUID(), course.id);
    await reconcileWaitingAlerts(guildId);
    expect(
      (
        await db.waitingRoomAlert.findUniqueOrThrow({
          where: { guildId_scope: { guildId, scope: "all" } },
        })
      ).resolvedAt,
    ).not.toBeNull();
    expect(
      (await db.tASession.findUniqueOrThrow({ where: { id: session.id } }))
        .capacity,
    ).toBe(1);
  } finally {
    await f.cleanup();
  }
});

test("multiple active inspections are refused rather than selecting a random student", async () => {
  const { requestCompletion } =
    await import("../packages/queue-engine/src/completion");
  const f = await completedFixture();
  const old = (await db.guild.findUniqueOrThrow({ where: { id: guildId } }))
    .settings;
  await db.guild.update({
    where: { id: guildId },
    data: {
      settings: { ...settingsSchema.parse(old), inspectionConcurrency: 2 },
    },
  });
  try {
    const other = member("ambiguous-" + randomUUID(), "waiting");
    await db.student.create({
      data: {
        guildId,
        studentId: randomUUID(),
        discordId: other.id,
        name: "Second",
        lastname: "Inspection",
        registration: "REGISTERED",
      },
    });
    await admission(guildId, other.id, randomUUID(), f.ticket.courseworkId);
    const claim = await claimNext(guildId, f.ta.id, randomUUID());
    await processTransfer(claim.operationId);
    await expect(
      requestCompletion(guildId, f.ta.id, randomUUID(), f.target),
    ).rejects.toMatchObject({ code: "AMBIGUOUS_INSPECTION" });
    expect(f.user.voice.disconnect).not.toHaveBeenCalled();
    expect(other.voice.disconnect).not.toHaveBeenCalled();
    expect(
      await db.inspectionCompletion.count({ where: { ticket: { guildId } } }),
    ).toBe(0);
  } finally {
    await db.guild.update({ where: { id: guildId }, data: { settings: old! } });
  }
});
test("ticket obtained before grace prevents a notification entirely", async () => {
  const { reconcileWaitingAlerts } =
    await import("../apps/bot/src/waiting-alerts");
  const f = await waitingAlertFixture();
  try {
    await reconcileWaitingAlerts(guildId);
    const course = await db.coursework.create({
      data: { guildId, name: "Before grace" },
    });
    await db.student.create({
      data: {
        guildId,
        studentId: randomUUID(),
        discordId: f.student.id,
        name: "Waiting",
        lastname: "Student",
        registration: "REGISTERED",
      },
    });
    await startSession(guildId, "grace-ta", randomUUID(), {
      taName: "TA",
      voiceChannelId: "grace-ta-room",
      capacity: 1,
      courseworkIds: [],
      roleIds: [taRole],
      note: "",
    });
    await admission(guildId, f.student.id, randomUUID(), course.id);
    await ageWaitingAlert();
    await reconcileWaitingAlerts(guildId);
    expect(f.post).not.toHaveBeenCalled();
    expect(
      (
        await db.waitingRoomAlert.findUniqueOrThrow({
          where: { guildId_scope: { guildId, scope: "all" } },
        })
      ).resolvedAt,
    ).not.toBeNull();
  } finally {
    await f.cleanup();
  }
});
test("a physically available TA without Start resolves the no-inspector trigger without creating capacity or tickets", async () => {
  const { reconcileWaitingAlerts } =
    await import("../apps/bot/src/waiting-alerts");
  const f = await waitingAlertFixture();
  const old = (await db.guild.findUniqueOrThrow({ where: { id: guildId } }))
    .settings;
  const settings = settingsSchema.parse(old);
  await db.guild.update({
    where: { id: guildId },
    data: {
      settings: {
        ...settings,
        waitingRoomAlerts: {
          ...settings.waitingRoomAlerts,
          noAccepting: false,
        },
      },
    },
  });
  try {
    await reconcileWaitingAlerts(guildId);
    await ageWaitingAlert();
    await reconcileWaitingAlerts(guildId);
    expect(f.post).toHaveBeenCalledOnce();
    const roomId = "available-without-start";
    channels.set(roomId, {
      id: roomId,
      type: 2,
      permissionsFor: (who: { id?: string }) => ({
        has: (permission: unknown) =>
          who.id === studentRole && permission === PermissionFlagsBits.Connect
            ? false
            : true,
      }),
    });
    await db.channelBinding.upsert({
      where: { guildId_feature: { guildId, feature: "ta_voice" } },
      create: { guildId, feature: "ta_voice", channelIds: [roomId] },
      update: { channelIds: [roomId] },
    });
    const ta = member("ready-ta-" + randomUUID(), roomId, taRole);
    guild.voiceStates.cache.set(ta.id, { id: ta.id, channelId: roomId });
    await reconcileWaitingAlerts(guildId);
    expect(
      (
        await db.waitingRoomAlert.findUniqueOrThrow({
          where: { guildId_scope: { guildId, scope: "all" } },
        })
      ).resolvedAt,
    ).not.toBeNull();
    expect(await db.tASession.count({ where: { guildId } })).toBe(0);
    expect(await db.queueTicket.count({ where: { guildId } })).toBe(0);
  } finally {
    await f.cleanup();
  }
});

test("accepted disconnect without a Gateway confirmation remains recoverable and reaches bounded manual review", async () => {
  const { requestCompletion } =
    await import("../packages/queue-engine/src/completion");
  const { processCompletion } = await import("../apps/bot/src/completion");
  const f = await completedFixture();
  const previous = (
    await db.guild.findUniqueOrThrow({ where: { id: guildId } })
  ).settings;
  await db.guild.update({
    where: { id: guildId },
    data: {
      settings: { ...settingsSchema.parse(previous), maxMoveAttempts: 1 },
    },
  });
  try {
    f.user.voice.disconnect.mockImplementation(async () => undefined);
    await requestCompletion(guildId, f.ta.id, randomUUID(), f.target);
    await expect(processCompletion(f.ticket.id)).rejects.toMatchObject({
      code: "COMPLETION_FAILED",
    });
    expect(
      (await db.queueTicket.findUniqueOrThrow({ where: { id: f.ticket.id } }))
        .status,
    ).toBe("IN_PROGRESS");
    expect(
      (
        await db.inspectionCompletion.findUniqueOrThrow({
          where: { ticketId: f.ticket.id },
        })
      ).state,
    ).toBe("NEEDS_REVIEW");
    await processCompletion(f.ticket.id);
    expect(f.user.voice.disconnect).toHaveBeenCalledOnce();
  } finally {
    await db.guild.update({
      where: { id: guildId },
      data: { settings: previous! },
    });
  }
});
test("waiting incident cooldown blocks a later notification, then permits one new mention per independent incident", async () => {
  const { reconcileWaitingAlerts, observeWaitingMember } =
    await import("../apps/bot/src/waiting-alerts");
  const f = await waitingAlertFixture();
  try {
    await reconcileWaitingAlerts(guildId);
    await ageWaitingAlert();
    await reconcileWaitingAlerts(guildId);
    f.student.voice.channelId = null;
    guild.voiceStates.cache.clear();
    await reconcileWaitingAlerts(guildId);
    f.student.voice.channelId = "waiting";
    guild.voiceStates.cache.set(f.student.id, {
      id: f.student.id,
      channelId: "waiting",
    });
    await observeWaitingMember(f.student as unknown as GuildMember);
    await reconcileWaitingAlerts(guildId);
    await ageWaitingAlert();
    await reconcileWaitingAlerts(guildId);
    expect(f.post).toHaveBeenCalledOnce();
    await db.waitingRoomAlert.updateMany({
      where: { guildId },
      data: { lastNotifiedAt: new Date(0) },
    });
    await reconcileWaitingAlerts(guildId);
    expect(f.post).toHaveBeenCalledTimes(2);
    expect(f.post.mock.calls[1][1]?.body).toMatchObject({
      allowed_mentions: { parse: [], roles: [taRole] },
    });
  } finally {
    await f.cleanup();
  }
});

test("deleted active waiting message is recreated without a second role mention", async () => {
  const { reconcileWaitingAlerts, observeWaitingMember } =
    await import("../apps/bot/src/waiting-alerts");
  const f = await waitingAlertFixture();
  try {
    await reconcileWaitingAlerts(guildId);
    await ageWaitingAlert();
    await reconcileWaitingAlerts(guildId);
    const second = member("deleted-alert-" + randomUUID(), "waiting");
    guild.voiceStates.cache.set(second.id, {
      id: second.id,
      channelId: "waiting",
    });
    await observeWaitingMember(second as unknown as GuildMember);
    f.patch.mockRejectedValueOnce(
      Object.assign(new Error("Unknown Message"), { code: 10008 }),
    );
    await reconcileWaitingAlerts(guildId);
    await reconcileWaitingAlerts(guildId);
    expect(f.post).toHaveBeenCalledTimes(2);
    expect(f.post.mock.calls[1][1]?.body).toMatchObject({
      allowed_mentions: { parse: [], roles: [] },
    });
    expect(
      (
        await db.waitingRoomAlert.findUniqueOrThrow({
          where: { guildId_scope: { guildId, scope: "all" } },
        })
      ).messageId,
    ).toBe("waiting-alert-message");
  } finally {
    await f.cleanup();
  }
});

test("confirmed No Show disconnects only the inspected student, sends one private DM and never credits completion", async () => {
  const { requestCompletion } =
    await import("../packages/queue-engine/src/completion");
  const { processCompletion, notifyNoShow } =
    await import("../apps/bot/src/completion");
  const { observeStudentVoice } =
    await import("../packages/queue-engine/src/index");
  const { rest } = await import("../apps/bot/src/discord");
  const f = await completedFixture();
  const other = member("unrelated-" + randomUUID(), f.target);
  const before = await db.student.findUniqueOrThrow({
    where: { guildId_discordId: { guildId, discordId: f.user.id } },
  });
  const post = vi
    .spyOn(rest, "post")
    .mockImplementation(async (route, options) =>
      route === "/users/@me/channels"
        ? { id: "dm-private" }
        : { id: "dm-no-show-message" },
    );
  const get = vi.spyOn(rest, "get").mockResolvedValue([]);
  try {
    await requestCompletion(
      guildId,
      f.ta.id,
      randomUUID(),
      f.target,
      "NO_SHOW",
      f.ticket.id,
    );
    f.user.voice.disconnect.mockImplementation(async () => {
      f.user.voice.channelId = null;
      await observeStudentVoice(guildId, f.user.id, null, new Date(), f.target);
    });
    await Promise.all([
      processCompletion(f.ticket.id),
      processCompletion(f.ticket.id),
    ]);
    await Promise.all([notifyNoShow(f.ticket.id), notifyNoShow(f.ticket.id)]);
    await notifyNoShow(f.ticket.id);
    expect(f.user.voice.disconnect).toHaveBeenCalledOnce();
    expect(other.voice.disconnect).not.toHaveBeenCalled();
    const inspection = await db.inspection.findUniqueOrThrow({
      where: { ticketId: f.ticket.id },
    });
    expect(inspection.status).toBe("NO_SHOW");
    expect(inspection.completionReason).toBe("TA_MARKED_NO_SHOW");
    expect(
      (await db.queueTicket.findUniqueOrThrow({ where: { id: f.ticket.id } }))
        .status,
    ).toBe("NO_SHOW");
    expect(
      await db.inspection.count({
        where: { ticketId: f.ticket.id, status: "COMPLETED" },
      }),
    ).toBe(0);
    expect(
      await db.student.findUniqueOrThrow({ where: { id: before.id } }),
    ).toEqual(before);
    expect(f.user.roles.cache.has(studentRole)).toBe(true);
    expect(
      post.mock.calls.filter(
        ([route]) => route === "/channels/dm-private/messages",
      ),
    ).toHaveLength(1);
    expect(
      post.mock.calls.find(([route]) => route === "/users/@me/channels")?.[1]
        ?.body,
    ).toMatchObject({ recipient_id: f.user.id });
    expect(JSON.stringify(post.mock.calls)).toContain(f.ticket.coursework.name);
    const { GET } = await import("../apps/web/app/api/[...path]/route");
    const { NextRequest } = await import("next/server");
    const { tokenHash } = await import("../packages/shared/src/auth");
    const admin = await db.adminUser.create({
      data: {
        username: "no-show-analytics-" + randomUUID(),
        passwordHash: "unusable-test-hash",
        role: "ADMIN",
      },
    });
    const raw = randomUUID();
    await db.adminSession.create({
      data: {
        id: tokenHash(raw),
        adminId: admin.id,
        csrf: randomUUID(),
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    const analytics = await GET(
      new NextRequest(env().APP_BASE_URL + "/api/analytics", {
        headers: { cookie: "ta_session=" + raw },
      }),
      { params: Promise.resolve({ path: ["analytics"] }) },
    );
    expect(analytics.status).toBe(200);
    const summary = await analytics.json();
    expect(summary.completed).toBe(0);
    expect(
      summary.taRanking.find((ta: { taId: string }) => ta.taId === f.ta.id),
    ).toMatchObject({ completed: 0, noShows: 1 });
    expect(
      summary.studentRanking.find(
        (student: { id: string }) => student.id === before.id,
      ),
    ).toMatchObject({ completed: 0, noShows: 1 });

    expect(
      (
        await db.inspectionCompletion.findUniqueOrThrow({
          where: { ticketId: f.ticket.id },
        })
      ).notificationState,
    ).toBe("SENT");
  } finally {
    post.mockRestore();
    get.mockRestore();
  }
});
test("No Show confirmation cancel is safe; confirm rejects a different actor and survives the voice completion race", async () => {
  const { handleInteraction } = await import("../apps/bot/src/interactions");
  const { rest } = await import("../apps/bot/src/discord");
  const f = await completedFixture();
  const post = vi
    .spyOn(rest, "post")
    .mockImplementation(async (route) =>
      route === "/users/@me/channels"
        ? { id: "dm-confirm" }
        : { id: "dm-confirm-message" },
    );
  const get = vi.spyOn(rest, "get").mockResolvedValue([]);
  const base = {
    guildId,
    channelId: f.target,
    user: { id: f.ta.id },
    id: randomUUID(),
    isButton: () => true,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    deferReply: vi.fn(),
    deferUpdate: vi.fn(),
    editReply: vi.fn(),
    followUp: vi.fn(),
  };
  try {
    await handleInteraction({
      ...base,
      customId: "ta:MARK_STUDENT_NO_SHOW",
    } as unknown as Interaction);
    expect(f.user.voice.disconnect).not.toHaveBeenCalled();
    expect(base.editReply.mock.calls[0][0].content).toContain(
      "ยืนยันการบันทึก",
    );
    const otherTA = member("other-ta-" + randomUUID(), f.target, taRole);
    await expect(
      handleInteraction({
        ...base,
        user: { id: otherTA.id },
        id: randomUUID(),
        customId: `ta:no_show_confirm:${base.id}`,
      } as unknown as Interaction),
    ).rejects.toMatchObject({ code: "CONFIRMATION_EXPIRED" });
    await handleInteraction({
      ...base,
      id: randomUUID(),
      customId: `ta:no_show_cancel:${base.id}`,
    } as unknown as Interaction);
    expect(f.user.voice.disconnect).not.toHaveBeenCalled();
    const requestId = randomUUID();
    await handleInteraction({
      ...base,
      id: requestId,
      customId: "ta:no_show",
    } as unknown as Interaction);
    await handleInteraction({
      ...base,
      id: randomUUID(),
      customId: `ta:no_show_confirm:${requestId}`,
    } as unknown as Interaction);
    expect(f.user.voice.disconnect).toHaveBeenCalledOnce();
    expect(
      (
        await db.inspection.findUniqueOrThrow({
          where: { ticketId: f.ticket.id },
        })
      ).status,
    ).toBe("NO_SHOW");
    await handleInteraction({
      ...base,
      id: randomUUID(),
      customId: `ta:no_show_confirm:${requestId}`,
    } as unknown as Interaction);
    expect(f.user.voice.disconnect).toHaveBeenCalledOnce();
  } finally {
    post.mockRestore();
    get.mockRestore();
  }
});
test("No Show permission failure stays recoverable; closed DMs do not undo the terminal decision", async () => {
  const { requestCompletion } =
    await import("../packages/queue-engine/src/completion");
  const { processCompletion, notifyNoShow } =
    await import("../apps/bot/src/completion");
  const { rest } = await import("../apps/bot/src/discord");
  const f = await completedFixture();
  f.user.voice.disconnect.mockRejectedValueOnce(
    new Error("Missing Move Members"),
  );
  await requestCompletion(
    guildId,
    f.ta.id,
    randomUUID(),
    f.target,
    "NO_SHOW",
    f.ticket.id,
  );
  await expect(processCompletion(f.ticket.id)).rejects.toMatchObject({
    code: "COMPLETION_FAILED",
  });
  expect(
    (
      await db.inspection.findUniqueOrThrow({
        where: { ticketId: f.ticket.id },
      })
    ).status,
  ).toBe("IN_PROGRESS");
  await requestCompletion(
    guildId,
    f.ta.id,
    randomUUID(),
    f.target,
    "NO_SHOW",
    f.ticket.id,
  );
  await processCompletion(f.ticket.id);
  const post = vi.spyOn(rest, "post").mockRejectedValue(
    Object.assign(new Error("Cannot send messages to this user"), {
      code: 50007,
    }),
  );
  try {
    await notifyNoShow(f.ticket.id);
    await notifyNoShow(f.ticket.id);
    expect(post).toHaveBeenCalledOnce();
    expect(
      (
        await db.inspectionCompletion.findUniqueOrThrow({
          where: { ticketId: f.ticket.id },
        })
      ).notificationState,
    ).toBe("FAILED");
    expect(
      (
        await db.inspection.findUniqueOrThrow({
          where: { ticketId: f.ticket.id },
        })
      ).status,
    ).toBe("NO_SHOW");
  } finally {
    post.mockRestore();
  }
});
test("expired No Show disconnect and DM leases recover their saved decision and reference without a second notification", async () => {
  const { requestCompletion, leaseCompletion } =
    await import("../packages/queue-engine/src/completion");
  const { processCompletion, notifyNoShow } =
    await import("../apps/bot/src/completion");
  const { rest } = await import("../apps/bot/src/discord");
  const { createHash } = await import("node:crypto");
  const f = await completedFixture();
  await requestCompletion(
    guildId,
    f.ta.id,
    randomUUID(),
    f.target,
    "NO_SHOW",
    f.ticket.id,
  );
  await leaseCompletion(f.ticket.id);
  f.user.voice.channelId = null;
  await db.inspectionCompletion.update({
    where: { ticketId: f.ticket.id },
    data: { leaseUntil: new Date(0) },
  });
  await processCompletion(f.ticket.id);
  await db.inspectionCompletion.update({
    where: { ticketId: f.ticket.id },
    data: {
      notificationState: "SENDING",
      notificationChannelId: "existing-dm",
      leaseUntil: new Date(0),
    },
  });
  const ref = createHash("sha256")
    .update(`no-show:${f.ticket.id}`)
    .digest("hex")
    .slice(0, 12);
  const get = vi.spyOn(rest, "get").mockResolvedValue([
    {
      id: "sent-before-crash",
      author: { id: "bot" },
      embeds: [{ footer: { text: `อ้างอิง ${ref}` } }],
    },
  ]);
  const post = vi.spyOn(rest, "post").mockResolvedValue({ id: "unexpected" });
  try {
    await notifyNoShow(f.ticket.id);
    expect(post).not.toHaveBeenCalled();
    expect(
      (
        await db.inspectionCompletion.findUniqueOrThrow({
          where: { ticketId: f.ticket.id },
        })
      ).notificationMessageId,
    ).toBe("sent-before-crash");
    expect(f.user.voice.disconnect).not.toHaveBeenCalled();
  } finally {
    get.mockRestore();
    post.mockRestore();
  }
});

test("isolated performance workload measures acknowledgment, silent selection, transfers and unchanged panel synchronization", async () => {
  if (!process.env.PERFORMANCE_ADAPTER_OUTPUT) return;
  const { writeFileSync } = await import("node:fs");
  const { performance } = await import("node:perf_hooks");
  const { handleInteraction } = await import("../apps/bot/src/interactions");
  const { syncPanels, rest } = await import("../apps/bot/src/discord");
  const { defaults } = await import("../packages/discord-ui/src/index");
  const { processCompletion, notifyNoShow } =
    await import("../apps/bot/src/completion");
  const { requestCompletion } =
    await import("../packages/queue-engine/src/completion");
  const samples: Record<string, number[]> = {};
  const trace = (
    globalThis as unknown as {
      performanceTrace: { phase: string; counts: Record<string, number> };
    }
  ).performanceTrace;
  const record = async (name: string, fn: () => Promise<unknown>) => {
    trace.phase = name;
    const start = performance.now();
    try {
      await fn();
      (samples[name] ??= []).push(performance.now() - start);
    } finally {
      trace.phase = "";
    }
  };
  const user = member("perf-select-" + randomUUID(), "waiting");
  const course = await db.coursework.create({
    data: { guildId, name: "Synthetic performance course" },
  });
  for (let n = 0; n < 100; n++) {
    const start = performance.now();
    const i = {
      id: randomUUID(),
      guildId,
      channelId: "queue",
      customId: "ta:coursework",
      user: { id: user.id },
      values: [course.id],
      isButton: () => false,
      isModalSubmit: () => false,
      isStringSelectMenu: () => true,
      deferUpdate: vi.fn(async () => {
        (samples.acknowledgment ??= []).push(performance.now() - start);
      }),
      deferReply: vi.fn(),
      editReply: vi.fn(),
      followUp: vi.fn(),
    };
    await record("coursework", () =>
      handleInteraction(i as unknown as Interaction),
    );
    expect(i.deferUpdate).toHaveBeenCalledOnce();
    expect(i.editReply).not.toHaveBeenCalled();
    expect(i.followUp).not.toHaveBeenCalled();
  }
  const f = await completedFixture();
  const template = await db.embedTemplate.create({
    data: {
      guildId,
      feature: "ta_room_queue_panel",
      name: randomUUID(),
      document: defaults.ta_room_queue_panel,
    },
  });
  await db.publishedPanel.deleteMany({ where: { guildId } });
  const panelLookups: ReturnType<typeof vi.fn>[] = [];
  for (let n = 0; n < 6; n++) {
    const id = "perf-room-" + randomUUID() + "-" + n;
    const fetch = vi.fn(async () => ({ id: "perf-message-" + n }));
    panelLookups.push(fetch);
    channels.set(id, {
      id,
      isTextBased: () => true,
      messages: { fetch },
    });
    const panel = await db.publishedPanel.create({
      data: {
        guildId,
        channelId: id,
        templateId: template.id,
        messageId: "perf-message-" + n,
      },
    });
    await db.tARoomPanel.create({
      data: {
        guildId,
        voiceChannelId: id,
        destinationChannelId: id,
        templateId: template.id,
        publishedPanelId: panel.id,
      },
    });
  }
  const patch = vi.spyOn(rest, "patch").mockImplementation(async (route) => ({
    id: String(route).split("/").at(-1),
  }));
  const get = vi.spyOn(rest, "get").mockResolvedValue([]);
  const post = vi
    .spyOn(rest, "post")
    .mockImplementation(async (route) =>
      route === "/users/@me/channels"
        ? { id: "perf-dm" }
        : { id: "perf-dm-message" },
    );
  try {
    await syncPanels();
    patch.mockClear();
    for (let n = 0; n < 30; n++)
      await record("unchangedPanels", () => syncPanels());
    const repeatedPanelQueries = trace.counts["unchangedPanels.templates"] || 0;
    expect(patch).not.toHaveBeenCalled();
    const unchangedEdits = patch.mock.calls.length;
    for (const lookup of panelLookups) lookup.mockClear();
    for (let n = 0; n < 100; n++) {
      await db.embedTemplate.update({
        where: { id: template.id },
        data: {
          document: {
            ...defaults.ta_room_queue_panel,
            title: `Synthetic panel revision ${n}`,
          },
          version: { increment: 1 },
        },
      });
      await record("changedPanels", () => syncPanels(false, ["queue"]));
    }
    const changedPanelLookups = panelLookups.reduce(
      (total, lookup) => total + lookup.mock.calls.length,
      0,
    );
    const changedPanelEdits = patch.mock.calls.length;
    await requestCompletion(
      guildId,
      f.ta.id,
      randomUUID(),
      f.target,
      "NO_SHOW",
      f.ticket.id,
    );
    await record("noShow", () => processCompletion(f.ticket.id));
    await record("studentDM", () => notifyNoShow(f.ticket.id));
    const transfer = await transferFixture();
    await record("voiceMove", () =>
      processTransfer(transfer.claim.operationId),
    );
    const summarize = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const q = (p: number) => sorted[Math.ceil(sorted.length * p) - 1];
      return {
        samples: sorted.length,
        p50Ms: q(0.5),
        p95Ms: sorted.length >= 20 ? q(0.95) : null,
        p99Ms: sorted.length >= 100 ? q(0.99) : null,
      };
    };
    writeFileSync(
      process.env.PERFORMANCE_ADAPTER_OUTPUT,
      JSON.stringify(
        {
          operations: Object.fromEntries(
            Object.entries(samples).map(([name, value]) => [
              name,
              summarize(value),
            ]),
          ),
          selectionQueries: { sql: trace.counts.coursework },
          sqlQueries: trace.counts,
          unchangedPanelTemplateQueries: repeatedPanelQueries,
          unchangedPanelEdits: unchangedEdits,
          changedPanelLookups,
          changedPanelEdits,
          discordNetwork: false,
        },
        null,
        2,
      ),
    );
  } finally {
    patch.mockRestore();
    get.mockRestore();
    post.mockRestore();
  }
});

test("200 concurrent interaction deliveries acknowledge once each despite duplicate Gateway delivery", async () => {
  await import("../apps/bot/src/interactions");
  const dispatch = client.listeners("interactionCreate").at(-1) as (
    i: Interaction,
  ) => Promise<void>;
  const coursework = await db.coursework.create({
    data: { guildId, name: "Concurrent selections" },
  });
  const { performance } = await import("node:perf_hooks");
  const begin = performance.now(),
    samples: number[] = [];
  const interactions = Array.from({ length: 200 }, () => ({
    id: randomUUID(),
    guildId,
    customId: "ta:coursework",
    user: { id: randomUUID() },
    values: [coursework.id],
    isButton: () => false,
    isModalSubmit: () => false,
    isStringSelectMenu: () => true,
    deferUpdate: vi.fn(async () => {
      samples.push(performance.now() - begin);
    }),
    deferReply: vi.fn(),
    reply: vi.fn(),
    editReply: vi.fn(),
    followUp: vi.fn(),
  }));
  await Promise.all(
    interactions.flatMap((i) => [
      dispatch(i as unknown as Interaction),
      dispatch({ ...i } as unknown as Interaction),
    ]),
  );
  expect(samples).toHaveLength(200);
  for (const i of interactions) {
    expect(i.deferUpdate).toHaveBeenCalledOnce();
    expect(i.deferReply).not.toHaveBeenCalled();
    expect(i.editReply).not.toHaveBeenCalled();
    expect(i.followUp).not.toHaveBeenCalled();
  }
  expect(
    await db.draftSelection.count({
      where: { guildId, discordId: { in: interactions.map((i) => i.user.id) } },
    }),
  ).toBe(200);
  if (process.env.CONCURRENT_DISCORD_OUTPUT) {
    const { writeFileSync } = await import("node:fs");
    samples.sort((a, b) => a - b);
    writeFileSync(
      process.env.CONCURRENT_DISCORD_OUTPUT,
      JSON.stringify(
        {
          samples: samples.length,
          p50Ms: samples[99],
          p95Ms: samples[189],
          p99Ms: samples[197],
          duplicateDeliveriesIgnored: 200,
          discordNetwork: false,
        },
        null,
        2,
      ),
    );
  }
});

test("acknowledged voice-chat disclosure is isolated per room and never reveals waiting IDs through custom fields", async () => {
  const { syncPanels, rest } = await import("../apps/bot/src/discord");
  const { defaults } = await import("../packages/discord-ui/src/index");
  await db.publishedPanel.deleteMany({ where: { guildId } });
  const first = await transferFixture();
  await processTransfer(first.claim.operationId);
  const second = await transferFixture(false);
  await processTransfer(second.claim.operationId);
  await db.channelBinding.update({
    where: { guildId_feature: { guildId, feature: "ta_voice" } },
    data: { channelIds: [first.target, second.target] },
  });
  const settings = settingsSchema.parse(
    (await db.guild.findUniqueOrThrow({ where: { id: guildId } })).settings,
  );
  await db.guild.update({
    where: { id: guildId },
    data: {
      settings: {
        ...settings,
        publicStudentIds: "FULL",
        publicStudentNames: false,
      },
    },
  });
  const suffix = `${Date.now()}${counter}`;
  const fullId = "00110022" + suffix,
    publicId = "00330044" + suffix,
    replacementId = "00005566" + suffix;
  const waitingId = "00998877" + suffix;
  const waiting = await db.student.create({
    data: {
      guildId,
      studentId: waitingId,
      name: "Waiting",
      lastname: "Private",
      discordId: randomUUID(),
      registration: "REGISTERED",
    },
  });
  await admission(
    guildId,
    waiting.discordId!,
    randomUUID(),
    first.ticket.courseworkId,
  );
  const template = await db.embedTemplate.create({
    data: {
      guildId,
      feature: "ta_room_queue_panel",
      name: randomUUID(),
      document: {
        ...defaults.ta_room_queue_panel,
        description: "{room.current}\n{queue.top}",
        fields: [
          {
            name: "Identity",
            value:
              "{room.current.student_id} | {room.current.student_name} | {room.current.coursework} | {room.current.ticket} | {room.current.ta} | {room.current.status}",
          },
        ],
      },
    },
  });
  const panels: { id: string; channelId: string; messageId: string | null }[] =
    [];
  for (const [f, index] of [
    [first, 0],
    [second, 1],
  ] as const) {
    await db.student.update({
      where: { id: f.ticket.studentId },
      data: {
        studentId: index === 0 ? fullId : publicId,
        name: index === 0 ? "Verified First" : "Verified Second",
        lastname: "Student",
      },
    });
    const panel = await db.publishedPanel.create({
      data: {
        guildId,
        templateId: template.id,
        channelId: f.target,
        messageId: "persisted-" + index,
      },
    });
    panels.push(panel);
    await db.tARoomPanel.create({
      data: {
        guildId,
        templateId: template.id,
        voiceChannelId: f.target,
        destinationChannelId: f.target,
        publishedPanelId: panel.id,
        mode: "VOICE",
        visibility: index === 0 ? "FULL_INSPECTION_DETAILS" : "PUBLIC",
        studentIdDisclosureAcknowledged: index === 0,
      },
    });
    const channel = channels.get(f.target) as unknown as {
      isTextBased: () => boolean;
      messages: unknown;
    };
    channel.isTextBased = () => true;
    channel.messages = { fetch: vi.fn(async () => ({ id: panel.messageId })) };
    f.user.displayName = "999999 wrong nickname";
  }
  const patch = vi.spyOn(rest, "patch").mockImplementation(async (path) => ({
    id: String(path).split("/").at(-1)!,
  }));
  const post = vi.spyOn(rest, "post").mockResolvedValue({ id: "unexpected" });
  try {
    await syncPanels();
    const bodies = () =>
      panels.map((p) =>
        JSON.stringify(
          [...patch.mock.calls]
            .reverse()
            .find(
              ([path]) =>
                String(path) ===
                `/channels/${p.channelId}/messages/${p.messageId}`,
            )?.[1],
        ),
      );
    const [full, safe] = bodies();
    expect(full).toContain(fullId);
    expect(full).toContain("Verified First");
    expect(full).toContain("กำลังตรวจงาน");
    expect(full).toContain(`#${first.ticket.sequence}`);
    expect(full).not.toContain(publicId);
    expect(full).not.toContain(waitingId);
    expect(full).not.toContain("999999 wrong nickname");
    expect(safe).not.toContain(fullId);
    expect(safe).not.toContain(publicId);
    expect(safe).not.toContain(waitingId);
    await db.student.update({
      where: { id: first.ticket.studentId },
      data: { discordId: null },
    });
    await syncPanels();
    expect(bodies()[0]).toContain("ไม่พบรหัสนักศึกษา");
    await db.student.update({
      where: { id: first.ticket.studentId },
      data: { discordId: first.user.id, studentId: replacementId },
    });
    await syncPanels(true);
    expect(bodies()[0]).toContain(replacementId);
    expect(bodies()[0]).not.toContain(fullId);
    const edits = patch.mock.calls.length;
    await syncPanels();
    expect(patch.mock.calls.length).toBe(edits);
    expect(post).not.toHaveBeenCalled();
    expect(
      (
        await db.publishedPanel.findUniqueOrThrow({
          where: { id: panels[0].id },
        })
      ).messageId,
    ).toBe(panels[0].messageId);
  } finally {
    patch.mockRestore();
    post.mockRestore();
  }
});
