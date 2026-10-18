import { db, Prisma } from "./index";
import { env } from "../../config/src/index";
import { defaults } from "../../discord-ui/src/index";
import { isLegacyDefault } from "../../discord-ui/src/default-upgrade";
import { settingsSchema } from "../../shared/src/index";
async function main() {
  const guildId = env().DISCORD_GUILD_ID;
  await db.guild.upsert({
    where: { id: guildId },
    create: {
      id: guildId,
      name: "Coursework Support",
      settings: settingsSchema.parse({}) as unknown as Prisma.InputJsonValue,
    },
    update: {},
  });
  for (const [feature, document] of Object.entries(defaults)) {
    const existing = await db.embedTemplate.findMany({
      where: { guildId, feature },
    });
    if (!existing.length)
      await db.embedTemplate.create({
        data: {
          guildId,
          feature,
          name: feature === "ta_room_queue_panel" ? "TA_ROOM_QUEUE_PANEL" : document.title,
          document: document as unknown as Prisma.InputJsonValue,
        },
      });
    for (const old of existing)
      if (isLegacyDefault(feature, old.document))
        await db.$transaction(async (tx) => {
          const upgraded = await tx.embedTemplate.updateMany({
            where: {
              id: old.id,
              version: old.version,
              document: { equals: old.document as Prisma.InputJsonValue },
            },
            data: {
              document: document as unknown as Prisma.InputJsonValue,
              version: { increment: 1 },
              versions: [
                ...(old.versions as Prisma.JsonArray),
                { version: old.version, document: old.document },
              ].slice(-30),
            },
          });
          if (!upgraded.count) return;
          await tx.systemEvent.create({
            data: {
              guildId,
              actorId: "system",
              type: "template.localized",
              message:
                "Untouched system template upgraded to Thai; previous version retained.",
              data: { templateId: old.id },
              correlationId: `thai-default-${old.id}`,
            },
          });
        });
  }
  if (!(await db.coursework.count({ where: { guildId } })))
    for (const [i, name] of [
      "Programming fundamentals",
      "Data structures",
      "Database systems",
    ].entries())
      await db.coursework.create({ data: { guildId, name, sortOrder: i } });
  process.stdout.write(
    "Seed complete. No student or queue activity was fabricated.\n",
  );
}
main()
  .catch((e) => {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
