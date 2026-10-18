import { PrismaClient } from "@prisma/client";
import { env } from "../../config/src/index";
import {
  performanceEnabled,
  recordDuration,
} from "../../config/src/performance";
function createClient() {
  const log: { emit: "event"; level: "query" }[] = performanceEnabled
    ? [{ emit: "event", level: "query" }]
    : [];
  const client = new PrismaClient({ datasourceUrl: env().DATABASE_URL, log });
  if (performanceEnabled)
    client.$on("query", (e) => recordDuration("database.query", e.duration));
  return client;
}
const globalDb = globalThis as unknown as { taDb?: PrismaClient };
export const db = globalDb.taDb ?? createClient();
if (process.env.NODE_ENV !== "production") globalDb.taDb = db;
export { Prisma } from "@prisma/client";
