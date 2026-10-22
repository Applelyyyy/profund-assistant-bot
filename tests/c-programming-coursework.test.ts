import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { db } from "../packages/database/src/index";
import { canHandle } from "../packages/shared/src/index";
import { defaults, render } from "../packages/discord-ui/src/index";
import { snapshot } from "../packages/queue-engine/src/index";

const names = [
  "Lab01 C Language & Output Statement",
  "Lab02 Data Type & Input Statement",
  "Lab03 Flowchart and condition statement",
  "Lab04 Loop",
  "Lab06 Array",
  "Lab07 Structure",
  "Lab08 Pointer",
  "Lab09 Function",
];
let counter = 0;
async function fixture() {
  if (
    !process.env.TEST_DATABASE_URL ||
    !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
  )
    throw new Error("Dedicated test database required.");
  const guildId = `${Date.now()}${String(++counter).padStart(4, "0")}`;
  await db.guild.create({
    data: { id: guildId, name: "C Programming import test" },
  });
  return guildId;
}
function run(guildId: string) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", resolve("scripts/import-c-programming.ts")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        DISCORD_GUILD_ID: guildId,
      },
    },
  );
}
test("imports eight ordered labs, reuses historical IDs, preserves unrelated records and is idempotent", async () => {
  const guildId = await fixture();
  const existing = await db.coursework.create({
    data: {
      guildId,
      name: names[1],
      enabled: false,
      archived: true,
      sortOrder: 30,
      eligibleRoles: ["100000000000000001"],
      startsAt: new Date(),
      description: "Keep this note",
    },
  });
  const unrelated = await db.coursework.create({
    data: { guildId, name: "Other coursework", sortOrder: 99 },
  });
  const excluded = await db.coursework.create({
    data: {
      guildId,
      name: "Lab05 Self practice",
      archived: true,
      enabled: false,
    },
  });
  const student = await db.student.create({
    data: { guildId, studentId: "001", name: "Test", lastname: "Student" },
  });
  const ticket = await db.queueTicket.create({
    data: {
      guildId,
      studentId: student.id,
      courseworkId: existing.id,
      sequence: 1,
      status: "COMPLETED",
    },
  });
  const inspection = await db.inspection.create({
    data: {
      ticketId: ticket.id,
      taId: "100000000000000002",
      status: "COMPLETED",
      completedAt: new Date(),
    },
  });
  const first = run(guildId);
  expect(first.status, first.stderr).toBe(0);
  expect(JSON.parse(first.stdout)).toMatchObject({
    created: 7,
    updated: 1,
    reused: 1,
  });
  const rows = await db.coursework.findMany({
    where: { guildId, name: { in: names } },
    orderBy: { sortOrder: "asc" },
  });
  expect(rows.map((c) => c.name)).toEqual(names);
  expect(rows.map((c) => c.sortOrder)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  expect(rows[1].id).toBe(existing.id);
  expect(rows[1].description).toBe("Keep this note");
  for (const row of rows) {
    expect(row).toMatchObject({
      label: "C Programming",
      enabled: true,
      archived: false,
      eligibleUsers: [],
      eligibleRoles: [],
      startsAt: null,
      endsAt: null,
    });
    expect(
      canHandle(
        row,
        { taId: "100000000000000003", roleIds: [], courseworkIds: [] },
        row.id,
      ),
    ).toBe(true);
  }
  const second = run(guildId);
  expect(second.status, second.stderr).toBe(0);
  expect(JSON.parse(second.stdout)).toMatchObject({
    created: 0,
    updated: 0,
    reused: 8,
  });
  expect(await db.coursework.count({ where: { guildId } })).toBe(10);
  expect(
    await db.coursework.findUnique({ where: { id: unrelated.id } }),
  ).toEqual(unrelated);
  expect(
    await db.coursework.findUnique({ where: { id: excluded.id } }),
  ).toEqual(excluded);
  expect(await db.queueTicket.findUnique({ where: { id: ticket.id } })).toEqual(
    ticket,
  );
  expect(
    await db.inspection.findUnique({ where: { id: inspection.id } }),
  ).toEqual(inspection);
  const state = await snapshot(guildId);
  const selected = state.courses.filter((c) => names.includes(c.name));
  expect(selected.map((c) => c.id)).toEqual(rows.map((c) => c.id));
  const dropdown = render(defaults.student_queue, {}, selected)
    .components[0] as {
    components: { options: { label: string; value: string }[] }[];
  };
  expect(dropdown.components[0].options).toEqual(
    rows.map((c) => ({ label: c.name, value: c.id })),
  );
});

test("ambiguous existing lab names abort without partially importing or deleting anything", async () => {
  const guildId = await fixture();
  await db.coursework.createMany({
    data: [
      { guildId, name: names[1] },
      { guildId, name: names[1] },
    ],
  });
  const before = await db.coursework.findMany({
    where: { guildId },
    orderBy: { id: "asc" },
  });
  const result = run(guildId);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Duplicate existing coursework");
  expect(
    await db.coursework.findMany({
      where: { guildId },
      orderBy: { id: "asc" },
    }),
  ).toEqual(before);
});
