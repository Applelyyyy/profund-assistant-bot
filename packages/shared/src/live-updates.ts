export const consoleQueryKeys = [
  "overview",
  "health",
  "students",
  "coursework",
  "settings",
  "bindings",
  "templates",
  "support",
  "analytics",
  "logs",
  "runtime-logs",
  "operations",
  "accounts",
  "inspections",
  "sessions",
  "session-history",
  "session-work",
  "waiting-alert-status",
  "waiting-alert-preview",
];
export const panelScopes = ["queue", "ranking", "support", "health"] as const;
export type PanelScope = (typeof panelScopes)[number];
/** Notification signals carry types only; queue state is always read from PostgreSQL. */
export function refreshForEvents(types: readonly string[]) {
  const queries = new Set<string>();
  const scopes = new Set<PanelScope>();
  let all = false;
  for (const type of types) {
    queries.add("logs");
    if (
      /^(configuration|channel|coursework|template|panel|maintenance)\./.test(
        type,
      )
    ) {
      all = true;
      continue;
    }
    if (type === "inspection.note") {
      queries.add("overview");
      queries.add("inspections");
      queries.add("sessions");
      queries.add("session-history");
      queries.add("session-work");
      continue;
    }
    if (
      type.startsWith("inspection.no_show_dm_") ||
      type.startsWith("mute.") ||
      type.startsWith("interaction.")
    ) {
      queries.add("runtime-logs");
      continue;
    }
    if (/^(queue|session|transfer|inspection)\./.test(type)) {
      [
        "overview",
        "sessions",
        "session-history",
        "session-work",
        "inspections",
        "waiting-alert-status",
        "waiting-alert-preview",
      ].forEach((q) => queries.add(q));
      if (
        !/^(queue\.(claimed|dispatched|stale|abandoned|recovered)|transfer\.(succeeded|failed|retry)|inspection\.(completion_requested|disconnect_failed)|session\.(presence|draining))$/.test(
          type,
        )
      )
        queries.add("analytics");
      scopes.add("queue");
      if (
        /^(inspection\.(completed|no_show|corrected)|queue\.(admitted|cancelled|no_show))$/.test(
          type,
        )
      )
        scopes.add("ranking");
      continue;
    }
    if (/^(student|students|identity)\./.test(type)) {
      queries.add("students");
      queries.add("overview");
      queries.add("analytics");
      scopes.add("queue");
      scopes.add("ranking");
      continue;
    }
    if (type.startsWith("support.")) {
      queries.add("support");
      queries.add("overview");
      queries.add("operations");
      scopes.add("support");
      continue;
    }
    if (/^(operation|service|waiting)\./.test(type)) {
      queries.add("operations");
      queries.add("health");
      queries.add("waiting-alert-status");
      scopes.add("health");
      continue;
    }
    if (type === "account.saved" || type.startsWith("admin.")) {
      queries.add("accounts");
      queries.add("me");
      continue;
    }
    all = true;
  }
  return {
    queries: all ? consoleQueryKeys : [...queries],
    panels: all ? null : [...scopes],
  };
}
export function panelAffected(
  feature: string,
  document: unknown,
  scopes: readonly PanelScope[],
) {
  if (scopes.includes("queue") && feature === "ta_room_queue_panel")
    return true;
  const text = JSON.stringify(document);
  return scopes.some((scope) =>
    ({
      queue: /\{(?:queue|room|ta)\./,
      ranking: /\{ranking\./,
      support: /\{support\./,
      health: /\{system\./,
    })[scope].test(text),
  );
}
