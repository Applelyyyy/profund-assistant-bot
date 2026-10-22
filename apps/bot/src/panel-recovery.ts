import { MessageFlags, type APIMessage } from "discord.js";
import {
  defaults,
  render,
  scopeRoomActions,
} from "../../../packages/discord-ui/src/index";

function controls(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(controls).sort();
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [
    ...(typeof record.custom_id === "string"
      ? [record.custom_id.replace(/^ta:next(?=:|$)/, "ta:CALL_NEXT_STUDENT")]
      : []),
    ...Object.entries(record)
      .filter(([key]) => key !== "custom_id")
      .flatMap(([, item]) => controls(item)),
  ].sort();
}

function titles(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(titles);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [
    ...(typeof record.title === "string" ? [record.title] : []),
    ...(typeof record.content === "string" && record.content.startsWith("## ")
      ? [record.content.split("\n")[0].slice(3)]
      : []),
    ...Object.values(record).flatMap(titles),
  ];
}

/** Only adopt our own persistent panels; a matching title alone cannot claim another room's controls. */
export function matchesPanel(
  message: APIMessage,
  botId: string,
  feature: string,
  document: unknown,
  roomId?: string,
) {
  if (
    message.author?.id !== botId ||
    message.webhook_id ||
    (!message.embeds?.length && !(message.flags! & MessageFlags.IsComponentsV2))
  )
    return false;
  const candidates = [document];
  if (defaults[feature]) {
    const fallback = render(defaults[feature], {});
    candidates.push(roomId ? scopeRoomActions(fallback, roomId) : fallback);
  }
  const rawControls = controls(message.components);
  // These read-only dashboards predate the current interactive templates.
  const legacyTitles: Record<string, string[]> = {
    public_queue: ["📋・LIVE QUEUE"],
    ta_dashboard: ["TA Dashboard"],
  };
  if (
    !roomId &&
    !rawControls.length &&
    legacyTitles[feature]?.some((title) => titles(message).includes(title))
  )
    return true;
  const comparable = (ids: string[]) =>
    roomId ? ids : ids.filter((id) => id !== "ta:refresh");
  const actual = comparable(rawControls);
  return candidates.some((candidate) => {
    const expected = comparable(controls(candidate));
    const sameControls =
      actual.length === expected.length &&
      actual.every((id, i) => id === expected[i]);
    // A lone refresh button is shared by unrelated features. Require the title too.
    const distinctive = expected.some((id) => id !== "ta:refresh");
    return (
      sameControls &&
      (distinctive ||
        titles(candidate).some(
          (title) => title && titles(message).includes(title),
        ))
    );
  });
}
