import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Collection, type OAuth2Guild } from "discord.js";
import { db } from "../packages/database/src/index";
import { settingsSchema } from "../packages/shared/src/index";
import { defaults } from "../packages/discord-ui/src/index";
import * as discord from "../apps/bot/src/discord";
import { NextRequest } from "next/server";
import { POST } from "../apps/web/app/api/[...path]/route";
import { tokenHash } from "../packages/shared/src/auth";

const guildId = process.env.DISCORD_GUILD_ID!;
const studentRole = "100000000000000002";
const members = new Collection<string, unknown>();
const channels = new Collection<string, unknown>();
beforeAll(async () => {
  if (
    !new URL(
      process.env.TEST_DATABASE_URL || "http://invalid",
    ).pathname.endsWith("_test")
  )
    throw new Error("Dedicated test database required.");
  await db.guild.upsert({
    where: { id: guildId },
    create: { id: guildId, name: "Recovery tests" },
    update: {},
  });
  await db.guild.update({
    where: { id: guildId },
    data: { settings: settingsSchema.parse({ studentRole }) },
  });
  await db.publishedPanel.updateMany({
    where: { guildId },
    data: { active: false },
  });
  vi.spyOn(discord.client.guilds, "fetch").mockResolvedValue({
    id: guildId,
    members: { fetch: vi.fn(async () => members) },
    channels: { fetch: vi.fn(async (id: string) => channels.get(id)) },
  } as unknown as Collection<string, OAuth2Guild>);
  Object.defineProperty(discord.client, "user", {
    value: { id: "recovery-bot" },
    configurable: true,
  });
});
afterAll(async () => {
  vi.restoreAllMocks();
  await db.$disconnect();
});

test.each([false, true])(
  "recovers an existing bot panel after DB loss, including voice chat (%s), without sending a duplicate",
  async (voice) => {
    const channelId = randomUUID();
    const feature = voice ? "ta_room_queue_panel" : "registration";
    const template = await db.embedTemplate.create({
      data: {
        guildId,
        name: randomUUID(),
        feature,
        document: defaults[feature],
      },
    });
    const panel = await db.publishedPanel.create({
      data: { guildId, templateId: template.id, channelId },
    });
    if (voice)
      await db.tARoomPanel.create({
        data: {
          guildId,
          voiceChannelId: channelId,
          destinationChannelId: channelId,
          templateId: template.id,
          publishedPanelId: panel.id,
          mode: "VOICE",
        },
      });
    channels.set(channelId, {
      isTextBased: () => true,
      messages: { fetch: async () => ({ id: "old-panel" }) },
    });
    const controls = voice
      ? [
          "start",
          "stop",
          "CALL_NEXT_STUDENT",
          "complete",
          "my_queue",
          "MARK_STUDENT_NO_SHOW",
          "retry",
          "return",
          "session_settings",
          "note",
        ]
      : ["verify"];
    const old = {
      id: "old-panel",
      author: { id: "recovery-bot" },
      flags: 0,
      embeds: [{ title: defaults[feature].title }],
      components: [
        {
          type: 1,
          components: controls.map((a) => ({
            type: 2,
            custom_id: `ta:${a}${voice ? ":" + channelId : ""}`,
          })),
        },
      ],
    };
    const get = vi
      .spyOn(discord.rest, "get")
      .mockImplementation(async (route, options) => {
        if (String(route).endsWith("/pins"))
          return { items: voice ? [] : [{ message: old }], has_more: false };
        if (voice && !options?.query?.has("before"))
          return Array.from({ length: 100 }, (_, index) => ({
            ...old,
            id: `foreign-${index}`,
            author: { id: "other-bot" },
          }));
        return [old];
      });
    const post = vi
      .spyOn(discord.rest, "post")
      .mockResolvedValue({ id: "duplicate" });
    const patch = vi
      .spyOn(discord.rest, "patch")
      .mockResolvedValue({ id: "old-panel" });
    try {
      await discord.syncPanels(true);
      expect(
        await db.publishedPanel.findUnique({ where: { id: panel.id } }),
      ).toMatchObject({ messageId: "old-panel", error: null, version: 1 });
      expect(post).not.toHaveBeenCalled();
      expect(
        patch.mock.calls.some(
          ([path]) => path === `/channels/${channelId}/messages/old-panel`,
        ),
      ).toBe(true);
      expect(
        await db.systemEvent.count({
          where: {
            guildId,
            type: "panel.recovered",
            data: { path: ["panelId"], equals: panel.id },
          },
        }),
      ).toBe(1);
      await discord.syncPanels(true);
      expect(post).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
      post.mockRestore();
      patch.mockRestore();
      await db.tARoomPanel.deleteMany({
        where: { publishedPanelId: panel.id },
      });
      await db.publishedPanel.delete({ where: { id: panel.id } });
    }
  },
);

test("identity recovery requires the old student role and an exact ID/name match and never overwrites existing mappings", async () => {
  const suffix = randomUUID().slice(0, 8);
  const records = await Promise.all(
    ["match", "no-role", "wrong-name", "duplicate", "existing", "pending"].map(
      (label, index) =>
        db.student.create({
          data: {
            guildId,
            studentId: `00${index}${suffix}`,
            name: `Name${index}`,
            lastname: "Last",
            ...(label === "existing"
              ? {
                  discordId: "already-linked-" + suffix,
                  registration: "REGISTERED",
                }
              : {}),
            ...(label === "pending"
              ? { registration: "APPROVAL_PENDING" }
              : {}),
          },
        }),
    ),
  );
  members.clear();
  const add = (
    index: number,
    id: string,
    role = true,
    name = records[index].name,
  ) =>
    members.set(id, {
      id,
      nickname: `${records[index].studentId} ${name}`,
      user: { bot: false },
      roles: { cache: new Map(role ? [[studentRole, {}]] : []) },
    });
  records.forEach((_, i) =>
    add(
      i,
      `member-${i}-${suffix}`,
      i !== 1,
      i === 2 ? "Wrong" : records[i].name,
    ),
  );
  add(3, "second-duplicate-" + suffix);
  try {
    const result = await discord.recoverIdentities(guildId, "test-admin");
    expect(result.recovered).toBe(1);
    expect(
      await db.student.findUnique({ where: { id: records[0].id } }),
    ).toMatchObject({
      discordId: `member-0-${suffix}`,
      registration: "REGISTERED",
    });
    for (const i of [1, 2, 3, 5])
      expect(
        await db.student.findUnique({ where: { id: records[i].id } }),
      ).toMatchObject({
        discordId: null,
        registration: i === 5 ? "APPROVAL_PENDING" : "UNREGISTERED",
      });
    expect(
      await db.student.findUnique({ where: { id: records[4].id } }),
    ).toMatchObject({ discordId: "already-linked-" + suffix });
    expect(
      (await discord.recoverIdentities(guildId, "test-admin")).recovered,
    ).toBe(0);
  } finally {
    members.clear();
  }
});

test.each(["permissions", "history-limit"])(
  "does not send a new panel when discovery cannot safely finish (%s)",
  async (failure) => {
    const channelId = randomUUID();
    const template = await db.embedTemplate.create({
      data: {
        guildId,
        name: randomUUID(),
        feature: "registration",
        document: defaults.registration,
      },
    });
    const panel = await db.publishedPanel.create({
      data: { guildId, templateId: template.id, channelId },
    });
    channels.set(channelId, { isTextBased: () => true, messages: {} });
    const get = vi
      .spyOn(discord.rest, "get")
      .mockImplementation(async (route) => {
        if (failure === "permissions")
          throw Object.assign(new Error("Missing Read Message History"), {
            code: 50013,
          });
        if (String(route).endsWith("/pins"))
          return { items: [], has_more: false };
        return Array.from({ length: 100 }, (_, i) => ({
          id: String(i),
          author: { id: "unrelated" },
          embeds: [],
        }));
      });
    const post = vi
      .spyOn(discord.rest, "post")
      .mockResolvedValue({ id: "unwanted-duplicate" });
    try {
      await discord.syncPanels(true);
      const saved = await db.publishedPanel.findUniqueOrThrow({
        where: { id: panel.id },
      });
      expect(saved.messageId).toBeNull();
      expect(saved.error).toBeTruthy();
      expect(post).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
      post.mockRestore();
      await db.publishedPanel.delete({ where: { id: panel.id } });
    }
  },
);

test("an ambiguous short nickname prevents recovery even when a full-name variant is unique", async () => {
  members.clear();
  const student = await db.student.create({
    data: {
      guildId,
      studentId: `00${Date.now()}`,
      name: "Name",
      lastname: "Last",
    },
  });
  for (const [id, nickname] of [
    ["short-a", `${student.studentId} Name`],
    ["short-b", `${student.studentId} Name`],
    ["full-c", `${student.studentId} Name Last`],
  ])
    members.set(id, {
      id,
      nickname,
      user: { bot: false },
      roles: { cache: new Map([[studentRole, {}]]) },
    });
  try {
    expect(
      (await discord.recoverIdentities(guildId, "test-admin")).recovered,
    ).toBe(0);
    expect(
      await db.student.findUnique({ where: { id: student.id } }),
    ).toMatchObject({ discordId: null, registration: "UNREGISTERED" });
  } finally {
    members.clear();
  }
});

async function request(path: string[], payload: unknown, role = "ADMIN") {
  const token = randomUUID();
  const admin = await db.adminUser.create({
    data: { username: randomUUID(), passwordHash: "unusable", role },
  });
  await db.adminSession.create({
    data: {
      id: tokenHash(token),
      adminId: admin.id,
      csrf: token,
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  return POST(
    new NextRequest(process.env.APP_BASE_URL! + "/api/" + path.join("/"), {
      method: "POST",
      headers: {
        cookie: `ta_session=${token}`,
        origin: process.env.APP_BASE_URL!,
        "x-csrf-token": token,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    }),
    { params: Promise.resolve({ path }) },
  );
}

test("CSV import queues identity recovery once and a manual rescan requires administrator access", async () => {
  await db.serviceOperation.deleteMany({
    where: { guildId, action: "recover_identities" },
  });
  const preview = await request(["students", "preview"], {
    csv: `id,name,lastname\n00${Date.now()},Import,Student\n`,
    filename: "students.csv",
  });
  expect(preview.status).toBe(200);
  // Imports belong to the actor who previews them. Use a shared session for commit below.
  const imp = await preview.json();
  const token = randomUUID();
  await db.adminSession.create({
    data: {
      id: tokenHash(token),
      adminId: imp.actorId,
      csrf: token,
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  const committed = await POST(
    new NextRequest(process.env.APP_BASE_URL! + "/api/students/commit", {
      method: "POST",
      headers: {
        cookie: `ta_session=${token}`,
        origin: process.env.APP_BASE_URL!,
        "x-csrf-token": token,
      },
      body: JSON.stringify({ importId: imp.id, duplicates: "skip" }),
    }),
    { params: Promise.resolve({ path: ["students", "commit"] }) },
  );
  expect(committed.status).toBe(200);
  expect(
    await db.serviceOperation.count({
      where: { guildId, action: "recover_identities", status: "PENDING" },
    }),
  ).toBe(1);
  const scan = await request(["students", "recover-mappings"], {});
  expect(scan.status).toBe(200);
  expect(
    await db.serviceOperation.count({
      where: { guildId, action: "recover_identities", status: "PENDING" },
    }),
  ).toBe(1);
  expect(
    (await request(["students", "recover-mappings"], {}, "VIEWER")).status,
  ).toBe(403);
  expect(
    (await request(["students", "recover-mappings"], {}, "OPERATOR")).status,
  ).toBe(403);
});
