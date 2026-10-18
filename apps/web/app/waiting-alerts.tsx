"use client";
import { useState } from "react";
import { settingsSchema } from "../../../packages/shared/src/index";
import type { Settings } from "../../../packages/shared/src/index";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "../../../packages/ui/src/index";
import type { ServiceOperation } from "@prisma/client";
type Directory = {
  channels: { id: string; name: string; type: number }[];
  roles: { id: string; name: string }[];
};
type Mutate = <T>(path: string, data?: unknown) => Promise<T | undefined>;
export function WaitingAlerts({
  settings,
  bindings,
  directory,
  disabled,
  mutate,
  onTemplates,
}: {
  settings: Settings;
  bindings: { feature: string; channelIds: string[] }[];
  directory?: Directory;
  disabled: boolean;
  mutate: Mutate;
  onTemplates: () => void;
}) {
  const [draft, setDraft] = useState(settings.waitingRoomAlerts);
  const [error, setError] = useState("");
  const [operation, setOperation] = useState<ServiceOperation>();
  const [saved, setSaved] = useState(false);
  const status = useQuery({
    queryKey: ["waiting-alert-status"],
    queryFn: async () => {
      const response = await fetch("/api/waiting-alerts");
      if (!response.ok) throw new Error("Could not load alert status.");
      return response.json() as Promise<{
        incidents: {
          startedAt: string;
          resolvedAt: string | null;
          notifiedAt: string | null;
          lastNotifiedAt: string | null;
          lastError: string | null;
        }[];
        operations: ServiceOperation[];
      }>;
    },
    refetchInterval: 5000,
  });
  const [preview, setPreview] = useState(false);
  const alertPreview = useQuery({
    queryKey: ["waiting-alert-preview"],
    enabled: preview,
    queryFn: async () => {
      const response = await fetch("/api/waiting-alerts/preview");
      if (!response.ok) throw new Error("Could not render alert preview.");
      return response.json() as Promise<{
        title: string;
        description: string;
        fields: { name: string; value: string }[];
        footer: string;
        color: string;
      }>;
    },
  });
  const latest = status.data?.incidents
    .slice()
    .sort(
      (a, b) =>
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    )[0];
  const triggered = latest?.startedAt;
  const sent = status.data?.incidents
    .map((i) => i.lastNotifiedAt)
    .filter((v): v is string => !!v)
    .sort()
    .at(-1);
  function edit(value: Partial<typeof draft>) {
    setDraft({ ...draft, ...value });
    setSaved(false);
    setError("");
  }
  async function save() {
    const parsed = settingsSchema.safeParse({
      ...settings,
      waitingRoomAlerts: draft,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message || "Check your settings.");
      return;
    }
    const result = await mutate<Settings>("settings", parsed.data);
    if (result) {
      setDraft(result.waitingRoomAlerts);
      setSaved(true);
    }
  }
  async function run(action: "validate" | "check" | "test") {
    const result = await mutate<ServiceOperation>(`waiting-alerts/${action}`, {
      settings: draft,
    });
    if (result) setOperation(result);
  }
  const selected = (e: React.ChangeEvent<HTMLSelectElement>) =>
    [...e.target.selectedOptions].map((o) => o.value);
  const rooms =
    bindings.find((b) => b.feature === "waiting_voice")?.channelIds || [];
  return (
    <section className="form-padding" aria-labelledby="waiting-alert-heading">
      <div className="alert-heading">
        <h3 id="waiting-alert-heading">Waiting Room Alerts</h3>
        <Badge tone={draft.enabled ? "success" : "neutral"}>
          {draft.enabled ? "Enabled" : "Disabled"}
        </Badge>
      </div>
      <p className="muted">
        Notify staff when verified students wait without a ticket and TA
        availability is missing. Students still select coursework and join the
        queue themselves.
      </p>
      <dl className="alert-summary">
        <div>
          <dt>Current incidents</dt>
          <dd>
            {status.data
              ? `${status.data.incidents.filter((i) => !i.resolvedAt).length} open`
              : "Loading…"}
          </dd>
        </div>
        <div>
          <dt>Last triggered</dt>
          <dd>
            {triggered
              ? new Date(triggered).toLocaleString()
              : "Not triggered yet"}
          </dd>
        </div>
        <div>
          <dt>Last successful notification</dt>
          <dd>{sent ? new Date(sent).toLocaleString() : "None yet"}</dd>
        </div>
      </dl>
      {status.isError && (
        <p className="notice warning">
          Alert status could not load. Refresh this page to retry.
        </p>
      )}
      {latest?.lastError && (
        <p className="notice danger" role="alert">
          {latest.lastError}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={disabled} className="waiting-alert-form">
          <legend className="sr-only">Waiting room alert settings</legend>
          <label className="check">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => edit({ enabled: e.target.checked })}
            />
            Enable Waiting Room Alerts
          </label>
          <div>
            <label>
              Waiting Voice Channels
              <select
                multiple
                aria-label="Waiting Voice Channels"
                value={draft.waitingChannelIds}
                disabled={!directory}
                onChange={(e) => edit({ waitingChannelIds: selected(e) })}
              >
                {directory?.channels
                  .filter((c) => c.type === 2 && rooms.includes(c.id))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </label>
            <small className="muted">
              Empty selection uses all authorized Waiting Voice bindings. Hold
              Ctrl or Command to select multiple rooms.
            </small>
          </div>
          <label>
            TA Alert Channel
            <select
              aria-label="TA Alert Channel"
              value={draft.channelId}
              disabled={!directory}
              onChange={(e) => edit({ channelId: e.target.value })}
            >
              <option value="">Use Queue Alert channel binding</option>
              {directory?.channels
                .filter((c) => [0, 2, 5].includes(c.type))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    #{c.name}
                  </option>
                ))}
            </select>
          </label>
          <div>
            <label>
              TA Notification Roles
              <select
                multiple
                aria-label="TA Notification Roles"
                value={draft.roleIds}
                disabled={!directory}
                onChange={(e) => edit({ roleIds: selected(e) })}
              >
                {directory?.roles
                  .filter((r) => r.name !== "@everyone")
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </select>
            </label>
            <small className="muted">
              Empty selection sends no mentions. Selected roles are mentioned
              once per incident.
            </small>
          </div>
          <label>
            Grace Period (seconds)
            <input
              type="number"
              required
              min={5}
              max={3600}
              value={draft.graceSeconds}
              onChange={(e) => edit({ graceSeconds: Number(e.target.value) })}
            />
          </label>
          <label>
            Alert Cooldown (seconds)
            <input
              type="number"
              required
              min={60}
              max={86400}
              value={draft.cooldownSeconds}
              onChange={(e) =>
                edit({ cooldownSeconds: Number(e.target.value) })
              }
            />
          </label>
          <fieldset>
            <legend>Alert triggers</legend>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.noAccepting}
                onChange={(e) => edit({ noAccepting: e.target.checked })}
              />
              No Accepting TAs
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.noAvailable}
                onChange={(e) => edit({ noAvailable: e.target.checked })}
              />
              No Available TA in Inspection Rooms
            </label>
            <label>
              Trigger combination
              <select
                aria-label="Trigger combination"
                value={draft.triggerMode}
                onChange={(e) =>
                  edit({
                    triggerMode: e.target.value as typeof draft.triggerMode,
                  })
                }
              >
                <option value="ANY">Any selected condition</option>
                <option value="ALL">All selected conditions</option>
              </select>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.queueFull}
                onChange={(e) => edit({ queueFull: e.target.checked })}
              />
              Also alert when the queue is full with active TAs
            </label>
          </fieldset>
          <p className="muted">
            Any selected condition triggers an alert when either condition is
            true. All requires every selected condition. Only verified students
            without any active ticket qualify; microphone activity is not
            monitored.
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={draft.group}
              onChange={(e) => edit({ group: e.target.checked })}
            />
            Group Multiple Waiting Students
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={draft.autoResolve}
              onChange={(e) => edit({ autoResolve: e.target.checked })}
            />
            Auto Resolve
          </label>
          <div>
            <strong>Notification Template</strong>
            <p className="muted">
              Edit the Waiting Room Alert template in Embed Builder. It supports
              aggregate waiting counts and availability without student
              identities.
            </p>
            <button type="button" className="secondary" onClick={onTemplates}>
              Edit notification template
            </button>
          </div>
          {error && (
            <p className="notice danger" role="alert">
              {error}
            </p>
          )}
          {saved && (
            <p className="notice" role="status">
              Waiting Room Alerts saved. Changes apply without restarting the
              bot.
            </p>
          )}
          {!directory && (
            <p className="notice warning">
              Connect Discord to load channel and role choices.
            </p>
          )}
          <div className="form-actions">
            <button type="submit" className="primary">
              Save waiting room alerts
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setPreview(!preview)}
            >
              Preview alert
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => void run("validate")}
            >
              Validate config
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => void run("check")}
            >
              Check permissions
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => void run("test")}
            >
              Send test alert
            </button>
          </div>
          <p className="muted">
            Diagnostics and tests use saved settings. Test alerts are labeled
            and do not mention roles. View completion or errors in System
            Operations.
          </p>
          {preview && (
            <div
              className="waiting-alert-preview"
              aria-label="Waiting alert preview"
              style={{ borderColor: alertPreview.data?.color }}
            >
              <strong>{alertPreview.data?.title || "Loading preview…"}</strong>
              <p>{alertPreview.data?.description}</p>
              {alertPreview.data?.fields.map((field, i) => (
                <p key={i}>
                  <strong>{field.name}</strong>
                  <br />
                  {field.value}
                </p>
              ))}
              <small>{alertPreview.data?.footer}</small>
              <p className="muted">
                Uses the saved template and current observations. No
                notification is sent.
              </p>
              {alertPreview.isError && (
                <p role="alert">
                  Preview could not load. Check the notification template and
                  retry.
                </p>
              )}
            </div>
          )}
          {status.data?.operations.length ? (
            <div className="alert-results">
              <h4>Recent diagnostics</h4>
              {status.data.operations.map((op) => (
                <p key={op.id}>
                  <strong>
                    {op.action === "waiting_alert_test"
                      ? "Test alert"
                      : "Permission check"}
                  </strong>{" "}
                  ·{" "}
                  {(
                    {
                      PENDING: "Queued",
                      RUNNING: "In progress",
                      COMPLETED: "Succeeded",
                      FAILED: "Failed",
                    } as Record<string, string>
                  )[op.status] || "Pending"}
                  {op.error ? `: ${op.error}` : ""}
                </p>
              ))}
            </div>
          ) : null}
          {operation && (
            <p role="status">
              Request queued. Its result will appear in Recent diagnostics.
            </p>
          )}
        </fieldset>
      </form>
    </section>
  );
}
