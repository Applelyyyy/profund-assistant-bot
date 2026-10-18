import { config } from "dotenv";
import { basename, dirname, resolve } from "node:path";
config();
if (!process.env.DATABASE_URL)
  config({ path: resolve(process.cwd(), "../../.env") });
import { z } from "zod";
import pino from "pino";
import { mkdirSync, appendFileSync } from "node:fs";
import { logsDirectory, currentLogName } from "./log-archives";
import { dockerEnvironment } from "./docker";
const projectRoot =
  basename(dirname(process.cwd())) === "apps"
    ? resolve(process.cwd(), "../..")
    : process.cwd();
// Runtime logs are mutable files, not assets for the Next.js bundler to resolve.
export const runtimeLogPath = resolve(projectRoot, "logs/platform.ndjson");
const schema = z.object({
  DATABASE_URL: z.string().startsWith("postgresql://"),
  REDIS_URL: z.string().url(),
  DISCORD_BOT_TOKEN: z.string().default(""),
  DISCORD_MESSAGE_CONTENT_ENABLED: z.enum(["true", "false"]).default("false"),
  DISCORD_CLIENT_ID: z.string().default(""),
  DISCORD_GUILD_ID: z.string().regex(/^\d{17,20}$/),
  APP_BASE_URL: z.string().url().default("http://127.0.0.1:3000"),
  AUTH_SECRET: z.string().min(32),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PERFORMANCE_METRICS_ENABLED: z.enum(["true", "false"]).default("false"),
  LOG_LEVEL: z
    .enum(["debug", "info", "warn", "error", "fatal"])
    .default("info"),
  SERVICE_CONTROL_ENABLED: z.enum(["true", "false"]).default("false"),
  WEB_HOST: z.string().default("127.0.0.1"),
  WEB_PORT: z.coerce.number().default(3000),
  TIMEZONE: z.string().default("Asia/Bangkok"),
});
let parsed: z.infer<typeof schema> | undefined;
export function env() {
  if (!parsed && process.env.DOCKER_DEPLOYMENT === "true")
    Object.assign(process.env, dockerEnvironment(process.env));
  return (parsed ??= schema.parse(process.env));
}
export const logger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    redact: {
      paths: [
        "password",
        "passwordHash",
        "token",
        "authorization",
        "req.headers.cookie",
        "DISCORD_BOT_TOKEN",
        "DATABASE_URL",
        "AUTH_SECRET",
      ],
      censor: "[REDACTED]",
    },
  },
  pino.multistream([
    { stream: process.stdout },
    {
      stream: {
        write(line: string) {
          mkdirSync(logsDirectory, { recursive: true, mode: 0o700 });
          appendFileSync(resolve(logsDirectory, currentLogName()), line, {
            mode: 0o600,
          });
        },
      },
    },
  ]),
);
