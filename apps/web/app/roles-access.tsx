"use client";
import { useState } from "react";
import { Modal } from "../../../packages/ui/src/index";
import {
  accessPresets,
  defaultAccess,
  bindingFeatures,
} from "../../../packages/shared/src/index";
import type { Settings } from "../../../packages/shared/src/index";
import type { AccessPlan } from "../../../packages/config/src/access";

type Binding = { feature: string; channelIds: string[] };
type Directory = {
  roles: { id: string; name: string }[];
  channels: { id: string; name: string; type: number }[];
};
export function RolesAccess({
  settings,
  bindings,
  directory,
  disabled,
  mutate,
}: {
  settings: Settings;
  bindings: Binding[];
  directory?: Directory;
  disabled: boolean;
  mutate: <T>(path: string, data?: unknown) => Promise<T | undefined>;
}) {
  const [preview, setPreview] = useState<{
    plan: AccessPlan;
    settings: Settings;
    bindings: Binding[];
    save: boolean;
  } | null>(null);
  async function review(proposed: Settings, selected: Binding[], save = true) {
    const plan = await mutate<AccessPlan>("access/preview", {
      settings: proposed,
      bindings: selected,
    });
    if (plan)
      setPreview({ plan, settings: proposed, bindings: selected, save });
  }
  return (
    <>
      <p className="form-padding">
        Choose server roles and feature channels. Saving shows a permission
        preview before any Discord changes.
      </p>
      {settings.advancedPermissionsEnabled && (
        <div className="notice warning">
          <span>
            Extra action restrictions are active and can block verified
            students. Switch to simple presets to use the configured Student, TA
            and Support roles.
          </span>
          <button
            disabled={disabled}
            onClick={() =>
              void review(
                { ...settings, advancedPermissionsEnabled: false },
                bindings,
              )
            }
          >
            Use simple role presets
          </button>
        </div>
      )}
      <form
        key={JSON.stringify([
          settings.studentRole,
          settings.taRole,
          settings.supportRoles,
          settings.adminRoles,
          settings.featureAccess,
          bindings,
        ])}
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          const proposed = {
            ...settings,
            studentRole: String(fd.get("studentRole") || ""),
            taRole: String(fd.get("taRole") || ""),
            supportRoles: fd.getAll("supportRoles").map(String).filter(Boolean),
            adminRoles: fd.getAll("adminRoles").map(String).filter(Boolean),
            studentVoiceVisible: fd.has("studentVoiceVisible"),
            taStudentChannelAccess: fd.has("taStudentChannelAccess"),
            taStudentChannelExceptions: fd
              .getAll("taStudentChannelExceptions")
              .map(String),
            taStudentConnectChannels: fd
              .getAll("taStudentConnectChannels")
              .map(String),
            featureAccess: Object.fromEntries(
              bindingFeatures
                .filter(
                  (feature) =>
                    !["onboarding_readme", "registration"].includes(feature),
                )
                .map((feature) => [
                  feature,
                  String(fd.get("access-" + feature) || defaultAccess[feature]),
                ]),
            ) as Settings["featureAccess"],
          };
          const selected = bindingFeatures.map((feature) => ({
            feature,
            channelIds: fd
              .getAll("channel-" + feature)
              .map(String)
              .filter(Boolean),
          }));
          void review(proposed, selected);
        }}
      >
        <div className="form-grid form-padding">
          {(
            ["studentRole", "taRole", "supportRoles", "adminRoles"] as const
          ).map((key) => (
            <label key={key}>
              {
                {
                  studentRole: "Student Role",
                  taRole: "TA Role",
                  supportRoles: "Support Roles",
                  adminRoles: "Admin Roles",
                }[key]
              }
              <select
                name={key}
                aria-label={
                  key === "studentRole"
                    ? "Student Role"
                    : key === "taRole"
                      ? "TA Role"
                      : key === "supportRoles"
                        ? "Support Roles"
                        : "Admin Roles"
                }
                multiple={Array.isArray(settings[key])}
                defaultValue={settings[key]}
                disabled={disabled || !directory}
              >
                <option value="">Not configured</option>
                {directory?.roles
                  .filter((r) => r.name !== "@everyone")
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </select>
            </label>
          ))}
        </div>
        <fieldset className="student-access-fields form-padding">
          <legend>Student Channel Access</legend>
          <p className="muted">
            Allow TAs to read student queue, public queue, waiting rooms and
            channels classified as Student Access. Private tickets and
            administrative channels keep their own rules.
          </p>
          <label className="check">
            <input
              name="taStudentChannelAccess"
              type="checkbox"
              defaultChecked={settings.taStudentChannelAccess}
              disabled={disabled}
            />
            Allow Teaching Assistants to View Student Channels
          </label>
          <label>
            Channel exceptions
            <select
              aria-label="Student channel exceptions"
              name="taStudentChannelExceptions"
              multiple
              defaultValue={settings.taStudentChannelExceptions}
              disabled={disabled || !directory}
            >
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
            Allow TA voice connection
            <select
              aria-label="TA waiting voice connections"
              name="taStudentConnectChannels"
              multiple
              defaultValue={settings.taStudentConnectChannels}
              disabled={disabled || !directory}
            >
              {directory?.channels
                .filter(
                  (c) =>
                    c.type === 2 &&
                    bindings
                      .find((b) => b.feature === "waiting_voice")
                      ?.channelIds.includes(c.id),
                )
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
          <small className="muted">
            Empty voice selection changes visibility only. Existing connection
            permissions remain. Choose rooms explicitly to grant Connect; mute
            and inspection-room restrictions are preserved.
          </small>
          <p className="muted">
            Use Preview Changes below to inspect exact role/channel permissions,
            effective access and warnings before applying.
          </p>
        </fieldset>
        <p className="form-padding">
          Verification and README default to Unverified Only. Configure
          overrides in Channel Visibility. IDs alone do not prove identity;
          administrator approval is available in Queue Configuration.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Feature</th>
                <th>Channel</th>
                <th>Access preset</th>
              </tr>
            </thead>
            <tbody>
              {bindingFeatures.map((feature) => {
                const multiple =
                  feature.includes("voice") ||
                  (bindings.find((b) => b.feature === feature)?.channelIds
                    .length || 0) > 1;
                const onboarding = [
                  "onboarding_readme",
                  "registration",
                ].includes(feature);
                const fixed = [
                  "error_log",
                  "audit_log",
                  "system_status",
                ].includes(feature);
                const preset = fixed
                  ? defaultAccess[feature]
                  : settings.featureAccess[feature] || defaultAccess[feature];
                return (
                  <tr key={feature}>
                    <td>
                      {feature === "registration"
                        ? "Student Verification"
                        : feature.replaceAll("_", " ")}
                    </td>
                    <td>
                      <select
                        name={"channel-" + feature}
                        aria-label={feature + " channel"}
                        multiple={multiple}
                        defaultValue={
                          multiple
                            ? bindings.find((b) => b.feature === feature)
                                ?.channelIds || []
                            : bindings.find((b) => b.feature === feature)
                                ?.channelIds[0] || ""
                        }
                        disabled={disabled || !directory}
                      >
                        <option value="">Not configured</option>
                        {directory?.channels
                          .filter((c) =>
                            feature.includes("voice") ||
                            feature === "post_inspection"
                              ? c.type === 2
                              : feature === "ticket_category"
                                ? c.type === 4
                                : [0, 5].includes(c.type),
                          )
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              #{c.name}
                            </option>
                          ))}
                      </select>
                    </td>
                    <td>
                      <select
                        name={"access-" + feature}
                        aria-label={feature + " access"}
                        defaultValue={onboarding ? "" : preset}
                        disabled={disabled || fixed || onboarding}
                      >
                        {onboarding && (
                          <option value="">
                            Unverified Only — Channel Visibility
                          </option>
                        )}
                        {Object.entries(accessPresets).map(([value, name]) => (
                          <option key={value} value={value}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <label className="check form-padding">
          <input
            type="checkbox"
            name="studentVoiceVisible"
            defaultChecked={settings.studentVoiceVisible}
            disabled={disabled}
          />{" "}
          Students can see TA voice rooms; direct Connect remains denied.
        </label>
        <div className="form-actions form-padding">
          <button className="primary" disabled={disabled || !directory}>
            Save Configuration
          </button>
          <button
            type="button"
            disabled={disabled || !directory}
            onClick={() => void review(settings, bindings)}
          >
            Sync Discord Permissions
          </button>
          <button
            type="button"
            disabled={disabled || !directory}
            onClick={() => void review(settings, bindings, false)}
          >
            Validate permissions
          </button>
        </div>
      </form>
      {preview && (
        <AccessPreview
          plan={preview.plan}
          disabled={disabled}
          onClose={() => setPreview(null)}
          onConfirm={
            preview.save
              ? async () => {
                  const saved = await mutate("access", {
                    settings: preview.settings,
                    bindings: preview.bindings,
                    fingerprint: preview.plan.fingerprint,
                  });
                  if (saved) setPreview(null);
                }
              : undefined
          }
        />
      )}
    </>
  );
}

export function AccessPreview({
  plan,
  disabled,
  onClose,
  onConfirm,
  children,
  title = "Review Discord permission changes",
}: {
  title?: string;
  children?: React.ReactNode;
  plan: AccessPlan;
  disabled: boolean;
  onClose: () => void;
  onConfirm?: () => Promise<void>;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      {children}
      {plan.warnings.map((w) => (
        <p className="notice warning" key={w}>
          {w}
        </p>
      ))}
      <p>
        Only listed permission bits change. Other overrides and permissions stay
        intact.
      </p>
      <div className="channel-options">
        {plan.changes
          .filter((c) =>
            Object.keys(c.permissions).some(
              (k) => c.before[k] !== c.permissions[k],
            ),
          )
          .map((c) => (
            <div key={c.channelId + ":" + c.targetId}>
              <strong>
                #{c.channelName} · {c.targetName}
              </strong>
              <p>
                {Object.entries(c.permissions)
                  .filter(([key, value]) => c.before[key] !== value)
                  .map(
                    ([key, value]) =>
                      key +
                      ": " +
                      (value === null ? "Inherit" : value ? "Allow" : "Deny"),
                  )
                  .join(" · ")}
              </p>
            </div>
          ))}
      </div>
      {!!plan.effective?.length && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Channel</th>
                <th>Member</th>
                <th>Before</th>
                <th>After</th>
                <th>Administrator exemption</th>
              </tr>
            </thead>
            <tbody>
              {plan.effective.map((row, index) => (
                <tr key={index}>
                  <td>{row.channelId}</td>
                  <td>{row.member}</td>
                  <td>{row.before ? "Visible" : "Hidden"}</td>
                  <td>{row.after ? "Visible" : "Hidden"}</td>
                  <td>{row.exempt ? "Yes" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="form-actions">
        <button onClick={onClose}>Cancel</button>
        {onConfirm && (
          <button
            className="primary"
            disabled={disabled}
            onClick={() => void onConfirm?.()}
          >
            Confirm save & sync
          </button>
        )}
      </div>
    </Modal>
  );
}
