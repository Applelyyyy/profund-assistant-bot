import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { logger } from "./index";
export const performanceEnabled =
  process.env.PERFORMANCE_METRICS_ENABLED === "true";
type Bucket = {
  count: number;
  errors: number;
  values: number[];
  cursor: number;
};
const buckets = new Map<string, Bucket>();
const counters = new Map<string, number>();
export function incrementCounter(name: string) {
  if (performanceEnabled && (counters.has(name) || counters.size < 32))
    counters.set(name, (counters.get(name) || 0) + 1);
}
export function recordDuration(
  name: string,
  milliseconds: number,
  failed = false,
) {
  if (!performanceEnabled || !Number.isFinite(milliseconds) || milliseconds < 0)
    return;
  if (!buckets.has(name) && buckets.size >= 128) return;
  const bucket = buckets.get(name) || {
    count: 0,
    errors: 0,
    values: [],
    cursor: 0,
  };
  bucket.count++;
  bucket.errors += Number(failed);
  if (bucket.values.length < 2048) bucket.values.push(milliseconds);
  else {
    bucket.values[bucket.cursor] = milliseconds;
    bucket.cursor = (bucket.cursor + 1) % 2048;
  }
  buckets.set(name, bucket);
}
export async function measure<T>(
  name: string,
  work: () => Promise<T>,
): Promise<T> {
  if (!performanceEnabled) return work();
  const start = performance.now();
  let failed = false;
  try {
    return await work();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    recordDuration(name, performance.now() - start, failed);
  }
}
const loop = performanceEnabled
  ? monitorEventLoopDelay({ resolution: 20 })
  : undefined;
loop?.enable();
let previousTime = performance.now(),
  previousCpu = process.cpuUsage(),
  previousLoop = performance.eventLoopUtilization();
export function performanceSnapshot() {
  return {
    enabled: performanceEnabled,
    counters: Object.fromEntries(counters),
    metrics: Object.fromEntries(
      [...buckets].map(([name, bucket]) => {
        const sorted = [...bucket.values].sort((a, b) => a - b);
        const percentile = (p: number) =>
          sorted[Math.ceil(sorted.length * p) - 1];
        return [
          name,
          {
            count: bucket.count,
            errors: bucket.errors,
            samples: sorted.length,
            p50Ms: percentile(0.5),
            p95Ms: sorted.length >= 20 ? percentile(0.95) : null,
            p99Ms: sorted.length >= 100 ? percentile(0.99) : null,
          },
        ];
      }),
    ),
    memory: process.memoryUsage(),
    eventLoopDelayP95Ms: loop ? loop.percentile(95) / 1e6 : null,
  };
}
const timer = performanceEnabled
  ? setInterval(() => {
      const now = performance.now(),
        cpu = process.cpuUsage(previousCpu),
        utilization = performance.eventLoopUtilization(previousLoop);
      logger.info(
        {
          ...performanceSnapshot(),
          cpuPercent: (cpu.user + cpu.system) / (10 * (now - previousTime)),
          eventLoopUtilization: utilization.utilization,
        },
        "performance.summary",
      );
      previousTime = now;
      previousCpu = process.cpuUsage();
      previousLoop = performance.eventLoopUtilization();
      loop?.reset();
    }, 60000).unref()
  : undefined;
export function stopPerformanceMonitor() {
  if (timer) clearInterval(timer);
  loop?.disable();
}
