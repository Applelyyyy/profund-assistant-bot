import { randomUUID } from "node:crypto";
import { db } from "../../packages/database/src/index";
async function main() {
  const url = process.env.TEST_DATABASE_URL;
  if (
    !url ||
    url !== process.env.DATABASE_URL ||
    !new URL(url).pathname.endsWith("_test")
  )
    throw new Error("Dedicated test database required");
  await db.systemEvent.createMany({
    data: Array.from({ length: 200 }, () => ({
      guildId: process.env.DISCORD_GUILD_ID!,
      actorId: "synthetic",
      type: "queue.claimed",
      message: "Synthetic browser invalidation burst",
      correlationId: randomUUID(),
    })),
  });
}
main().finally(() => db.$disconnect());
