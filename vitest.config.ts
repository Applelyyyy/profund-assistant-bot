import "dotenv/config";
import { defineConfig } from "vitest/config";
if (process.env.TEST_DATABASE_URL)
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
export default defineConfig({
  test: {
    setupFiles: process.env.PERFORMANCE_ADAPTER_OUTPUT
      ? ["tests/fixtures/prisma-profile.ts"]
      : [],
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
