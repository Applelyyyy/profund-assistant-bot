import { resetAdministrator } from "../packages/shared/src/auth";
import { db } from "../packages/database/src/index";

async function main() {
  if (process.argv[2] !== "--confirm")
    throw new Error(
      "Explicit recovery only: pass --confirm to replace the configured administrator password and revoke their sessions.",
    );
  await resetAdministrator(
    process.env.ADMIN_BOOTSTRAP_USERNAME || "",
    process.env.ADMIN_BOOTSTRAP_PASSWORD || "",
  );
  process.stdout.write(
    "Administrator password reset from root .env. Existing sessions revoked.\n",
  );
}
main()
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
