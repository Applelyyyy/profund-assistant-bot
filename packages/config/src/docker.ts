import { z } from "zod";

const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/);
const dockerSchema = z.object({
  POSTGRES_USER: identifier.default("ta"),
  POSTGRES_PASSWORD: z.string().min(14).max(256),
  POSTGRES_DB: identifier.default("ta_queue"),
  REDIS_PASSWORD: z.string().min(14).max(256),
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().regex(/^\d{17,20}$/),
  DISCORD_GUILD_ID: z.string().regex(/^\d{17,20}$/),
  AUTH_SECRET: z
    .string()
    .min(32)
    .refine((v) => !v.startsWith("replace-"), "Use a random AUTH_SECRET."),
  APP_BASE_URL: z
    .string()
    .url()
    .refine((v) => {
      const url = new URL(v);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash
      );
    }, "Use the browser origin, including protocol and port, without a path."),
});

export function dockerEnvironment(
  values: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const input = dockerSchema.parse(values);
  return {
    DATABASE_URL:
      values.TEST_DATABASE_URL ||
      `postgresql://${encodeURIComponent(input.POSTGRES_USER)}:${encodeURIComponent(input.POSTGRES_PASSWORD)}@postgres:5432/${input.POSTGRES_DB}?connection_limit=20`,
    REDIS_URL:
      values.TEST_DATABASE_URL && values.REDIS_URL
        ? values.REDIS_URL
        : `redis://:${encodeURIComponent(input.REDIS_PASSWORD)}@redis:6379`,
    WEB_HOST: "0.0.0.0",
    WEB_PORT: "3000",
    NODE_ENV: "production",
    SERVICE_CONTROL_ENABLED: "false",
    TIMEZONE: values.TZ || "Asia/Bangkok",
  };
}
