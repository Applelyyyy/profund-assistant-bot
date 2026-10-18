import {
  readdir,
  stat,
  readFile,
  mkdir,
  copyFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { DomainError } from "../../shared/src/index";
export const logsDirectory = resolve(
  process.cwd().includes("/apps/") ? "../.." : ".",
  "logs",
);
export function currentLogName(now = new Date()) {
  return `runtime-${now.toISOString().slice(0, 10)}.ndjson`;
}
export async function archivePreview(
  from?: Date,
  through?: Date,
  now = new Date(),
  directory = logsDirectory,
) {
  const entries = [];
  for (const name of await readdir(directory).catch((e) => {
    if (e.code === "ENOENT") return [];
    throw e;
  })) {
    if (
      !/^runtime-\d{4}-\d{2}-\d{2}\.ndjson$/.test(name) &&
      name !== "platform.ndjson"
    )
      continue;
    const path = join(directory, name),
      info = await stat(path);
    if (name === currentLogName(now) || info.mtimeMs > now.getTime() - 300000)
      continue;
    if (info.size > 32 * 1024 * 1024)
      throw new DomainError(
        "LOG_SIZE",
        "Archive exceeds 32 MB; archive it externally before cleanup.",
        409,
      );
    const contents = await readFile(path, "utf8");
    const lines = contents.split("\n").filter(Boolean);
    const matches = lines.filter((line) => {
      try {
        const time = new Date(JSON.parse(line).time);
        return (
          Number.isFinite(time.getTime()) &&
          (!from || time >= from) &&
          (!through || time < through)
        );
      } catch {
        return false;
      }
    }).length;
    if (matches)
      entries.push({
        name,
        hash: createHash("sha256").update(contents).digest("hex"),
        records: matches,
      });
  }
  return entries;
}
export async function cleanArchives(
  entries: Awaited<ReturnType<typeof archivePreview>>,
  backupDirectory: string,
  from?: Date,
  through?: Date,
  directory = logsDirectory,
) {
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  let removed = 0;
  for (const entry of entries) {
    if (
      entry.name === currentLogName() ||
      (!/^runtime-\d{4}-\d{2}-\d{2}\.ndjson$/.test(entry.name) &&
        entry.name !== "platform.ndjson")
    )
      throw new Error("Active or invalid log archive.");
    const path = join(directory, entry.name),
      backup = join(backupDirectory, entry.name);
    const contents = await readFile(path, "utf8").catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (contents === null) {
      removed += entry.records;
      continue;
    }
    const hash = createHash("sha256").update(contents).digest("hex");
    // A copied archive permits retry after a crash between replacement and plan completion.
    if (hash !== entry.hash) {
      const old = await readFile(backup, "utf8").catch(() => null);
      if (!old || createHash("sha256").update(old).digest("hex") !== entry.hash)
        throw new Error("Log archive changed; preview cleanup again.");
      const expected = old.split("\n").filter((line) => {
        if (!line) return false;
        try {
          const time = new Date(JSON.parse(line).time);
          return (
            !Number.isFinite(time.getTime()) ||
            (!!from && time < from) ||
            (!!through && time >= through)
          );
        } catch {
          return true;
        }
      });
      const expectedContents = expected.length
        ? expected.join("\n") + "\n"
        : "";
      if (contents !== expectedContents)
        throw new Error("Log archive changed; preview cleanup again.");
      removed += entry.records;
      continue;
    }
    await copyFile(path, backup);
    const kept = contents.split("\n").filter((line) => {
      if (!line) return false;
      try {
        const time = new Date(JSON.parse(line).time);
        return (
          !Number.isFinite(time.getTime()) ||
          (!!from && time < from) ||
          (!!through && time >= through)
        );
      } catch {
        return true;
      }
    });
    if (kept.length) {
      await writeFile(path + ".maintenance", kept.join("\n") + "\n", {
        mode: 0o600,
      });
      await rename(path + ".maintenance", path);
    } else await rm(path);
    removed += entry.records;
  }
  return removed;
}
