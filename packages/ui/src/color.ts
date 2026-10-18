export type ColorFormat = "HEX" | "RGB" | "HSL";
export const colorPresets = [
  ["Discord Blurple", "#5865F2"],
  ["Profun Purple", "#7475F1"],
  ["Ocean Blue", "#3498DB"],
  ["Emerald", "#2ECC71"],
  ["Amber", "#F1C40F"],
  ["Coral", "#E67E73"],
  ["Crimson", "#ED4245"],
  ["Slate", "#64748B"],
] as const;
export function normalizeHex(value: string) {
  const hex = value.trim().replace(/^#/, "");
  if (!/^(?:[\da-f]{3}|[\da-f]{6})$/i.test(hex)) return null;
  return `#${(hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex).toUpperCase()}`;
}
const rgb = (hex: string) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hexFromRgb = (channels: number[]) =>
  `#${channels
    .map((n) => Math.round(n).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
export function colorChannels(hex: string, format: ColorFormat): string[] {
  const normalized = normalizeHex(hex);
  if (!normalized) throw new Error("Invalid accent color");
  if (format === "HEX") return [normalized];
  const channels = rgb(normalized);
  if (format === "RGB") return channels.map(String);
  const [r, g, b] = channels.map((n) => n / 255);
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    delta = max - min;
  const l = (max + min) / 2;
  const h = !delta
    ? 0
    : 60 *
      (max === r
        ? ((g - b) / delta + 6) % 6
        : max === g
          ? (b - r) / delta + 2
          : (r - g) / delta + 4);
  const s = !delta ? 0 : delta / (1 - Math.abs(2 * l - 1));
  return [h, s * 100, l * 100].map((n) => String(Math.round(n * 100) / 100));
}
export function colorFromChannels(values: string[], format: ColorFormat) {
  if (format === "HEX") return normalizeHex(values[0] || "");
  if (values.length !== 3 || values.some((v) => !v.trim())) return null;
  const channels = values.map(Number);
  if (channels.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (format === "RGB")
    return channels.every((n) => Number.isInteger(n) && n <= 255)
      ? hexFromRgb(channels)
      : null;
  const [h, saturation, lightness] = channels;
  if (h > 360 || saturation > 100 || lightness > 100) return null;
  const s = saturation / 100,
    l = lightness / 100;
  const a = s * Math.min(l, 1 - l);
  return hexFromRgb(
    [0, 8, 4].map((n) => {
      const k = (n + h / 30) % 12;
      return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
    }),
  );
}
export function recentColors(colors: unknown) {
  return Array.isArray(colors)
    ? [
        ...new Set(
          colors
            .filter((c): c is string => typeof c === "string")
            .map(normalizeHex)
            .filter((c): c is string => !!c),
        ),
      ].slice(0, 8)
    : [];
}
