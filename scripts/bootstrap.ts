import { bootstrap } from "../packages/shared/src/auth";
import { db } from "../packages/database/src/index";
async function main() {
  await bootstrap(
    process.env.ADMIN_BOOTSTRAP_USERNAME || "",
    process.env.ADMIN_BOOTSTRAP_PASSWORD || "",
  );
  process.stdout.write(
    "Administrator created. Remove bootstrap variables from the environment.\n",
  );
}
main()
  .catch((e) => {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
