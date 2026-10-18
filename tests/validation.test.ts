import { describe, test, expect } from "vitest";
import { parseStudents, exportStudents } from "../packages/shared/src/csv";
import {
  settingsSchema,
  safeCsvCell,
  canHandle,
} from "../packages/shared/src/index";
import {
  templateSchema,
  render,
  defaults,
  resolve,
} from "../packages/discord-ui/src/index";
describe("CSV trust boundary", () => {
  test("UTF-8, BOM, quoted names, leading zeros, and export protection", () => {
    const parsed = parseStudents(
      '\ufeffid,name,lastname\r\n00123,"First, Jr.",Last\r\n00124,สมชาย,ใจดี\r\n',
    );
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.rows[0].studentId).toBe("00123");
    expect(parsed.rows[0].name).toBe("First, Jr.");
    expect(
      exportStudents([
        { studentId: "00123", name: '=IMPORTXML("x")', lastname: "@SUM(1)" },
      ]),
    ).toContain("'=IMPORTXML");
    expect(safeCsvCell("-formula")).toBe("'-formula");
  });
  test("missing columns, malformed quotes, empty data, duplicates and oversized input", () => {
    expect(() => parseStudents("id,name\n01,First")).toThrow(
      "Required CSV columns",
    );
    expect(() =>
      parseStudents('id,name,lastname\n"unterminated,x,y'),
    ).toThrow();
    expect(() => parseStudents("id,name,lastname\n")).toThrow(
      "no student rows",
    );
    expect(
      parseStudents("id,name,lastname\n01,A,B\n01,C,D").errors,
    ).toHaveLength(1);
    expect(parseStudents("id,name,lastname\n01,,B").errors).toHaveLength(1);
    expect(() => parseStudents("x".repeat(2097153))).toThrow("2 MB");
  });
});
describe("typed Discord rendering", () => {
  test("unknown placeholders, invalid components and excessive text are rejected", () => {
    expect(() =>
      templateSchema.parse({
        ...defaults.student_queue,
        title: "{process.env.TOKEN}",
      }),
    ).toThrow("Unknown placeholder");
    expect(() =>
      templateSchema.parse({
        ...defaults.student_queue,
        buttons: [{ action: "execute_shell", label: "Run" }],
      }),
    ).toThrow();
    expect(() =>
      render(
        { ...defaults.student_queue, description: "{queue.top}", fields: [] },
        { "queue.top": "x".repeat(7000) },
      ),
    ).not.toThrow();
    expect(() => resolve("{unknown}", {})).toThrow();
    expect(() =>
      templateSchema.parse({
        ...defaults.registration,
        buttons: [
          ...defaults.registration.buttons,
          ...defaults.registration.buttons,
        ],
      }),
    ).toThrow("distinct actions");
    expect(() =>
      render(
        { ...defaults.registration, mode: "V2", description: "{queue.top}" },
        { "queue.top": "x".repeat(5000) },
      ),
    ).toThrow("4,000");
  });
  test("Components V2 never mixes embeds; every default obeys component limits", () => {
    const v2 = render({ ...defaults.student_queue, mode: "V2" }, {});
    expect(v2).toHaveProperty("flags", 32768);
    expect(v2).not.toHaveProperty("embeds");
    for (const doc of Object.values(defaults)) {
      expect(() => templateSchema.parse(doc)).not.toThrow();
      const result = render(doc, {});
      expect(result.components.length).toBeLessThanOrEqual(5);
    }
  });
});
test("settings preserve independent capacity and eligibility rules", () => {
  expect(() =>
    settingsSchema.parse({
      minCapacity: 5,
      defaultCapacity: 3,
      maxCapacity: 10,
    }),
  ).toThrow();
  expect(() => settingsSchema.parse({ inspectionConcurrency: 0 })).toThrow();
  expect(() => settingsSchema.parse({ timezone: "not/a/timezone" })).toThrow();
  expect(
    canHandle(
      { eligibleUsers: [], eligibleRoles: ["TA"] },
      { taId: "1", roleIds: ["TA"], courseworkIds: ["course"] },
      "course",
    ),
  ).toBe(true);
  expect(
    canHandle(
      { eligibleUsers: ["other"], eligibleRoles: [] },
      { taId: "1", roleIds: [], courseworkIds: [] },
      "course",
    ),
  ).toBe(false);
});
test("runtime logs persist structured records and redact credentials", async () => {
  const { logger } = await import("../packages/config/src/index");
  const { runtimeLogs } = await import("../packages/config/src/logs");
  const message = `Redaction test ${Date.now()}`;
  logger.info(
    { password: "private-test-password", token: "private-test-token" },
    message,
  );
  const record = (await runtimeLogs()).find((row) => row.msg === message);
  expect(record).toMatchObject({ password: "[REDACTED]", token: "[REDACTED]" });
});
test("analytics days use the configured timezone and handle daylight-saving boundaries", async () => {
  const { analyticsWindow } = await import("../packages/shared/src/time");
  expect(analyticsWindow("2026-10-01", "2026-10-01", "Asia/Bangkok")).toEqual({
    gte: new Date("2026-09-30T17:00:00Z"),
    lt: new Date("2026-10-01T17:00:00Z"),
  });
  const dst = analyticsWindow("2026-03-08", "2026-03-08", "America/New_York");
  expect(dst.lt!.getTime() - dst.gte!.getTime()).toBe(23 * 3600000);
  expect(() => analyticsWindow("2026-10-02", "2026-10-01", "UTC")).toThrow(
    "end date",
  );
});
