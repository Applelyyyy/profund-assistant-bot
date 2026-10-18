import { expect, test } from "vitest";
import {
  defaults,
  render,
  templateSchema,
  discordError,
  th,
  renderWaitingAlert,
} from "../packages/discord-ui/src/index";
import { supportInputSchema } from "../packages/shared/src/index";
import { isLegacyDefault } from "../packages/discord-ui/src/default-upgrade";

test("every default Discord panel, field, button and fallback is Thai and preserves API limits", () => {
  for (const doc of Object.values(defaults)) {
    for (const value of [
      doc.title,
      doc.description,
      doc.footer,
      ...doc.fields.map((f) => f.name),
      ...doc.buttons.map((b) => b.label),
    ])
      expect(value).toMatch(/[ก-๙]/);
    expect(() => render(doc, {})).not.toThrow();
    expect(() => render({ ...doc, mode: "V2" }, {})).not.toThrow();
  }
  expect(
    defaults.ta_dashboard.buttons.filter(
      (b) => b.action === "CALL_NEXT_STUDENT",
    ),
  ).toHaveLength(0);
  expect(
    defaults.ta_dashboard.buttons.some((b) =>
      ["next", "help"].includes(b.action),
    ),
  ).toBe(false);
  for (const status of Object.values(th.statuses))
    expect(status).toMatch(/[ก-๙]/);
  for (const error of Object.values(th.errors)) expect(error).toMatch(/[ก-๙]/);
  expect(discordError("UNKNOWN")).toBe(th.operationFailed);
});

test("legacy buttons normalize to one secured action while custom text remains unchanged", () => {
  const custom = templateSchema.parse({
    ...defaults.ta_dashboard,
    title: "My custom panel",
    buttons: [
      { action: "next", label: "My next button" },
      { action: "help", label: "Help" },
    ],
  });
  const rendered = render(custom, {});
  expect(JSON.stringify(rendered)).toContain("My custom panel");
  expect(JSON.stringify(rendered)).toContain("My next button");
  expect(JSON.stringify(rendered)).not.toContain("ta:help");
  expect(JSON.stringify(rendered).match(/ta:CALL_NEXT_STUDENT/g)).toHaveLength(
    1,
  );
  expect(custom.buttons).toHaveLength(2);
  expect(isLegacyDefault("ta_dashboard", custom)).toBe(false);
  const former = templateSchema.parse({
    title: "Student Verification",
    description:
      "Verify your student ID to join coursework queues. Your server nickname and Student role will sync.",
    footer: "TA Queue · Coursework support",
    buttons: [
      { action: "verify", label: "Verify Student ID", style: "Primary" },
    ],
  });
  expect(isLegacyDefault("registration", former)).toBe(true);
  const {
    notificationEnabled: _enabled,
    fallbackChannelId: _fallback,
    includeStudentId: _ids,
    ...older
  } = former;
  expect(isLegacyDefault("registration", older)).toBe(true);
  expect(
    isLegacyDefault("registration", { ...older, customMetadata: "Keep" }),
  ).toBe(false);
  expect(
    isLegacyDefault("registration", { ...former, title: "My custom title" }),
  ).toBe(false);
});

test("support accepts 1,000 Unicode code units, multiline and emoji without normalizing away the original; rejects oversized input", () => {
  const subject = 'ไม่สามารถยืนยันตัวตนได้ 🧑‍💻\n@everyone / " \\ < > '
    .repeat(20)
    .slice(0, 1000);
  expect(
    supportInputSchema.parse({
      category: "Technical",
      subject,
      description: "Separate description",
    }).subject,
  ).toBe(subject);
  expect(
    supportInputSchema.safeParse({
      category: "Technical",
      subject: "ก".repeat(1001),
      description: "Details",
    }).success,
  ).toBe(false);
  expect(
    supportInputSchema.safeParse({
      category: "Technical",
      subject: "   ",
      description: "Details",
    }).success,
  ).toBe(false);
});

test("waiting alert recovery reference survives custom footers and traditional/V2 rendering", () => {
  const custom = { ...defaults.waiting_room_alert, footer: "Custom footer" };
  for (const mode of ["EMBED", "V2"] as const) {
    const rendered = renderWaitingAlert(
      { ...custom, mode },
      { "waiting.incident": "aabbcc123456" },
    );
    expect(JSON.stringify(rendered)).toContain(
      "Custom footer · อ้างอิง aabbcc123456",
    );
    expect(custom.footer).toBe("Custom footer");
  }
});
