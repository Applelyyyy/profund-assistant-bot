import { spawnSync } from "node:child_process";
import { db } from "../packages/database/src/index";
import { bootstrap } from "../packages/shared/src/auth";

async function main() {
  for (const command of ["db:migrate", "db:seed"]) {
    const result = spawnSync("pnpm", [command], { stdio: "inherit" });
    if (result.status !== 0)
      throw new Error(
        `${command} failed; application services were not started.`,
      );
  }
  if (await db.adminUser.count()) {
    process.stdout.write(
      "Existing administrator accounts preserved. Sign in with your existing account.\n",
    );
  } else {
    const username = process.env.ADMIN_BOOTSTRAP_USERNAME || "";
    const password = process.env.ADMIN_BOOTSTRAP_PASSWORD || "";
    await bootstrap(username, password);
    process.stdout.write(
      "Owner created from ADMIN_BOOTSTRAP_USERNAME and ADMIN_BOOTSTRAP_PASSWORD in root .env.\n",
    );
  }
}
main()
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
