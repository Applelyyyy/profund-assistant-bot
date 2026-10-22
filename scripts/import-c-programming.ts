import { db } from "../packages/database/src/index";
import { env } from "../packages/config/src/index";
import { courseworkSchema } from "../packages/shared/src/index";
import { event, locked } from "../packages/queue-engine/src/index";

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

async function main() {
  const guildId = env().DISCORD_GUILD_ID;
  const result = await locked(guildId, async (tx) => {
    const existing = await tx.coursework.findMany({ where: { guildId } });
    for (const name of names)
      if (existing.filter((course) => course.name === name).length > 1)
        throw new Error(
          `Duplicate existing coursework: ${name}. Resolve the ambiguity without deleting history before retrying.`,
        );
    let created = 0,
      updated = 0,
      reused = 0;
    for (const [index, name] of names.entries()) {
      const old = existing.find((course) => course.name === name);
      const input = courseworkSchema.parse({
        name,
        label: "C Programming",
        description: old?.description || "",
        enabled: true,
        archived: false,
        sortOrder: index + 1,
        eligibleUsers: [],
        eligibleRoles: [],
        startsAt: null,
        endsAt: null,
      });
      if (!old) {
        await tx.coursework.create({ data: { guildId, ...input } });
        created++;
      } else {
        reused++;
        const current = courseworkSchema.parse({
          ...old,
          startsAt: old.startsAt?.toISOString() ?? null,
          endsAt: old.endsAt?.toISOString() ?? null,
        });
        if (JSON.stringify(current) !== JSON.stringify(input)) {
          await tx.coursework.update({ where: { id: old.id }, data: input });
          updated++;
        }
      }
    }
    if (created || updated)
      await event(
        tx,
        guildId,
        "system",
        "coursework.catalog_imported",
        "C Programming labs imported with consecutive display order; existing IDs and history preserved.",
        { created, updated, reused },
      );
    return {
      created,
      updated,
      reused,
      courses: await tx.coursework.findMany({
        where: { guildId, name: { in: names } },
        orderBy: { sortOrder: "asc" },
      }),
      excludedExisting: existing
        .filter((course) => /^Lab(?:0?5|10)(?:\s|$)/i.test(course.name))
        .map(({ id, name, enabled, archived }) => ({
          id,
          name,
          enabled,
          archived,
        })),
    };
  });
  process.stdout.write(JSON.stringify(result) + "\n");
}

main()
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
