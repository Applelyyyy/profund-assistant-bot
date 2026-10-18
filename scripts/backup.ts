import { resolve } from "node:path";
import { env } from "../packages/config/src/index";
import { databaseBackup } from "../packages/config/src/backup";
async function main() {
  const path = resolve(process.argv[2] || "backups", `ta-${Date.now()}.dump`);
  await databaseBackup(env().DATABASE_URL, path);
  process.stdout.write(`Backup written: ${path}\n`);
}
main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
