import { test, expect } from "vitest";
import { mkdtemp, readFile, readdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { databaseBackup } from "../packages/config/src/backup";

test.skipIf(process.env.RUN_BACKUP_TESTS !== "true")(
  "real PostgreSQL archive validates, preserves existing backups, and removes failed partial dumps",
  async () => {
    if (!process.env.TEST_DATABASE_URL)
      throw new Error("Dedicated test database required.");
    const directory = await mkdtemp(join(tmpdir(), "ta-backup-"));
    const path = join(directory, "verified.dump");
    try {
      await databaseBackup(process.env.TEST_DATABASE_URL, path);
      const original = await readFile(path);
      expect(original.subarray(0, 5).toString()).toBe("PGDMP");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(
        execFileSync("pg_restore", ["--list", path], { encoding: "utf8" }),
      ).toContain("QueueTicket");
      await expect(
        databaseBackup(process.env.TEST_DATABASE_URL, path),
      ).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(path)).toEqual(original);
      const invalid = new URL(process.env.TEST_DATABASE_URL);
      invalid.pathname = "/does_not_exist_ta_backup_test";
      const partial = join(directory, "failed.dump");
      await expect(databaseBackup(invalid.toString(), partial)).rejects.toThrow(
        "pg_dump failed",
      );
      await expect(stat(partial)).rejects.toMatchObject({ code: "ENOENT" });
      const cliDirectory = join(directory, "cli");
      const output = execFileSync(
        process.execPath,
        ["--import", "tsx", resolve("scripts/backup.ts"), cliDirectory],
        {
          encoding: "utf8",
          env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
        },
      );
      expect(output).toContain("Backup written:");
      const [cliFile] = await readdir(cliDirectory);
      expect(
        (await readFile(join(cliDirectory, cliFile))).subarray(0, 5).toString(),
      ).toBe("PGDMP");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
