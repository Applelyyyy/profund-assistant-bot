"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Modal } from "../../../packages/ui/src/index";
import { AccessPreview } from "./roles-access";
import type { AccessPlan } from "../../../packages/config/src/access";
import { studentIdDisclosureWarning } from "../../../packages/shared/src/index";
import type { Settings } from "../../../packages/shared/src/index";
type Mutate = <T>(path: string, data?: unknown) => Promise<T | undefined>;
type Directory = {
  channels: { id: string; name: string; type: number; parent_id?: string }[];
  roles: { id: string; name: string }[];
};
const policies = {
  EVERYONE: "Everyone",
  UNVERIFIED_ONLY: "Unverified Only",
  STUDENTS: "Verified Students",
  TAS: "TA Only",
  SUPPORT: "Support Staff",
  ADMINS: "Administrators",
  CUSTOM: "Custom",
};
export function ChannelVisibility({
  settings,
  bindings,
  directory,
  disabled,
  mutate,
}: {
  settings: Settings;
  bindings: { feature: string; channelIds: string[] }[];
  directory?: Directory;
  disabled: boolean;
  mutate: Mutate;
}) {
  const [editing, setEditing] = useState<
    Settings["channelVisibility"][number] | null
  >(null);
  const [preview, setPreview] = useState<{
    plan: AccessPlan;
    settings: Settings;
  } | null>(null);
  async function review(rules: Settings["channelVisibility"]) {
    const proposed = { ...settings, channelVisibility: rules };
    const plan = await mutate<AccessPlan>("access/preview", {
      settings: proposed,
      bindings,
    });
    if (plan) setPreview({ plan, settings: proposed });
  }
  return (
    <section className="form-padding">
      <h3>Channel Visibility</h3>
      <p>
        README defaults to Unverified Only when bound. Student role changes
        restore or hide access automatically. Administrator access bypasses
        Discord restrictions.
      </p>
      <div className="form-actions">
        <button
          disabled={disabled || !directory}
          onClick={() =>
            setEditing({
              channelId: "",
              policy: "UNVERIFIED_ONLY",
              roleIds: [],
              deniedRoleIds: [],
              autoSync: true,
            })
          }
        >
          Add visibility rule
        </button>
        <button
          disabled={disabled}
          onClick={() =>
            void mutate("operations", { action: "sync_visibility" })
          }
        >
          Sync Channel Visibility
        </button>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Channel</th>
              <th>Policy</th>
              <th>Automatic sync</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {settings.channelVisibility.map((r) => (
              <tr key={r.channelId}>
                <td>
                  #
                  {directory?.channels.find((c) => c.id === r.channelId)
                    ?.name || r.channelId}
                </td>
                <td>{policies[r.policy]}</td>
                <td>{r.autoSync ? "Enabled" : "Disabled"}</td>
                <td>
                  <button disabled={disabled} onClick={() => setEditing(r)}>
                    Edit
                  </button>{" "}
                  <button
                    disabled={disabled}
                    onClick={() =>
                      void review(
                        settings.channelVisibility.filter(
                          (v) => v.channelId !== r.channelId,
                        ),
                      )
                    }
                  >
                    Remove & preview
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <Modal title="Channel Visibility" onClose={() => setEditing(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const rules = settings.channelVisibility.filter(
                (r) => r.channelId !== editing.channelId,
              );
              void review([...rules, editing]);
            }}
          >
            <div className="form-grid">
              <label>
                Discord channel
                <select
                  required
                  value={editing.channelId}
                  disabled={settings.channelVisibility.some(
                    (r) => r.channelId === editing.channelId,
                  )}
                  onChange={(e) =>
                    setEditing({ ...editing, channelId: e.target.value })
                  }
                >
                  <option value="">Select channel</option>
                  {directory?.channels
                    .filter((c) => [0, 2, 4, 5].includes(c.type))
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        #{c.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Visibility policy
                <select
                  value={editing.policy}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      policy: e.target.value as typeof editing.policy,
                    })
                  }
                >
                  {Object.entries(policies).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Trigger / allowed roles
                <select
                  multiple
                  value={editing.roleIds}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      roleIds: Array.from(
                        e.target.selectedOptions,
                        (o) => o.value,
                      ),
                    })
                  }
                >
                  {directory?.roles
                    .filter((r) => r.name !== "@everyone")
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                </select>
                <small>
                  Leave empty to use configured roles. Unverified Only hides
                  members who hold any selected role.
                </small>
              </label>
              <label>
                Denied roles
                <select
                  multiple
                  value={editing.deniedRoleIds}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      deniedRoleIds: Array.from(
                        e.target.selectedOptions,
                        (o) => o.value,
                      ),
                    })
                  }
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
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={editing.autoSync}
                onChange={(e) =>
                  setEditing({ ...editing, autoSync: e.target.checked })
                }
              />
              Automatic permission synchronization
            </label>
            <div className="form-actions">
              <button className="primary" disabled={disabled}>
                Preview permissions
              </button>
            </div>
          </form>
        </Modal>
      )}
      {preview && (
        <AccessPreview
          plan={preview.plan}
          disabled={disabled}
          onClose={() => setPreview(null)}
          onConfirm={async () => {
            if (
              await mutate("access", {
                settings: preview.settings,
                bindings,
                fingerprint: preview.plan.fingerprint,
              })
            ) {
              setPreview(null);
              setEditing(null);
            }
          }}
        />
      )}
    </section>
  );
}
type Room = {
  id: string;
  voiceChannelId: string;
  destinationChannelId: string;
  mode: "VOICE" | "COMPANION";
  visibility: "PUBLIC" | "TAS" | "FULL_INSPECTION_DETAILS";
  studentIdDisclosureAcknowledged: boolean;
  templateId: string;
  enabled: boolean;
  refreshSeconds: number;
  publishedPanel?: { messageId: string | null; error: string | null } | null;
};
export function RoomPanels({
  directory,
  bindings,
  templates,
  disabled,
  mutate,
  read,
}: {
  directory?: Directory;
  bindings: { feature: string; channelIds: string[] }[];
  templates: { id: string; name: string; feature: string }[];
  disabled: boolean;
  mutate: Mutate;
  read: <T>(path: string) => Promise<T>;
}) {
  const rooms = useQuery({
    queryKey: ["room-panels"],
    queryFn: () => read<Room[]>("room-panels"),
    refetchInterval: 10000,
  });
  const [editing, setEditing] = useState<Omit<
    Room,
    "id" | "publishedPanel"
  > | null>(null);
  const [preview, setPreview] = useState<
    | (AccessPlan & {
        inspectionPreview: {
          visibility: string;
          fullStudentIds: boolean;
          content: string;
        };
      })
    | null
  >(null);
  const [republishing, setRepublishing] = useState<Room | null>(null);
  const [republishAcknowledged, setRepublishAcknowledged] = useState(false);
  const voiceIds =
    bindings.find((b) => b.feature === "ta_voice")?.channelIds || [];
  const roomTemplates = templates.filter(
    (t) => t.feature === "ta_room_queue_panel",
  );
  return (
    <section className="form-padding">
      <h3>TA Inspection Rooms</h3>
      <p>
        Each room panel displays the global queue. Calling next requires the TA
        to be in the mapped room; opening capacity first is optional.
      </p>
      {rooms.error && <p className="notice warning">{rooms.error.message}</p>}
      <button
        disabled={disabled || !directory || !roomTemplates.length}
        onClick={() =>
          setEditing({
            voiceChannelId: "",
            destinationChannelId: "",
            mode: "VOICE",
            visibility: "PUBLIC",
            studentIdDisclosureAcknowledged: false,
            templateId: roomTemplates[0]?.id || "",
            enabled: true,
            refreshSeconds: 30,
          })
        }
      >
        Configure room panel
      </button>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Voice room</th>
              <th>Panel destination</th>
              <th>Visibility</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rooms.data?.map((r) => (
              <tr key={r.id}>
                <td>
                  {directory?.channels.find((c) => c.id === r.voiceChannelId)
                    ?.name || r.voiceChannelId}
                </td>
                <td>
                  {directory?.channels.find(
                    (c) => c.id === r.destinationChannelId,
                  )?.name || r.destinationChannelId}
                </td>
                <td>
                  {r.visibility === "FULL_INSPECTION_DETAILS"
                    ? "Full Inspection Details"
                    : r.visibility === "TAS"
                      ? "TA-only companion access"
                      : "Public-safe queue information"}
                </td>
                <td>
                  {r.publishedPanel?.error ||
                    (!r.enabled
                      ? "Disabled"
                      : r.publishedPanel?.messageId
                        ? "Published"
                        : "Awaiting bot")}
                </td>
                <td>
                  <button
                    disabled={disabled}
                    onClick={() =>
                      setEditing({
                        ...r,
                        studentIdDisclosureAcknowledged: false,
                      })
                    }
                  >
                    Edit
                  </button>{" "}
                  <button
                    disabled={disabled || !r.enabled}
                    onClick={() => {
                      if (r.visibility === "FULL_INSPECTION_DETAILS") {
                        setRepublishing(r);
                        setRepublishAcknowledged(false);
                      } else void mutate(`room-panels/${r.id}/publish`);
                    }}
                  >
                    Republish
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && !preview && (
        <Modal
          title="TA Room Queue Panel"
          onClose={() => {
            setEditing(null);
            setPreview(null);
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void mutate<NonNullable<typeof preview>>(
                "room-panels/preview",
                editing,
              ).then((plan) => {
                if (plan) setPreview(plan);
              });
            }}
          >
            <div className="form-grid">
              <label>
                TA inspection voice room
                <select
                  aria-label="TA inspection voice room"
                  required
                  value={editing.voiceChannelId}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      voiceChannelId: e.target.value,
                      studentIdDisclosureAcknowledged: false,
                      destinationChannelId:
                        editing.mode === "VOICE"
                          ? e.target.value
                          : editing.destinationChannelId,
                    })
                  }
                >
                  <option value="">Select room</option>
                  {directory?.channels
                    .filter((c) => c.type === 2 && voiceIds.includes(c.id))
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Delivery mode
                <select
                  aria-label="Delivery mode"
                  value={editing.mode}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      mode: e.target.value as "VOICE" | "COMPANION",
                      destinationChannelId:
                        e.target.value === "VOICE"
                          ? editing.voiceChannelId
                          : "",
                      visibility: "PUBLIC",
                      studentIdDisclosureAcknowledged: false,
                    })
                  }
                >
                  <option value="VOICE">Voice channel text chat</option>
                  <option value="COMPANION">
                    Companion text channel / active thread
                  </option>
                </select>
              </label>
              <label>
                Panel destination
                <select
                  aria-label="Panel destination"
                  required
                  value={editing.destinationChannelId}
                  disabled={editing.mode === "VOICE"}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      destinationChannelId: e.target.value,
                      studentIdDisclosureAcknowledged: false,
                    })
                  }
                >
                  <option value="">Select destination</option>
                  {directory?.channels
                    .filter((c) =>
                      editing.mode === "VOICE"
                        ? c.id === editing.voiceChannelId
                        : [0, 5, 10, 11, 12].includes(c.type),
                    )
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        #{c.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Template
                <select
                  aria-label="Template"
                  value={editing.templateId}
                  onChange={(e) =>
                    setEditing({ ...editing, templateId: e.target.value })
                  }
                >
                  {roomTemplates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Refresh interval (seconds)
                <input
                  type="number"
                  min="5"
                  max="3600"
                  required
                  value={editing.refreshSeconds}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      refreshSeconds: Number(e.target.value),
                    })
                  }
                />
              </label>
              <label>
                Visibility
                <select
                  aria-label="Visibility"
                  value={editing.visibility}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      visibility: e.target.value as Room["visibility"],
                      studentIdDisclosureAcknowledged: false,
                    })
                  }
                >
                  <option value="PUBLIC">Public-safe queue information</option>
                  <option value="FULL_INSPECTION_DETAILS">
                    Full Inspection Details
                  </option>
                  <option value="TAS" disabled={editing.mode === "VOICE"}>
                    TA-only companion access
                  </option>
                </select>
              </label>
            </div>
            {editing.visibility === "FULL_INSPECTION_DETAILS" && (
              <div className="notice warning" role="alert">
                <p>{studentIdDisclosureWarning}</p>
                <p>
                  Displays registered Student IDs, student names, coursework,
                  ticket information, inspecting TA, and inspection status in
                  the selected channel.
                </p>
                <label className="check">
                  <input
                    type="checkbox"
                    required
                    checked={editing.studentIdDisclosureAcknowledged}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        studentIdDisclosureAcknowledged: e.target.checked,
                      })
                    }
                  />
                  I acknowledge Student ID disclosure in this channel.
                </label>
              </div>
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={editing.enabled}
                onChange={(e) =>
                  setEditing({ ...editing, enabled: e.target.checked })
                }
              />
              Enable panel
            </label>
            <p>
              Threads inherit their parent visibility. Private threads also
              require bot and TA membership. Public-safe remains the default.
              Full Inspection Details does not restrict who can view the
              destination.
            </p>
            <div className="form-actions">
              <button className="primary" disabled={disabled}>
                Preview & publish
              </button>
            </div>
          </form>
        </Modal>
      )}
      {preview && editing && (
        <AccessPreview
          title="Review TA Room Panel"
          plan={preview}
          disabled={disabled}
          onClose={() => setPreview(null)}
          onConfirm={async () => {
            if (
              await mutate("room-panels", {
                ...editing,
                fingerprint: preview.fingerprint,
              })
            ) {
              setPreview(null);
              setEditing(null);
            }
          }}
        >
          <section aria-label="Inspection disclosure preview">
            <h3>Inspection preview</h3>
            <p>
              {preview.inspectionPreview.fullStudentIds
                ? "Full registered Student IDs will be displayed for the current inspection."
                : "Student IDs remain hidden or masked."}
            </p>
            <pre className="inspection-preview">
              {preview.inspectionPreview.content}
            </pre>
          </section>
        </AccessPreview>
      )}
      {republishing && (
        <Modal
          title="Republish Full Inspection Details"
          onClose={() => setRepublishing(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (
                await mutate(`room-panels/${republishing.id}/publish`, {
                  studentIdDisclosureAcknowledged: republishAcknowledged,
                })
              )
                setRepublishing(null);
            }}
          >
            <p className="notice warning" role="alert">
              {studentIdDisclosureWarning}
            </p>
            <label className="check">
              <input
                type="checkbox"
                required
                checked={republishAcknowledged}
                onChange={(e) => setRepublishAcknowledged(e.target.checked)}
              />
              I acknowledge Student ID disclosure in this channel.
            </label>
            <div className="form-actions">
              <button type="button" onClick={() => setRepublishing(null)}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={disabled || !republishAcknowledged}
              >
                Republish panel
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
type Plan = {
  id: string;
  status: string;
  backupVerifiedAt: string | null;
  error: string | null;
  createdAt: string;
  cutoff: string;
  input: { kind: string };
  preview: {
    counts: Record<string, number>;
    protected: Record<string, number>;
    baseline: string[];
    notes: string[];
  };
  result: Record<string, unknown> | null;
};
export function DataManagement({
  owner,
  disabled,
  mutate,
  read,
}: {
  owner: boolean;
  disabled: boolean;
  mutate: Mutate;
  read: <T>(path: string) => Promise<T>;
}) {
  const plans = useQuery({
    queryKey: ["data-management"],
    queryFn: () => read<Plan[]>("data-management"),
    enabled: owner,
    refetchInterval: 10000,
  });
  const [kind, setKind] = useState("PRODUCTION"),
    [method, setMethod] = useState("BASELINE"),
    [categories, setCategories] = useState([
      "queue",
      "inspections",
      "rankings",
      "logs",
      "support",
    ]);
  const [selected, setSelected] = useState<Plan | null>(null),
    [phrase, setPhrase] = useState("");
  const plan = plans.data?.find((p) => p.id === selected?.id) || selected;
  if (!owner)
    return (
      <section className="form-padding">
        <h3>Data Management</h3>
        <p>Owner permission is required for cleanup and backups.</p>
      </section>
    );
  return (
    <section className="form-padding">
      <h3>Data Management</h3>
      <p>
        Prepare for Production clears selected historical data. Live queues,
        pending moves, active inspections, open support tickets, identities and
        configuration are preserved.
      </p>
      {plans.error && <p className="notice warning">{plans.error.message}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          void mutate<Plan>("data-management/preview", {
            kind,
            method,
            categories,
            from: fd.get("from") || null,
            through: fd.get("through") || null,
          }).then((p) => {
            if (p) {
              setSelected(p);
              setPhrase("");
            }
          });
        }}
      >
        <div className="form-grid">
          <label>
            Cleanup action
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries({
                PRODUCTION: "Prepare for Production",
                LOGS: "Clear Bot Logs",
                QUEUE_HISTORY: "Reset Queue History",
                INSPECTION_ANALYTICS: "Reset Inspection Analytics",
                SUPPORT_HISTORY: "Clear Closed Support Ticket History",
                RANKINGS: "Reset All Rankings",
              }).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            Analytics & rankings method
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              <option value="BASELINE">
                New reporting baseline — retain source records
              </option>
              <option value="DELETE">
                Permanently delete historical completed source records
              </option>
            </select>
          </label>
          <label>
            From date
            <input type="date" name="from" />
          </label>
          <label>
            Through date
            <input type="date" name="through" />
          </label>
        </div>
        {kind === "PRODUCTION" && (
          <fieldset>
            <legend>Cleanup categories</legend>
            {["queue", "inspections", "rankings", "logs", "support"].map(
              (c) => (
                <label className="check" key={c}>
                  <input
                    type="checkbox"
                    checked={categories.includes(c)}
                    onChange={(e) =>
                      setCategories(
                        e.target.checked
                          ? [...categories, c]
                          : categories.filter((v) => v !== c),
                      )
                    }
                  />
                  {c}
                </label>
              ),
            )}
          </fieldset>
        )}
        <p>
          Baseline resets apply to all earlier statistics; leave dates empty.
          Removing queue history also removes its completed inspections.
          Current-day logs stay protected. Closed support history follows
          transcript retention.
        </p>
        <div className="form-actions">
          <button className="primary" disabled={disabled || !categories.length}>
            Preview Records
          </button>
        </div>
      </form>
      {plan && (
        <Modal
          title="Confirm historical data cleanup"
          onClose={() => setSelected(null)}
        >
          <p>
            Plan status: <strong>{plan.status}</strong> · cutoff{" "}
            {new Date(plan.cutoff).toLocaleString()}
          </p>
          <h4>Affected records</h4>
          <dl>
            {Object.entries(plan.preview.counts).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          {!!plan.preview.baseline.length && (
            <p>
              Reporting baselines to reset: {plan.preview.baseline.join(", ")}.
              Historical values remain excluded after restart.
            </p>
          )}
          <h4>Protected live records</h4>
          <dl>
            {Object.entries(plan.preview.protected).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          {plan.preview.notes.map((n) => (
            <p key={n}>{n}</p>
          ))}
          {plan.error && <p className="notice warning">{plan.error}</p>}
          {plan.result && <pre>{JSON.stringify(plan.result, null, 2)}</pre>}
          {plan.status !== "COMPLETED" && (
            <>
              <button
                disabled={
                  disabled ||
                  !!plan.backupVerifiedAt ||
                  plan.status === "BACKING_UP" ||
                  plan.status === "RUNNING"
                }
                onClick={() =>
                  void mutate<Plan>(`data-management/${plan.id}/backup`).then(
                    (p) => {
                      if (p) setSelected(p);
                    },
                  )
                }
              >
                {plan.backupVerifiedAt
                  ? "Backup verified"
                  : "Create & verify backup"}
              </button>
              <label>
                Type RESET PRODUCTION DATA
                <input
                  autoComplete="off"
                  value={phrase}
                  onChange={(e) => setPhrase(e.target.value)}
                />
              </label>
              <div className="form-actions">
                <button
                  className="danger"
                  disabled={
                    disabled ||
                    !plan.backupVerifiedAt ||
                    phrase !== "RESET PRODUCTION DATA" ||
                    !["READY", "PARTIAL"].includes(plan.status)
                  }
                  onClick={() =>
                    void mutate<Plan>(`data-management/${plan.id}/execute`, {
                      confirmation: phrase,
                    }).then((p) => {
                      if (p) setSelected(p);
                    })
                  }
                >
                  Execute Cleanup
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
      <h4>Maintenance history</h4>
      {plans.data?.map((p) => (
        <div className="operation-list" key={p.id}>
          <button
            onClick={() => {
              setSelected(p);
              setPhrase("");
            }}
          >
            {p.input.kind} · {p.status} ·{" "}
            {new Date(p.createdAt).toLocaleString()}
          </button>
        </div>
      ))}
    </section>
  );
}
