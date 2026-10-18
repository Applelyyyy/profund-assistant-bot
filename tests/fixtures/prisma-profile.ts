import { PrismaClient } from "@prisma/client";
const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  !new URL(url).pathname.endsWith("_test") ||
  process.env.DATABASE_URL !== url
)
  throw new Error("Dedicated performance test database required.");
const trace = { phase: "", counts: {} as Record<string, number> };
const profiler = new PrismaClient({
  datasourceUrl: url,
  log: [{ emit: "event", level: "query" }],
});
profiler.$on("query", (e) => {
  if (!trace.phase) return;
  trace.counts[trace.phase] = (trace.counts[trace.phase] || 0) + 1;
  if (e.query.includes('FROM "public"."EmbedTemplate"'))
    trace.counts[trace.phase + ".templates"] =
      (trace.counts[trace.phase + ".templates"] || 0) + 1;
});
Object.assign(globalThis, { taDb: profiler, performanceTrace: trace });
