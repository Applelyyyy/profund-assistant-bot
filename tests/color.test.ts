import { expect, test } from "vitest";
import {
  normalizeHex,
  colorChannels,
  colorFromChannels,
  recentColors,
  colorPresets,
} from "../packages/ui/src/color";
import {
  defaults,
  render,
  templateSchema,
} from "../packages/discord-ui/src/index";

test("HEX input accepts shorthand, keeps canonical six-digit colors and rejects incomplete or invalid values", () => {
  expect(normalizeHex(" #aBc ")).toBe("#AABBCC");
  expect(normalizeHex("5865f2")).toBe("#5865F2");
  for (const value of [
    "",
    "#",
    "#12",
    "#1234",
    "#1234567",
    "#ZZFFFF",
    "rgb(1,2,3)",
  ])
    expect(normalizeHex(value)).toBeNull();
});

test("RGB and HSL remain synchronized with canonical colors, including black, white and hue wrap", () => {
  for (const color of [
    "#000000",
    "#FFFFFF",
    "#FF0000",
    "#00FF00",
    "#0000FF",
    ...colorPresets.map((p) => p[1]),
  ]) {
    expect(colorFromChannels(colorChannels(color, "RGB"), "RGB")).toBe(color);
    expect(colorFromChannels(colorChannels(color, "HSL"), "HSL")).toBe(color);
  }
  expect(colorFromChannels(["360", "100", "50"], "HSL")).toBe("#FF0000");
  expect(colorFromChannels(["0", "100", "0"], "HSL")).toBe("#000000");
  for (const values of [
    ["", "0", "0"],
    ["-1", "0", "0"],
    ["256", "0", "0"],
    ["0.5", "0", "0"],
    ["NaN", "0", "0"],
  ])
    expect(colorFromChannels(values, "RGB")).toBeNull();
  for (const values of [
    ["361", "50", "50"],
    ["90", "101", "50"],
    ["90", "50", "101"],
    ["", "50", "50"],
  ])
    expect(colorFromChannels(values, "HSL")).toBeNull();
});

test("recent colors reject corrupt storage, normalize, deduplicate and retain only eight entries", () => {
  expect(recentColors(null)).toEqual([]);
  expect(recentColors({ hex: "#fff" })).toEqual([]);
  expect(recentColors(["#fff", "#FFFFFF", "#abc", "invalid", 42])).toEqual([
    "#FFFFFF",
    "#AABBCC",
  ]);
  expect(
    recentColors(["#000000", ...colorPresets.map((p) => p[1])]),
  ).toHaveLength(8);
});

test("canonical selected color reaches both Discord render modes without changing other template properties", () => {
  const before = defaults.ta_room_queue_panel;
  const selected = templateSchema.parse({
    ...before,
    color: normalizeHex("#2ec")!,
  });
  expect({ ...selected, color: before.color }).toEqual(before);
  const embed = render(selected, {});
  expect(embed.embeds?.[0].color).toBe(0x22eecc);
  const v2 = render({ ...selected, mode: "V2" }, {});
  expect(v2.components[0]).toMatchObject({ type: 17, accent_color: 0x22eecc });
  expect(templateSchema.safeParse({ ...before, color: "#12" }).success).toBe(
    false,
  );
});
