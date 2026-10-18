import { open, readdir } from "node:fs/promises";
import { env } from "./index";

import { logsDirectory } from "./log-archives";
import { join } from "node:path";
export async function runtimeLogs() {
  const names = await readdir(logsDirectory).catch((e) => {
    if (e.code === "ENOENT") return [];
    throw e;
  });
  const logs = await Promise.all(
    names
      .filter(
        (n) =>
          /^runtime-\d{4}-\d{2}-\d{2}\.ndjson$/.test(n) ||
          n === "platform.ndjson",
      )
      .sort()
      .slice(-7)
      .map((n) => readLogs(join(logsDirectory, n))),
  );
  return logs
    .flat()
    .sort((a, b) => Number(b.time) - Number(a.time))
    .slice(0, 200);
}
async function readLogs(path: string) {
  const file = await open(path, "r").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!file) return [];
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - 1024 * 1024);
    const buffer = Buffer.alloc(size - start);
    await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start) lines.shift();
    const secrets = [
      env().DISCORD_BOT_TOKEN,
      env().DATABASE_URL,
      env().AUTH_SECRET,
    ].filter(Boolean);
    return lines
      .filter(Boolean)
      .slice(-200)
      .reverse()
      .flatMap((line) => {
        try {
          for (const secret of secrets)
            line = line.split(secret).join("[REDACTED]");
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
  } finally {
    await file.close();
  }
}
