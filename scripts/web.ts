import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { env } from "../packages/config/src/index";
const require = createRequire(import.meta.url);
const mode = process.argv[2] === "start" ? "start" : "dev";
const e = env();
const child = spawn(
  process.execPath,
  [
    require.resolve("next/dist/bin/next"),
    mode,
    "apps/web",
    "--hostname",
    e.WEB_HOST,
    "--port",
    String(e.WEB_PORT),
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: mode === "start" ? "production" : "development",
    },
  },
);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code || 0));
