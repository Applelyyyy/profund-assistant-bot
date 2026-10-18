import { afterEach, expect, test } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { dockerEnvironment } from "../packages/config/src/docker";

const values = {
  POSTGRES_USER: "ta",
  POSTGRES_DB: "ta_queue",
  POSTGRES_PASSWORD: "spaces $:#/@ password",
  REDIS_PASSWORD: "redis $:#/@ password",
  AUTH_SECRET: "a".repeat(32),
  DISCORD_BOT_TOKEN: "private-token",
  DISCORD_CLIENT_ID: "100000000000000001",
  DISCORD_GUILD_ID: "100000000000000002",
  APP_BASE_URL: "http://10.60.3.1:3000",
};
test("Docker constructs internal URLs with safely encoded secrets and ignores legacy host URLs", () => {
  const result = dockerEnvironment({
    ...values,
    DATABASE_URL: "postgresql://old/old",
    REDIS_URL: "redis://localhost",
  });
  const pg = new URL(result.DATABASE_URL!),
    redis = new URL(result.REDIS_URL!);
  expect(pg.hostname).toBe("postgres");
  expect(decodeURIComponent(pg.password)).toBe(values.POSTGRES_PASSWORD);
  expect(redis.hostname).toBe("redis");
  expect(decodeURIComponent(redis.password)).toBe(values.REDIS_PASSWORD);
  expect(result.WEB_HOST).toBe("0.0.0.0");
  expect(result.WEB_PORT).toBe("3000");
  expect(result.NODE_ENV).toBe("production");
});
test("Docker validation names missing or invalid settings without including secrets", () => {
  expect(() =>
    dockerEnvironment({ ...values, DISCORD_CLIENT_ID: "bad" }),
  ).toThrow("DISCORD_CLIENT_ID");
  expect(() => dockerEnvironment({ ...values, AUTH_SECRET: "short" })).toThrow(
    "AUTH_SECRET",
  );
  expect(() =>
    dockerEnvironment({ ...values, APP_BASE_URL: "https://example.com/admin" }),
  ).toThrow("APP_BASE_URL");
  expect(() =>
    dockerEnvironment({ ...values, POSTGRES_USER: "ta; DROP TABLE users" }),
  ).toThrow("POSTGRES_USER");
  expect(() => dockerEnvironment({ ...values, POSTGRES_PASSWORD: "" })).toThrow(
    "POSTGRES_PASSWORD",
  );
  try {
    dockerEnvironment({ ...values, POSTGRES_PASSWORD: "" });
  } catch (error) {
    expect(String(error)).not.toContain(values.DISCORD_BOT_TOKEN);
  }
});
test("dedicated database tests cannot be redirected to the live Docker database", () => {
  const result = dockerEnvironment({
    ...values,
    TEST_DATABASE_URL: "postgresql://test/test",
    REDIS_URL: "redis://redis:6379/15",
  });
  expect(result.DATABASE_URL).toBe("postgresql://test/test");
  expect(result.REDIS_URL).toBe("redis://redis:6379/15");
});
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(withEnv = true) {
  const root = mkdtempSync(join(tmpdir(), "ta-launch-"));
  roots.push(root);
  mkdirSync(join(root, "bin"));
  copyFileSync(resolve("start.sh"), join(root, "start.sh"));
  if (withEnv) writeFileSync(join(root, ".env"), "PRIVATE=value\n");
  writeFileSync(
    join(root, "bin/docker"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$MOCK_CALLS"
for arg in "$@"; do if [[ "$arg" == up ]]; then exit "\${MOCK_UP_EXIT:-0}"; fi; done
if [[ "$*" == *"exec -T"* ]]; then echo 'Dashboard: http://localhost:3000'; fi
exit 0
`,
    { mode: 0o755 },
  );
  return root;
}
function launch(root: string, command?: string, failed = "0") {
  return spawnSync(
    "bash",
    [join(root, "start.sh"), ...(command ? [command] : [])],
    {
      cwd: tmpdir(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        MOCK_CALLS: join(root, "calls.txt"),
        MOCK_UP_EXIT: failed,
      },
    },
  );
}
test("one-command startup validates Compose, waits for health and reports failure accurately", () => {
  const root = fixture();
  const failed = launch(root, undefined, "17");
  expect(failed.status).toBe(17);
  expect(failed.stdout).not.toContain("Dashboard:");
  expect(failed.stderr).toContain("Startup failed");
  expect(readFileSync(join(root, "calls.txt"), "utf8")).toContain(
    "--detach --wait --wait-timeout 300",
  );
  expect(launch(root).stdout).toContain("Dashboard:");
  expect(readFileSync(join(root, ".env"), "utf8")).toBe("PRIVATE=value\n");
});
test("launcher reports missing .env and never initializes or deletes data", () => {
  const root = fixture(false);
  expect(launch(root).stderr).toContain("Missing root .env");
  expect(launch(root).status).toBe(1);
});
test("restart and stop preserve volumes and use the same root Compose project", () => {
  const root = fixture();
  expect(launch(root, "restart").status).toBe(0);
  expect(launch(root, "stop").status).toBe(0);
  const calls = readFileSync(join(root, "calls.txt"), "utf8");
  expect(calls).toContain("stop");
  expect(calls).not.toContain("down");
  expect(calls).not.toContain("--env-file");
  expect(calls).not.toContain(" run ");
});
