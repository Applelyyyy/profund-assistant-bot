import { db } from "../../packages/database/src/index";
import { randomUUID } from "node:crypto";
async function main() {
  if (
    !process.env.TEST_DATABASE_URL ||
    process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL ||
    !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test")
  )
    throw new Error("Dedicated test database required");
  await db.systemEvent.createMany({
    data: Array.from({ length: 100 }, () => ({
      guildId: process.env.DISCORD_GUILD_ID!,
      actorId: "synthetic-performance-test",
      type: "inspection.note",
      message: "Synthetic private note change",
      correlationId: randomUUID(),
    })),
  });
  await db.$disconnect();
}
void main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
