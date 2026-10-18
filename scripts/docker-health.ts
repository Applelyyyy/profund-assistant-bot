import { db } from "../packages/database/src/index";
async function main() {
  const service = process.argv[2];
  if (!["bot", "worker"].includes(service)) throw new Error("Unknown service.");
  const heartbeat = await db.serviceHeartbeat.findUnique({
    where: { service },
  });
  if (
    !heartbeat ||
    heartbeat.status !== "online" ||
    Date.now() - heartbeat.updatedAt.getTime() > 45000
  )
    throw new Error("Service is not ready.");
}
main()
  .catch(() => {
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
