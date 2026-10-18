import { spawn } from "node:child_process";
import { mkdir, rm, open } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";

export async function databaseBackup(databaseUrl: string, path: string) {
  const url = new URL(databaseUrl);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, "wx", 0o600);
  const output = file.createWriteStream();
  const child = spawn(
    "pg_dump",
    ["--format=custom", "--no-owner", "--lock-wait-timeout=10s"],
    {
      env: {
        ...process.env,
        PGCONNECT_TIMEOUT: "10",
        PGHOST: url.hostname,
        PGPORT: url.port || "5432",
        PGUSER: decodeURIComponent(url.username),
        PGPASSWORD: decodeURIComponent(url.password),
        PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
        PGSSLMODE: url.searchParams.get("sslmode") || "prefer",
      },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 540000,
    },
  );
  try {
    await Promise.all([
      pipeline(child.stdout, output),
      new Promise<void>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0
            ? resolve()
            : reject(
                new Error(
                  "pg_dump failed. Check matching PostgreSQL client tools and backup permissions.",
                ),
              ),
        );
      }),
    ]);
  } catch (error) {
    child.kill("SIGTERM");
    output.destroy();
    await rm(path, { force: true });
    throw error;
  }
  return path;
}
