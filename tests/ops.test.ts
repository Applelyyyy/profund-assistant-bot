import { test, expect, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { db } from "../packages/database/src/index";
import { env } from "../packages/config/src/index";
import { settingsSchema } from "../packages/shared/src/index";
import { startSession, admission } from "../packages/queue-engine/src/index";

afterAll(() => db.$disconnect());
async function waitFor(check: () => Promise<boolean>) {
  for (let n = 0; n < 150; n++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Supervisor did not reach the expected state.");
}
async function stop(child: ChildProcess) {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Supervisor did not stop gracefully.")),
      20000,
    );
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
test("restricted supervisor restarts the worker without queue loss and rejects a non-owner request", async () => {
  if (!process.env.TEST_DATABASE_URL)
    throw new Error("Dedicated test database required.");
  const guildId = `8${Date.now()}0001`;
  await db.guild.create({
    data: {
      id: guildId,
      name: "Supervisor test",
      settings: settingsSchema.parse({ minCapacity: 1, defaultCapacity: 1 }),
    },
  });
  const owner = await db.adminUser.create({
    data: {
      username: `ops-${Date.now()}`,
      passwordHash: "unusable-test-only-hash",
      role: "OWNER",
    },
  });
  const viewer = await db.adminUser.create({
    data: {
      username: `viewer-${Date.now()}`,
      passwordHash: "unusable-test-only-hash",
      role: "VIEWER",
    },
  });
  const course = await db.coursework.create({
    data: { guildId, name: "Supervisor course" },
  });
  await db.student.create({
    data: {
      guildId,
      studentId: "001",
      name: "Test",
      lastname: "Student",
      discordId: "student",
      registration: "REGISTERED",
    },
  });
  await startSession(guildId, "ta", "start", {
    taName: "TA",
    voiceChannelId: "room",
    capacity: 1,
    courseworkIds: [],
    roleIds: [],
    note: "",
  });
  const ticket = await admission(guildId, "student", "admit", course.id);
  const before = JSON.stringify(
    await db.queueTicket.findUnique({
      where: { id: ticket.id },
      include: { reservation: true },
    }),
  );
  const redis = new URL(env().REDIS_URL);
  redis.pathname = "/14";
  const started = Date.now();
  const supervisor = spawn(
    process.execPath,
    ["--import", "tsx", "apps/ops-agent/src/index.ts"],
    {
      env: {
        ...process.env,
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        DISCORD_GUILD_ID: guildId,
        REDIS_URL: redis.toString(),
        SERVICE_CONTROL_ENABLED: "true",
        DISCORD_BOT_TOKEN: "",
        LOG_LEVEL: "fatal",
      },
      stdio: "ignore",
    },
  );
  try {
    await waitFor(
      async () =>
        ((
          await db.serviceHeartbeat.findUnique({
            where: { service: "worker" },
          })
        )?.updatedAt.getTime() || 0) > started,
    );
    const operation = await db.serviceOperation.create({
      data: { guildId, actorId: owner.id, action: "restart_worker" },
    });
    await waitFor(
      async () =>
        (await db.serviceOperation.findUnique({ where: { id: operation.id } }))
          ?.status === "COMPLETED",
    );
    const forbidden = await db.serviceOperation.create({
      data: { guildId, actorId: viewer.id, action: "restart_worker" },
    });
    await waitFor(
      async () =>
        (await db.serviceOperation.findUnique({ where: { id: forbidden.id } }))
          ?.status === "FAILED",
    );
    expect(
      (await db.serviceOperation.findUnique({ where: { id: forbidden.id } }))!
        .error,
    ).toContain("owner");
  } finally {
    await stop(supervisor);
  }
  expect(
    JSON.stringify(
      await db.queueTicket.findUnique({
        where: { id: ticket.id },
        include: { reservation: true },
      }),
    ),
  ).toBe(before);
});
