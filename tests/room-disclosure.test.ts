import { test, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { REST, PermissionFlagsBits as P } from "discord.js";
import { NextRequest } from "next/server";
import { db } from "../packages/database/src/index";
import { roomPanelSchema, settingsSchema } from "../packages/shared/src/index";
import { tokenHash } from "../packages/shared/src/auth";
import { defaults } from "../packages/discord-ui/src/index";
import { prepareRoomPanel } from "../packages/config/src/room-panels";
import { POST } from "../apps/web/app/api/[...path]/route";
const guildId = process.env.DISCORD_GUILD_ID!,
  room = "100000000000000081",
  bot = "100000000000000082",
  botRole = "100000000000000083";
const channels = [
  { id: room, name: "Existing TA room", type: 2, permission_overwrites: [] },
];
const read = async (path: string) => {
  if (path.endsWith("threads/active")) return { threads: [] };
  if (path.endsWith("/channels")) return channels;
  if (path.endsWith("/roles"))
    return [
      { id: guildId, name: "@everyone", permissions: "0", position: 0 },
      {
        id: botRole,
        name: "Bot",
        permissions: String(P.Administrator),
        position: 10,
      },
    ];
  if (path.endsWith(`/members/${bot}`)) return { roles: [botRole] };
  if (path === "users/@me") return { id: bot };
  throw new Error("Unexpected directory path " + path);
};
async function fixture() {
  await db.guild.upsert({
    where: { id: guildId },
    create: {
      id: guildId,
      name: "Disclosure test",
      settings: settingsSchema.parse({}),
    },
    update: {},
  });
  await db.channelBinding.upsert({
    where: { guildId_feature: { guildId, feature: "ta_voice" } },
    create: { guildId, feature: "ta_voice", channelIds: [room] },
    update: { channelIds: [room] },
  });
  const template = await db.embedTemplate.create({
    data: {
      guildId,
      feature: "ta_room_queue_panel",
      name: randomUUID(),
      document: defaults.ta_room_queue_panel,
    },
  });
  return {
    voiceChannelId: room,
    destinationChannelId: room,
    mode: "VOICE" as const,
    visibility: "FULL_INSPECTION_DETAILS" as const,
    studentIdDisclosureAcknowledged: true,
    templateId: template.id,
  };
}
async function request(
  role: "OWNER" | "ADMIN" | "VIEWER" | "OPERATOR",
  path: string[],
  payload: unknown,
) {
  const token = randomUUID(),
    user = await db.adminUser.create({
      data: {
        username: randomUUID(),
        passwordHash: "unusable-test-hash",
        role,
      },
    });
  await db.adminSession.create({
    data: {
      id: tokenHash(token),
      adminId: user.id,
      csrf: token,
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  const req = new NextRequest(
    process.env.APP_BASE_URL! + "/api/" + path.join("/"),
    {
      method: "POST",
      headers: {
        cookie: `ta_session=${token}`,
        origin: process.env.APP_BASE_URL!,
        "x-csrf-token": token,
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
      },
      body: JSON.stringify(payload),
    },
  );
  return {
    response: await POST(req, { params: Promise.resolve({ path }) }),
    actor: user.id,
  };
}
test("full-details schema requires explicit boolean consent; legacy public-safe remains default", () => {
  const input = {
    voiceChannelId: room,
    destinationChannelId: room,
    mode: "VOICE",
    templateId: "fixture",
  };
  expect(roomPanelSchema.parse(input).visibility).toBe("PUBLIC");
  for (const consent of [undefined, false, "true"])
    expect(
      roomPanelSchema.safeParse({
        ...input,
        visibility: "FULL_INSPECTION_DETAILS",
        studentIdDisclosureAcknowledged: consent,
      }).success,
    ).toBe(false);
  expect(
    roomPanelSchema.parse({
      ...input,
      visibility: "FULL_INSPECTION_DETAILS",
      studentIdDisclosureAcknowledged: true,
    }).studentIdDisclosureAcknowledged,
  ).toBe(true);
});
test("disclosure preview preserves channel permissions, binds consent to destination and enforces bot messaging access", async () => {
  const input = await fixture();
  const before = JSON.stringify(channels);
  const plan = await prepareRoomPanel(guildId, input, read);
  expect(plan.plan.changes).toEqual([]);
  expect(plan.proposed.channelVisibility).toEqual(plan.originalVisibility);
  expect(JSON.stringify(channels)).toBe(before);
  await expect(
    prepareRoomPanel(
      guildId,
      { ...input, studentIdDisclosureAcknowledged: false },
      read,
    ),
  ).rejects.toThrow("Full Student IDs");
  await expect(
    prepareRoomPanel(guildId, { ...input, destinationChannelId: bot }, read),
  ).rejects.toMatchObject({ code: "DESTINATION" });
  const noPermissions = async (path: string) =>
    path.endsWith("/roles")
      ? [
          { id: guildId, name: "@everyone", permissions: "0", position: 0 },
          { id: botRole, name: "Bot", permissions: "0", position: 10 },
        ]
      : read(path);
  await expect(
    prepareRoomPanel(guildId, input, noPermissions),
  ).rejects.toMatchObject({ code: "PANEL_PERMISSIONS" });
  const different = await prepareRoomPanel(
    guildId,
    { ...input, refreshSeconds: 45 },
    read,
  );
  expect(different.plan.fingerprint).not.toBe(plan.plan.fingerprint);
});
test("only administrators save acknowledged policies; republishing requires renewed consent and keeps the existing message", async () => {
  const input = await fixture();
  const spy = vi
    .spyOn(REST.prototype, "get")
    .mockImplementation(
      async (path) => read(String(path).replace(/^\//, "")) as never,
    );
  try {
    for (const role of ["VIEWER", "OPERATOR"] as const)
      expect(
        (await request(role, ["room-panels", "preview"], input)).response
          .status,
      ).toBe(403);
    expect(
      (
        await request("ADMIN", ["room-panels", "preview"], {
          ...input,
          studentIdDisclosureAcknowledged: false,
        })
      ).response.status,
    ).toBe(400);
    const previewResponse = (
      await request("ADMIN", ["room-panels", "preview"], input)
    ).response;
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json();
    expect(preview.changes).toEqual([]);
    expect(preview.inspectionPreview).toMatchObject({
      fullStudentIds: true,
      visibility: "FULL_INSPECTION_DETAILS",
    });
    const first = await request("ADMIN", ["room-panels"], {
      ...input,
      fingerprint: preview.fingerprint,
    });
    expect(first.response.status).toBe(200);
    const saved = await first.response.json();
    await db.publishedPanel.update({
      where: { id: saved.publishedPanelId },
      data: { messageId: "existing-message-reference" },
    });
    const secondPreview = await request(
      "ADMIN",
      ["room-panels", "preview"],
      input,
    );
    const second = await request("ADMIN", ["room-panels"], {
      ...input,
      fingerprint: (await secondPreview.response.json()).fingerprint,
    });
    expect(second.response.status).toBe(200);
    expect((await second.response.json()).publishedPanelId).toBe(
      saved.publishedPanelId,
    );
    expect(
      await db.tARoomPanel.findUniqueOrThrow({ where: { id: saved.id } }),
    ).toMatchObject({
      visibility: "FULL_INSPECTION_DETAILS",
      studentIdDisclosureAcknowledged: true,
    });
    expect(
      (await request("ADMIN", ["room-panels", saved.id, "publish"], {}))
        .response.status,
    ).toBe(400);
    expect(
      (
        await request("OPERATOR", ["room-panels", saved.id, "publish"], {
          studentIdDisclosureAcknowledged: true,
        })
      ).response.status,
    ).toBe(403);
    expect(
      (
        await request("ADMIN", ["room-panels", saved.id, "publish"], {
          studentIdDisclosureAcknowledged: true,
        })
      ).response.status,
    ).toBe(200);
    expect(
      (
        await db.publishedPanel.findUniqueOrThrow({
          where: { id: saved.publishedPanelId },
        })
      ).messageId,
    ).toBe("existing-message-reference");
    expect(
      await db.publishedPanel.count({
        where: { guildId, channelId: room, templateId: input.templateId },
      }),
    ).toBe(1);
    expect(
      await db.systemEvent.findFirst({
        where: {
          guildId,
          actorId: first.actor,
          type: "configuration.room_panel",
        },
      }),
    ).toMatchObject({
      data: {
        visibility: "FULL_INSPECTION_DETAILS",
        studentIdDisclosureAcknowledged: true,
      },
    });
    expect(
      await db.serviceOperation.findFirst({ where: { actorId: first.actor } }),
    ).toMatchObject({ action: "refresh_panels" });
    await expect(
      db.tARoomPanel.update({
        where: { id: saved.id },
        data: { studentIdDisclosureAcknowledged: false },
      }),
    ).rejects.toThrow();
    await db.$disconnect();
    expect(
      await db.tARoomPanel.findUniqueOrThrow({ where: { id: saved.id } }),
    ).toMatchObject({ studentIdDisclosureAcknowledged: true });
  } finally {
    spy.mockRestore();
  }
});
