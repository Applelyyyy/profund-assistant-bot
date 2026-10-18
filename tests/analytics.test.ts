import { test, expect, afterAll } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { GET } from "../apps/web/app/api/[...path]/route";
import { db } from "../packages/database/src/index";
import { env } from "../packages/config/src/index";
import { tokenHash } from "../packages/shared/src/auth";
import { settingsSchema } from "../packages/shared/src/index";
import {
  startSession,
  admission,
  claimNext,
  leaseTransfer,
  finalizeTransfer,
  completeInspection,
} from "../packages/queue-engine/src/index";

afterAll(() => db.$disconnect());
test("rankings count completion on its local date even when admission was the previous day", async () => {
  if (!process.env.TEST_DATABASE_URL)
    throw new Error("Dedicated test database required.");
  const guildId = env().DISCORD_GUILD_ID,
    unique = randomUUID();
  const guild = await db.guild.upsert({
    where: { id: guildId },
    create: {
      id: guildId,
      name: "Analytics test",
      settings: settingsSchema.parse({}),
    },
    update: {},
  });
  const settings = settingsSchema.parse(guild.settings);
  await db.guild.update({
    where: { id: guildId },
    data: { settings: { ...settings, timezone: "Asia/Bangkok" } },
  });
  const course = await db.coursework.create({
    data: { guildId, name: unique, eligibleUsers: [unique] },
  });
  await db.student.create({
    data: {
      guildId,
      studentId: unique,
      name: "Local",
      lastname: "Midnight",
      discordId: unique,
      registration: "REGISTERED",
    },
  });
  await startSession(guildId, unique, "start", {
    taName: unique,
    voiceChannelId: unique,
    capacity: settings.minCapacity,
    courseworkIds: [course.id],
    roleIds: [],
    note: "",
  });
  const ticket = await admission(guildId, unique, "admit", course.id);
  const claim = await claimNext(guildId, unique, "claim");
  const lease = await leaseTransfer(claim.operationId);
  await finalizeTransfer(claim.operationId, lease!.leaseToken, unique);
  await completeInspection(guildId, unique, "complete");
  await db.queueTicket.update({
    where: { id: ticket.id },
    data: { createdAt: new Date("2026-09-30T16:55:00Z") },
  });
  await db.inspection.update({
    where: { ticketId: ticket.id },
    data: {
      startedAt: new Date("2026-09-30T17:00:00Z"),
      completedAt: new Date("2026-09-30T17:05:00Z"),
    },
  });
  const user = await db.adminUser.create({
    data: {
      username: `analytics-${unique}`,
      passwordHash: "unusable-test-only-hash",
      role: "VIEWER",
    },
  });
  const token = randomBytes(32).toString("hex");
  await db.adminSession.create({
    data: {
      id: tokenHash(token),
      adminId: user.id,
      csrf: "test-only",
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  const request = async (date: string) => {
    const response = await GET(
      new NextRequest(
        `${env().APP_BASE_URL}/api/analytics?from=${date}&to=${date}`,
        { headers: { cookie: `ta_session=${token}` } },
      ),
      { params: Promise.resolve({ path: ["analytics"] }) },
    );
    expect(response.status).toBe(200);
    return response.json();
  };
  const completion = await request("2026-10-01");
  expect(
    completion.taRanking.find((ta: { taId: string }) => ta.taId === unique),
  ).toMatchObject({ completed: 1, averageSeconds: 300 });
  expect(
    completion.studentRanking.find(
      (student: { name: string; completed: number }) =>
        student.name === "Local Midnight" && student.completed === 1,
    ),
  ).toMatchObject({ tickets: 0, completed: 1 });
  const previous = await request("2026-09-30");
  expect(
    previous.taRanking.some((ta: { taId: string }) => ta.taId === unique),
  ).toBe(false);
});
