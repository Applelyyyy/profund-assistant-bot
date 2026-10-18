import { createHash } from "node:crypto";
import { legacyDefaultHashes } from "./legacy-defaults";
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export function isLegacyDefault(feature: string, document: unknown) {
  if (!document || typeof document !== "object" || Array.isArray(document))
    return false;
  const complete = {
    notificationEnabled: true,
    fallbackChannelId: "",
    includeStudentId: false,
    ...document,
  };
  return (
    createHash("sha256")
      .update(JSON.stringify(canonical(complete)))
      .digest("hex") === legacyDefaultHashes[feature]
  );
}
