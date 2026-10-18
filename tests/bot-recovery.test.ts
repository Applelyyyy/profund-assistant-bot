import { test, expect } from "vitest";
import { spawn, ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { db } from "../packages/database/src/index";
import { settingsSchema } from "../packages/shared/src/index";
import {
  startSession,
  admission,
  claimNext,
  leaseTransfer,
  integrity,
} from "../packages/queue-engine/src/index";
async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Bot recovery timed out");
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise<never>((_, reject) =>
      setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Bot failed graceful shutdown"));
      }, 15000),
    ),
  ]);
}
test.each(["COMPLETED", "NO_SHOW"] as const)(
  "actual bot restart preserves FIFO and finalizes a saved %s decision exactly once",
  async (outcome) => {
    if (
      !process.env.TEST_DATABASE_URL ||
      !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
    )
      throw new Error("Dedicated test database ending in _test required");
    const guildId = `${Date.now()}98765`,
      ta = "100000000000000011",
      taRole = "100000000000000012",
      student = "100000000000000013",
      nextStudent = "100000000000000014",
      room = "100000000000000015",
      waiting = "100000000000000016";
    await db.guild.create({
      data: {
        id: guildId,
        name: "Bot restart",
        settings: settingsSchema.parse({
          minCapacity: 1,
          defaultCapacity: 2,
          taRole,
          notifications: false,
          noShowDMEnabled: false,
        }),
      },
    });
    await db.channelBinding.create({
      data: { guildId, feature: "waiting_voice", channelIds: [waiting] },
    });
    await db.channelBinding.create({
      data: { guildId, feature: "ta_voice", channelIds: [room] },
    });
    const course = await db.coursework.create({
      data: { guildId, name: "FIFO restart coursework" },
    });
    for (const id of [student, nextStudent])
      await db.student.create({
        data: {
          guildId,
          studentId: id,
          discordId: id,
          name: "Synthetic",
          lastname: "Student",
          registration: "REGISTERED",
        },
      });
    await startSession(guildId, ta, randomUUID(), {
      taName: "Synthetic TA",
      voiceChannelId: room,
      capacity: 2,
      courseworkIds: [],
      roleIds: [taRole],
      note: "",
    });
    const head = await admission(guildId, student, randomUUID(), course.id),
      next = await admission(guildId, nextStudent, randomUUID(), course.id);
    const claim = await claimNext(guildId, ta, randomUUID());
    await leaseTransfer(claim.operationId);
    await db.voiceTransferOperation.update({
      where: { id: claim.operationId },
      data: { leaseUntil: new Date(Date.now() - 1000) },
    });
    const redis = new URL(process.env.REDIS_URL || "redis://127.0.0.1:6379");
    redis.pathname = "/13";
    const start = (channelId: string | null) =>
      spawn(
        process.execPath,
        ["--import", "tsx", "tests/fixtures/bot-runtime.ts"],
        {
          env: {
            ...process.env,
            DOCKER_DEPLOYMENT: "false",
            DISCORD_GUILD_ID: guildId,
            DISCORD_BOT_TOKEN: "test-only-token",
            REDIS_URL: redis.toString(),
            LOG_LEVEL: "error",
            BOT_TEST_VOICE: JSON.stringify({
              guildId,
              taRole,
              slowMember: nextStudent,
              members: {
                [ta]: room,
                [student]: channelId,
                [nextStudent]: waiting,
              },
            }),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    let output = "";
    let maintenanceFinished = false;
    let child = start(room);
    child.stderr?.on("data", (chunk) => {
      output = (output + String(chunk)).slice(-4000);
    });
    child.stdout?.on("data", (chunk) => {
      if (String(chunk).includes("maintenance.finished"))
        maintenanceFinished = true;
      output = (output + String(chunk)).slice(-4000);
    });
    try {
      await until(
        async () =>
          (await db.queueTicket.findUniqueOrThrow({ where: { id: head.id } }))
            .status === "IN_PROGRESS",
      );
      expect(maintenanceFinished).toBe(false);
      await stop(child);
      expect(await db.inspection.count({ where: { ticketId: head.id } })).toBe(
        1,
      );
      const { requestCompletion, leaseCompletion } =
        await import("../packages/queue-engine/src/completion");
      await requestCompletion(guildId, ta, randomUUID(), room, outcome);
      await leaseCompletion(head.id);
      await db.inspectionCompletion.update({
        where: { ticketId: head.id },
        data: { leaseUntil: new Date(0) },
      });
      const nextBefore = JSON.stringify(
        await db.queueTicket.findUniqueOrThrow({
          where: { id: next.id },
          include: { reservation: true },
        }),
      );
      child = start(null);
      await until(
        async () =>
          (await db.queueTicket.findUniqueOrThrow({ where: { id: head.id } }))
            .status === outcome,
      );
      expect(
        (
          await db.inspectionCompletion.findUniqueOrThrow({
            where: { ticketId: head.id },
          })
        ).state,
      ).toBe("SUCCEEDED");
      expect(await db.inspection.count({ where: { ticketId: head.id } })).toBe(
        1,
      );
      expect(
        (
          await db.inspection.findUniqueOrThrow({
            where: { ticketId: head.id },
          })
        ).completionReason,
      ).toBe(
        outcome === "NO_SHOW"
          ? "TA_MARKED_NO_SHOW"
          : "TA_COMPLETED_AND_DISCONNECTED",
      );
      expect(
        (
          await db.inspection.findUniqueOrThrow({
            where: { ticketId: head.id },
          })
        ).status,
      ).toBe(outcome);
      expect(
        JSON.stringify(
          await db.queueTicket.findUniqueOrThrow({
            where: { id: next.id },
            include: { reservation: true },
          }),
        ),
      ).toBe(nextBefore);
      expect(
        (await db.guild.findUniqueOrThrow({ where: { id: guildId } }))
          .nextSequence,
      ).toBe(next.sequence);
      expect(await integrity(guildId)).toMatchObject({ ok: true });
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : error} ${output}`,
      );
    } finally {
      await stop(child);
    }
  },
);
