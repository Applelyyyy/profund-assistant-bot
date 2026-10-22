"use client";
import dynamic from "next/dynamic";
import { consoleQueryKeys } from "../../../packages/shared/src/live-updates";
import { WaitingAlerts } from "./waiting-alerts";
import { ColorPicker } from "../../../packages/ui/src/color-picker";
import {
  ChannelVisibility,
  RoomPanels,
  DataManagement,
} from "./operations-features";
import { RolesAccess, AccessPreview } from "./roles-access";
import {
  useEffect,
  useState,
  useCallback,
  FormEvent,
  ReactNode,
  ReactElement,
  cloneElement,
  useId,
} from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Activity,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  ClipboardList,
  Clock,
  FileText,
  GraduationCap,
  Headphones,
  LayoutDashboard,
  ListOrdered,
  LogOut,
  Menu,
  MessageSquare,
  Monitor,
  Moon,
  MoreHorizontal,
  Palette,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Shield,
  Sun,
  Users,
  Volume2,
  Wifi,
  X,
  Download,
  Upload,
  AlertTriangle,
  Server,
  Database,
  CheckCircle2,
  Link as LinkIcon,
} from "lucide-react";
const QueueActivityChart = dynamic(() =>
  import("./charts").then((m) => m.QueueActivityChart),
);
const CourseworkChart = dynamic(() =>
  import("./charts").then((m) => m.CourseworkChart),
);
import {
  Modal,
  Badge,
  Empty,
  BusyContext,
} from "../../../packages/ui/src/index";
import type { snapshot } from "../../../packages/queue-engine/src/index";
import type { AccessPlan } from "../../../packages/config/src/access";
import type { Template } from "../../../packages/discord-ui/src/index";
import {
  defaults,
  placeholders,
  th,
  normalizeActions,
  panelActions,
} from "../../../packages/discord-ui/src/index";
import type { Settings as GuildSettings } from "../../../packages/shared/src/index";
import {
  bindingFeatures,
  operations,
  actions,
} from "../../../packages/shared/src/index";
import type {
  Student,
  Coursework,
  SupportTicket,
  SupportTicketEvent,
  SystemEvent,
  ServiceOperation,
  AdminUser,
  EmbedTemplate,
  PublishedPanel,
} from "@prisma/client";
type Snapshot = Awaited<ReturnType<typeof snapshot>>;
type Me = { username: string; role: string; csrf: string };
type Health = {
  database: boolean;
  redis: boolean;
  website: boolean;
  services: {
    service: string;
    online: boolean;
    status: string;
    detail: string;
    updatedAt: string;
  }[];
  pending: number;
  failedMoves: number;
};
type Directory = {
  channels: { id: string; name: string; type: number }[];
  roles: { id: string; name: string; color: number }[];
};
type Binding = { feature: string; channelIds: string[] };
type PanelTemplate = EmbedTemplate & { panels: PublishedPanel[] };
type Support = SupportTicket & { events: SupportTicketEvent[] };
type Analytics = {
  totalTickets: number;
  completed: number;
  averageWaitSeconds: number | null;
  taRanking: {
    taId: string;
    name: string;
    completed: number;
    noShows: number;
    students: number;
    durationSeconds: number;
    averageSeconds: number;
    assisted: number;
    courses: string[];
  }[];
  studentRanking: {
    id: string;
    name: string;
    tickets: number;
    completed: number;
    cancelled: number;
    noShows: number;
    lastInspection: string | null;
  }[];
  activity: { date: string; admitted: number; completed: number }[];
  courses: { name: string; count: number }[];
};
const navigation = [
  { key: "overview", name: "Overview", icon: LayoutDashboard },
  { key: "queue", name: "Live queue", icon: ListOrdered },
  { key: "tas", name: "TA management", icon: Headphones },
  { key: "students", name: "Students", icon: GraduationCap },
  { key: "coursework", name: "Coursework", icon: BookOpen },
  { key: "queue-config", name: "Queue configuration", icon: ClipboardList },
  { key: "channels", name: "Discord channels", icon: Volume2 },
  { key: "roles", name: "Roles & Access", icon: Shield },
  { key: "embeds", name: "Embed builder", icon: Palette },
  { key: "support", name: "Support tickets", icon: MessageSquare },
  { key: "analytics", name: "Analytics & rankings", icon: Activity },
  { key: "logs", name: "Logs & audit", icon: FileText },
  { key: "operations", name: "System operations", icon: Server },
  { key: "settings", name: "Settings", icon: Settings },
];
class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const r = await fetch(`/api/${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = await r.json();
  if (!r.ok) throw new ApiError(data.error || "Request failed.", r.status);
  return data;
}
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 10000, refetchOnWindowFocus: true },
  },
});
export default function Console() {
  return (
    <QueryClientProvider client={queryClient}>
      <Dashboard />
    </QueryClientProvider>
  );
}
function relative(value: string | Date) {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 1000),
  );
  return seconds < 60
    ? "Just now"
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ago`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)}h ago`
        : new Date(value).toLocaleDateString();
}
function duration(value: string | Date) {
  const minutes = Math.floor((Date.now() - new Date(value).getTime()) / 60000);
  return minutes < 60
    ? `${Math.max(0, minutes)} min`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
const displayNames: Record<string, string> = {
  MARK_STUDENT_NO_SHOW: "Mark student as No Show",
  CALL_NEXT_STUDENT: "Call next student",
  no_show_dm: "No Show notification",
  waiting_alert_check: "Check alert permissions",
  waiting_alert_test: "Test waiting-room alert",
  rebuild_read_models: "Refresh queue views",
  restart_sync: "Restart panel updates",
  refresh_panels: "Refresh Discord panels",
  reconcile_transfers: "Reconcile voice moves and disconnects",
  retry_moves: "Retry voice moves and disconnects",
  reconnect_gateway: "Reconnect Discord",
  reload_configuration: "Reload saved settings",
};
const label = (value: string) =>
  displayNames[value] ||
  value.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
const tone = (value: string) =>
  ["ACCEPTING", "COMPLETED", "REGISTERED", "online", "OPEN"].includes(value)
    ? "success"
    : ["MOVING", "CLAIMED", "IN_PROGRESS", "SYNC_PENDING", "RUNNING"].includes(
          value,
        )
      ? "primary"
      : ["DRAINING", "NEEDS_REVIEW", "ESCALATED"].includes(value)
        ? "warning"
        : [
              "FAILED",
              "MOVE_FAILED",
              "SYNC_FAILED",
              "offline",
              "CANCELLED",
            ].includes(value)
          ? "danger"
          : "neutral";
function Status({ value }: { value: string }) {
  return <Badge tone={tone(value)}>{label(value)}</Badge>;
}
function Field({
  name,
  children,
  hint,
}: {
  name: string;
  children: ReactElement<{ id?: string; "aria-describedby"?: string }>;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{name}</label>
      {cloneElement(children, {
        id,
        ...(hint ? { "aria-describedby": `${id}-hint` } : {}),
      })}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}
function Panel({
  title,
  detail,
  action,
  children,
  className = "",
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          {detail && <p>{detail}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
function Dashboard() {
  const params = useSearchParams();
  const router = useRouter();
  const active = navigation.some((n) => n.key === params.get("view"))
    ? params.get("view")!
    : "overview";
  const client = useQueryClient();
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => api<Me>("me"),
    retry: false,
  });
  const [message, setMessage] = useState<{
    text: string;
    error: boolean;
  } | null>(null);
  const [alertTab, setAlertTab] = useState("waiting");
  const [theme, setTheme] = useState("dark");
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<ReactNode>(null);
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  useEffect(() => {
    const saved = localStorage.getItem("ta-theme") || "dark";
    setTheme(saved);
    document.documentElement.dataset.theme = saved;
  }, []);
  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    localStorage.setItem("ta-theme", next);
  };
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 8000);
    return () => clearTimeout(t);
  }, [message]);
  const go = (view: string) => {
    setSearch("");
    router.push(`/?view=${view}`);
  };
  const notify = useCallback(
    (text: string, error = false) => setMessage({ text, error }),
    [],
  );
  const mutate = async <T,>(
    path: string,
    data: unknown = {},
    method = "POST",
  ): Promise<T | undefined> => {
    setBusy(true);
    try {
      const value = await api<T>(path, {
        method,
        headers: {
          "x-csrf-token": me.data?.csrf || "",
        },
        body: JSON.stringify(data),
      });
      if (!["room-panels/preview", "access/preview"].includes(path))
        await client.invalidateQueries({
          predicate: (q) => q.queryKey[0] !== "directory",
        });
      notify(
        path.endsWith("/preview")
          ? "Preview ready. No Discord permissions changed."
          : path === "access"
            ? "Configuration saved. Discord permission synchronization queued."
            : path === "room-panels" || path.startsWith("room-panels/")
              ? "Room policy saved. Panel synchronization queued; the room status confirms publication."
              : path.startsWith("support/")
                ? "Support update queued. Ticket status will confirm completion."
                : "Changes saved.",
      );
      return value;
    } catch (e) {
      notify(e instanceof Error ? e.message : "Operation failed.", true);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  const overview = useQuery({
    queryKey: ["overview"],
    queryFn: () => api<Snapshot>("overview"),
    enabled: !!me.data,
    refetchInterval: ["overview", "queue", "tas"].includes(active)
      ? 10000
      : false,
  });
  const health = useQuery({
    queryKey: ["health"],
    queryFn: () => api<Health>("health"),
    enabled: !!me.data,
    refetchInterval: 15000,
  });
  const students = useQuery({
    queryKey: ["students"],
    queryFn: () => api<Student[]>("students"),
    enabled: !!me.data && active === "students",
  });
  const courses = useQuery({
    queryKey: ["coursework"],
    queryFn: () => api<Coursework[]>("coursework"),
    enabled: !!me.data && active === "coursework",
  });
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: () => api<GuildSettings>("settings"),
    enabled:
      !!me.data &&
      ["settings", "roles", "channels", "queue-config", "support"].includes(
        active,
      ),
  });
  const bindings = useQuery({
    queryKey: ["bindings"],
    queryFn: () => api<Binding[]>("bindings"),
    enabled:
      !!me.data && ["channels", "roles", "queue-config"].includes(active),
  });
  const directory = useQuery({
    queryKey: ["directory"],
    queryFn: () => api<Directory>("directory"),
    enabled:
      !!me.data &&
      ["channels", "roles", "embeds", "tas", "queue-config"].includes(active),
    retry: false,
    refetchInterval: 60000,
  });
  const templates = useQuery({
    queryKey: ["templates"],
    queryFn: () => api<PanelTemplate[]>("templates"),
    enabled: !!me.data && ["embeds", "channels"].includes(active),
    refetchInterval: 10000,
  });
  const supports = useQuery({
    queryKey: ["support"],
    queryFn: () => api<Support[]>("support"),
    enabled: !!me.data && active === "support",
  });
  const analytics = useQuery({
    queryKey: ["analytics", dateFrom, dateTo],
    queryFn: () => api<Analytics>(`analytics?from=${dateFrom}&to=${dateTo}`),
    enabled: !!me.data && ["overview", "analytics"].includes(active),
  });
  const logs = useQuery({
    queryKey: ["logs"],
    queryFn: () => api<SystemEvent[]>("logs"),
    enabled: !!me.data && active === "logs",
    refetchInterval: 10000,
  });
  const runtimeLog = useQuery({
    queryKey: ["runtime-logs"],
    queryFn: () => api<Record<string, unknown>[]>("logs/runtime"),
    enabled:
      !!me.data &&
      ["OWNER", "ADMIN"].includes(me.data.role) &&
      active === "logs",
    refetchInterval: 10000,
  });
  const ops = useQuery({
    queryKey: ["operations"],
    queryFn: () => api<ServiceOperation[]>("operations"),
    enabled:
      !!me.data &&
      ["operations", "roles", "support", "students"].includes(active),
    refetchInterval: 5000,
  });
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<AdminUser[]>("accounts"),
    enabled: !!me.data && active === "settings" && me.data.role === "OWNER",
  });
  const sessionUsername = me.data?.username;
  const sessionCsrf = me.data?.csrf;
  useEffect(() => {
    if (!sessionUsername || !sessionCsrf) return;
    const source = new EventSource("/api/events");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Set<string>();
    let opened = false;
    source.onopen = () => {
      if (opened)
        void client.invalidateQueries({
          predicate: (q) => q.queryKey[0] !== "directory",
        });
      opened = true;
    };
    source.onerror = () => {
      void client.invalidateQueries({ queryKey: ["me"] });
    };
    source.onmessage = (event) => {
      let keys: string[];
      try {
        const value = JSON.parse(event.data);
        keys = Array.isArray(value.queries) ? value.queries : consoleQueryKeys;
      } catch {
        keys = consoleQueryKeys;
      }
      for (const key of keys) pending.add(key);
      if (timer || !pending.size) return;
      timer = setTimeout(() => {
        timer = undefined;
        const affected = new Set(pending);
        pending.clear();
        void client.invalidateQueries({
          predicate: (q) => affected.has(String(q.queryKey[0])),
        });
      }, 300);
    };
    return () => {
      source.close();
      if (timer) clearTimeout(timer);
    };
  }, [sessionUsername, sessionCsrf, client]);
  const state = overview.data;
  const canEdit = !!me.data && ["OWNER", "ADMIN"].includes(me.data.role);
  const canOperate =
    !!me.data && ["OWNER", "ADMIN", "OPERATOR"].includes(me.data.role);
  if (me.isPending)
    return (
      <div className="loading-page">
        <RefreshCw size={22} /> Loading administration…
      </div>
    );
  if (!me.data)
    return (
      <Login
        onSuccess={() => void client.invalidateQueries({ queryKey: ["me"] })}
        toggleTheme={toggleTheme}
      />
    );
  const close = () => setModal(null);
  const confirm = async (path: string, data: unknown, text: string) => {
    if (window.confirm(text)) await mutate(path, data);
  };
  const updateSetting = async (patch: Partial<GuildSettings>) => {
    if (settings.data) await mutate("settings", { ...settings.data, ...patch });
  };
  const studentForm = (student?: Student) =>
    setModal(
      <Modal title={student ? "Edit student" : "Add student"} onClose={close}>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            const saved = await mutate(
              `students${student ? `/${student.id}` : ""}`,
              {
                studentId: fd.get("studentId"),
                name: fd.get("name"),
                lastname: fd.get("lastname"),
              },
            );
            if (saved) close();
          }}
        >
          <Field
            name="Student ID"
            hint="Stored as text. Leading zeros are preserved."
          >
            <input
              name="studentId"
              required
              maxLength={64}
              defaultValue={student?.studentId}
            />
          </Field>
          <div className="form-grid">
            <Field name="First name">
              <input
                name="name"
                required
                maxLength={100}
                defaultValue={student?.name}
              />
            </Field>
            <Field name="Last name">
              <input
                name="lastname"
                required
                maxLength={100}
                defaultValue={student?.lastname}
              />
            </Field>
          </div>
          <div className="form-actions">
            <button type="button" onClick={close}>
              Cancel
            </button>
            <button className="primary" disabled={busy}>
              Save student
            </button>
          </div>
        </form>
      </Modal>,
    );
  const mapping = (student: Student) =>
    setModal(
      <Modal title="Remap Discord identity" onClose={close}>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const id =
              new FormData(e.currentTarget)
                .get("discordId")
                ?.toString()
                .trim() || null;
            if (
              window.confirm(
                "Change this student’s Discord mapping? Active tickets must be resolved first.",
              )
            ) {
              const saved = await mutate(`students/${student.id}/mapping`, {
                discordId: id,
              });
              if (saved) close();
            }
          }}
        >
          <p>
            {student.name} {student.lastname} · {student.studentId}
          </p>
          <Field
            name="Discord user ID"
            hint="Leave blank to unlink. A linked account will synchronize nickname and role."
          >
            <input
              name="discordId"
              defaultValue={student.discordId || ""}
              pattern="[0-9]{17,20}"
            />
          </Field>
          {student.syncError && (
            <div className="notice danger">{student.syncError}</div>
          )}
          <div className="form-actions">
            <button className="primary" disabled={busy}>
              Save mapping
            </button>
          </div>
        </form>
      </Modal>,
    );
  const courseworkForm = (course?: Coursework) =>
    setModal(
      <Modal
        title={course ? "Edit coursework" : "Create coursework"}
        onClose={close}
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            const text = (key: string) => fd.get(key)?.toString() || "";
            const saved = await mutate(
              `coursework${course ? `/${course.id}` : ""}`,
              {
                name: text("name"),
                description: text("description"),
                label: text("label"),
                sortOrder: Number(text("sortOrder")),
                enabled: fd.has("enabled"),
                archived: course?.archived || false,
                eligibleUsers: text("users")
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
                eligibleRoles: text("roles")
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
                startsAt: text("startsAt")
                  ? new Date(text("startsAt")).toISOString()
                  : null,
                endsAt: text("endsAt")
                  ? new Date(text("endsAt")).toISOString()
                  : null,
              },
            );
            if (saved) close();
          }}
        >
          <Field name="Coursework name">
            <input
              name="name"
              required
              maxLength={100}
              defaultValue={course?.name}
            />
          </Field>
          <Field name="Description">
            <textarea
              name="description"
              maxLength={2000}
              defaultValue={course?.description}
            />
          </Field>
          <div className="form-grid">
            <Field name="Course label">
              <input name="label" defaultValue={course?.label} />
            </Field>
            <Field name="Display order">
              <input
                name="sortOrder"
                type="number"
                defaultValue={course?.sortOrder || 0}
              />
            </Field>
          </div>
          <Field
            name="Eligible TA user IDs"
            hint="Comma-separated. Leave both eligibility fields empty to allow all configured TAs."
          >
            <input
              name="users"
              defaultValue={course?.eligibleUsers.join(",")}
            />
          </Field>
          <Field name="Eligible TA role IDs">
            <input
              name="roles"
              defaultValue={course?.eligibleRoles.join(",")}
            />
          </Field>
          <div className="form-grid">
            <Field name="Available from">
              <input
                name="startsAt"
                type="datetime-local"
                defaultValue={
                  course?.startsAt
                    ? new Date(
                        new Date(course.startsAt).getTime() -
                          new Date().getTimezoneOffset() * 60000,
                      )
                        .toISOString()
                        .slice(0, 16)
                    : ""
                }
              />
            </Field>
            <Field name="Available until">
              <input
                name="endsAt"
                type="datetime-local"
                defaultValue={
                  course?.endsAt
                    ? new Date(
                        new Date(course.endsAt).getTime() -
                          new Date().getTimezoneOffset() * 60000,
                      )
                        .toISOString()
                        .slice(0, 16)
                    : ""
                }
              />
            </Field>
          </div>
          <label className="check">
            <input
              name="enabled"
              type="checkbox"
              defaultChecked={course?.enabled ?? true}
            />{" "}
            Accept queue requests
          </label>
          <div className="form-actions">
            <button type="button" onClick={close}>
              Cancel
            </button>
            <button className="primary" disabled={busy}>
              Save coursework
            </button>
          </div>
        </form>
      </Modal>,
    );
  const accountForm = (account?: AdminUser) =>
    setModal(
      <Modal
        title={account ? "Edit administrator" : "Create administrator"}
        onClose={close}
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            const password = fd.get("password")?.toString();
            const value = await mutate(
              `accounts${account ? `/${account.id}` : ""}`,
              {
                username: fd.get("username"),
                ...(password ? { password } : {}),
                role: fd.get("role"),
                disabled: fd.has("disabled"),
              },
            );
            if (value) close();
          }}
        >
          <Field name="Username">
            <input
              name="username"
              autoComplete="off"
              defaultValue={account?.username}
              required
              pattern="[a-zA-Z0-9_.-]{3,64}"
            />
          </Field>
          <Field
            name={account ? "New password (optional)" : "Password"}
            hint="At least 14 characters. Password changes revoke all sessions."
          >
            <input
              type="password"
              name="password"
              autoComplete="new-password"
              minLength={14}
              maxLength={256}
              required={!account}
            />
          </Field>
          <Field name="Role">
            <select name="role" defaultValue={account?.role || "ADMIN"}>
              {["OWNER", "ADMIN", "OPERATOR", "VIEWER"].map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </Field>
          <label className="check">
            <input
              type="checkbox"
              name="disabled"
              defaultChecked={account?.disabled}
            />{" "}
            Disable account
          </label>
          <div className="form-actions">
            <button className="primary" disabled={busy}>
              Save account
            </button>
          </div>
        </form>
      </Modal>,
    );
  async function uploadCsv(file: File) {
    if (
      !file.name.toLowerCase().endsWith(".csv") ||
      file.size > 2 * 1024 * 1024
    ) {
      notify("Upload a UTF-8 .csv file under 2 MB.", true);
      return;
    }
    const preview = await mutate<{
      id: string;
      rows: { studentId: string; name: string; lastname: string }[];
      errors: { row: number; message: string }[];
      duplicates: string[];
    }>("students/preview", { filename: file.name, csv: await file.text() });
    if (preview)
      setModal(
        <Modal title="Review student import" onClose={close}>
          <p>
            {preview.rows.length} valid rows · {preview.duplicates.length}{" "}
            existing IDs · {preview.errors.length} errors
          </p>
          {preview.errors.length > 0 ? (
            <div className="notice danger">
              {preview.errors.slice(0, 20).map((e) => (
                <p key={e.row}>
                  Row {e.row}: {e.message}
                </p>
              ))}
            </div>
          ) : null}
          <Table head={["Student ID", "Name"]}>
            {preview.rows.slice(0, 10).map((r) => (
              <tr key={r.studentId}>
                <td>{r.studentId}</td>
                <td>
                  {r.name} {r.lastname}
                </td>
              </tr>
            ))}
          </Table>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const saved = await mutate("students/commit", {
                importId: preview.id,
                duplicates: new FormData(e.currentTarget).get("duplicates"),
              });
              if (saved) {
                close();
                notify(
                  "Student import committed. Existing Discord mappings preserved.",
                );
              }
            }}
          >
            <Field name="Existing student IDs">
              <select name="duplicates">
                <option value="skip">Skip existing records</option>
                <option value="update">
                  Update names; preserve Discord mappings
                </option>
                <option value="error">Reject if any ID exists</option>
              </select>
            </Field>
            <div className="form-actions">
              <button type="button" onClick={close}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={busy || !!preview.errors.length}
              >
                Commit import
              </button>
            </div>
          </form>
        </Modal>,
      );
  }
  const filteredTickets =
    state?.tickets.filter((t) =>
      `${t.sequence} ${t.student.name} ${t.student.lastname} ${t.coursework.name} ${t.session?.taName || "Unclaimed"} ${t.status}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ) || [];
  const queueTable = (compact = false) => (
    <>
      {!filteredTickets.length ? (
        <Empty title={search ? "No matching tickets" : "Queue is clear"}>
          {search
            ? "Try another search."
            : "Students appear here after joining the global queue."}
        </Empty>
      ) : (
        <Table
          head={[
            "Ticket",
            "Student",
            "Coursework",
            "Inspecting TA",
            ...(compact ? [] : ["Waiting"]),
            "Status",
            ...(canOperate && !compact ? ["Actions"] : []),
          ]}
        >
          {filteredTickets.slice(0, compact ? 6 : 200).map((t) => (
            <tr key={t.id}>
              <td className="number">#{String(t.sequence).padStart(3, "0")}</td>
              <td>
                <div className="person">
                  <span className="avatar">{t.student.name.slice(0, 1)}</span>
                  <div>
                    <strong>
                      {t.student.name} {t.student.lastname}
                    </strong>
                    <small>{t.student.studentId}</small>
                  </div>
                </div>
              </td>
              <td>{t.coursework.name}</td>
              <td>
                {t.status === "QUEUED"
                  ? "Global FIFO · TA chosen when called"
                  : t.session?.taName || "Unclaimed"}
                <small className="subtext">
                  {t.status === "QUEUED"
                    ? "Next eligible TA calls in FIFO order"
                    : t.session?.present
                      ? "In assigned room"
                      : "Away from room"}
                </small>
              </td>
              {!compact && <td>{duration(t.createdAt)}</td>}
              <td>
                <Status value={t.status} />
              </td>
              {canOperate && !compact && (
                <td>
                  <div className="row-actions">
                    {["QUEUED", "MOVE_FAILED"].includes(t.status) && (
                      <button
                        onClick={() =>
                          void confirm(
                            `queue/${t.id}/cancel`,
                            {},
                            `Cancel ticket #${t.sequence}? This releases the waiting reservation.`,
                          )
                        }
                      >
                        Cancel
                      </button>
                    )}
                    {["MOVE_FAILED", "NEEDS_REVIEW"].includes(t.status) && (
                      <button
                        onClick={() => void mutate(`queue/${t.id}/retry`)}
                      >
                        Retry move
                      </button>
                    )}
                  </div>
                </td>
              )}
            </tr>
          ))}
        </Table>
      )}
    </>
  );
  const allErrors = [
    overview,
    health,
    students,
    courses,
    settings,
    bindings,
    templates,
    supports,
    analytics,
    logs,
    ops,
    accounts,
  ]
    .filter((q) => q.isError)
    .map((q) => (q.error as Error).message);
  const botOnline =
    health.data?.services.some(
      (s) => s.service === "bot" && s.online && s.status === "online",
    ) || false;
  const chart = analytics.data?.activity || [];
  let content: ReactNode;
  if (active === "overview")
    content = (
      <>
        {state && !state.sessions.length && (
          <div className="setup-banner">
            <div className="setup-icon">
              <GraduationCap size={24} />
            </div>
            <div>
              <strong>Ready for your next coursework session</strong>
              <p>
                Bind Discord channels, assign roles, then start a queue from the
                TA dashboard.
              </p>
            </div>
            <button onClick={() => go("channels")}>
              Configure Discord <ArrowUpRight size={16} />
            </button>
          </div>
        )}
        <div className="metric-grid">
          {[
            {
              name: "Students waiting",
              value: state?.metrics.waiting,
              icon: Users,
              detail: "Durable waiting reservations",
            },
            {
              name: "Available slots",
              value: state?.metrics.available,
              icon: ClipboardList,
              detail: `${state?.metrics.capacity ?? 0} total accepting capacity`,
            },
            {
              name: "In progress",
              value: state?.metrics.inProgress,
              icon: Headphones,
              detail: "Verified voice transfers",
            },
            {
              name: "Active TAs",
              value: state?.metrics.activeTAs,
              icon: GraduationCap,
              detail: `${state?.metrics.draining ?? 0} tickets in draining sessions`,
            },
            {
              name: "Needs attention",
              value: state?.metrics.failed,
              icon: AlertTriangle,
              detail: "Failed or uncertain transfers",
            },
          ].map((m) => (
            <div className="metric" key={m.name}>
              <div className="metric-label">
                {m.name}
                <m.icon size={17} />
              </div>
              <strong>{m.value ?? "—"}</strong>
              <small>{m.detail}</small>
            </div>
          ))}
        </div>
        <Panel
          title="Live queue"
          detail={`${state?.metrics.waiting ?? 0} waiting · ${state?.metrics.draining ?? 0} draining`}
          action={
            <button className="text-button" onClick={() => go("queue")}>
              View queue <ArrowUpRight size={14} />
            </button>
          }
        >
          {queueTable(true)}
        </Panel>
        <div className="overview-grid">
          <Panel
            title="TA sessions"
            detail="Room ownership and capacity"
            action={
              <button className="text-button" onClick={() => go("tas")}>
                Manage <ArrowUpRight size={14} />
              </button>
            }
          >
            {state?.sessions.length ? (
              <div className="session-list">
                {state.sessions.slice(0, 5).map((s) => (
                  <div key={s.id}>
                    <span className="avatar">{s.taName[0]}</span>
                    <div>
                      <strong>{s.taName}</strong>
                      <small>{s.capacity} admission slots</small>
                    </div>
                    <Status value={!s.present ? "offline" : s.status} />
                  </div>
                ))}
              </div>
            ) : (
              <Empty title="No active sessions">
                TAs can start a session from their assigned voice room.
              </Empty>
            )}
          </Panel>
          <Panel
            title="Recent activity"
            detail="Committed events from the platform"
            action={
              <button className="text-button" onClick={() => go("logs")}>
                All events <ArrowUpRight size={14} />
              </button>
            }
          >
            <ActivityList events={state?.events.slice(0, 5) || []} />
          </Panel>
        </div>
        <div className="overview-grid">
          <Panel
            title="Queue activity"
            detail="Admissions and completed inspections"
            action={<Badge>Recorded activity</Badge>}
          >
            {chart.length ? (
              <div className="chart">
                <QueueActivityChart data={chart} />
              </div>
            ) : (
              <Empty title="Activity starts with the first ticket">
                Admission and completion history will appear here.
              </Empty>
            )}
          </Panel>
          <Panel
            title="Service status"
            detail="Checked against current services"
            action={
              <button className="text-button" onClick={() => go("operations")}>
                Details <ArrowUpRight size={14} />
              </button>
            }
          >
            <div className="service-list">
              {[
                { name: "Discord Gateway", ok: botOnline, icon: Wifi },
                {
                  name: "PostgreSQL",
                  ok: health.data?.database,
                  icon: Database,
                },
                { name: "Redis", ok: health.data?.redis, icon: Server },
                {
                  name: "Queue worker",
                  ok: health.data?.services.some(
                    (s) =>
                      s.service === "worker" &&
                      s.online &&
                      s.status === "online",
                  ),
                  icon: Activity,
                },
              ].map((s) => (
                <div key={s.name}>
                  <span>
                    <s.icon size={17} />
                    {s.name}
                  </span>
                  <Badge tone={s.ok ? "success" : "neutral"}>
                    {s.ok ? "Connected" : "Offline"}
                  </Badge>
                </div>
              ))}
            </div>
            <div className="service-foot">
              <Shield size={15} /> Queue state persists across service restarts.
            </div>
          </Panel>
        </div>
      </>
    );
  else if (active === "queue")
    content = (
      <>
        <div className="inline-summary">
          <span>
            <strong>{state?.metrics.waiting ?? 0}</strong> waiting
          </span>
          <span>
            <strong>{state?.metrics.available ?? 0}</strong> available
          </span>
          <span>
            <strong>{state?.metrics.draining ?? 0}</strong> draining
          </span>
          <span>
            <strong>{state?.metrics.inProgress ?? 0}</strong> in progress
          </span>
        </div>
        <Panel
          title="Current tickets"
          detail="Admission order stays fixed. Claimed tickets cannot be cancelled."
          action={<SearchBox value={search} onChange={setSearch} />}
        >
          {queueTable()}
        </Panel>
      </>
    );
  else if (active === "tas")
    content = (
      <Panel
        title="Teaching assistants"
        detail="Start Queue opens global admission capacity. Any authorized TA in an inspection room can call the next student."
      >
        {state?.sessions.length ? (
          <Table
            head={[
              "Teaching assistant",
              "Voice room",
              "Admission capacity",
              "Session",
              "Current inspection",
              ...(canOperate ? ["Actions"] : []),
            ]}
          >
            {state.sessions.map((s) => (
              <tr key={s.id}>
                <td>
                  <strong>{s.taName}</strong>
                  <small className="subtext">{s.taId}</small>
                </td>
                <td>
                  {directory.data?.channels.find(
                    (c) => c.id === s.voiceChannelId,
                  )?.name || s.voiceChannelId}
                  <small className="subtext">
                    {s.present ? "Present" : "Away"}
                  </small>
                </td>
                <td>
                  {s.status === "ACCEPTING" && s.present && !s.paused
                    ? s.capacity
                    : 0}{" "}
                  slots
                </td>
                <td>
                  <Status value={s.paused ? "PAUSED" : s.status} />
                </td>
                <td>
                  {state.tickets
                    .filter(
                      (t) => t.sessionId === s.id && t.status === "IN_PROGRESS",
                    )
                    .map((t) => `#${t.sequence} ${t.student.name}`)
                    .join(", ") || "Available"}
                </td>
                {canOperate && (
                  <td>
                    <div className="row-actions">
                      <button
                        onClick={() =>
                          void mutate(
                            `sessions/${s.id}/${s.paused ? "resume" : "pause"}`,
                          )
                        }
                      >
                        {s.paused ? "Resume" : "Pause"}
                      </button>
                      <button
                        onClick={() =>
                          setModal(
                            <Modal
                              title={`${s.taName} · Session settings`}
                              onClose={close}
                            >
                              <form
                                onSubmit={async (e) => {
                                  e.preventDefault();
                                  const fd = new FormData(e.currentTarget);
                                  const v = await mutate(
                                    `sessions/${s.id}/settings`,
                                    {
                                      capacity: Number(fd.get("capacity")),
                                      weight: Number(fd.get("weight")),
                                      courseworkIds: (
                                        fd.get("courses")?.toString() || ""
                                      )
                                        .split(",")
                                        .map((x) => x.trim())
                                        .filter(Boolean),
                                      note: fd.get("note"),
                                    },
                                  );
                                  if (v) close();
                                }}
                              >
                                <div className="form-grid">
                                  <Field name="Waiting capacity">
                                    <input
                                      name="capacity"
                                      type="number"
                                      required
                                      defaultValue={s.capacity}
                                    />
                                  </Field>
                                  <Field name="Allocation weight">
                                    <input
                                      name="weight"
                                      type="number"
                                      min={1}
                                      max={100}
                                      defaultValue={s.weight}
                                    />
                                  </Field>
                                </div>
                                <Field name="Accepted coursework IDs (comma-separated)">
                                  <input
                                    name="courses"
                                    defaultValue={s.courseworkIds.join(",")}
                                  />
                                </Field>
                                <Field name="Session note">
                                  <textarea name="note" defaultValue={s.note} />
                                </Field>
                                <div className="form-actions">
                                  <button className="primary" disabled={busy}>
                                    Save session settings
                                  </button>
                                </div>
                              </form>
                            </Modal>,
                          )
                        }
                      >
                        Settings
                      </button>
                      <button
                        onClick={() =>
                          void confirm(
                            `sessions/${s.id}/stop`,
                            {},
                            "Stop accepting for this TA? Existing tickets remain in a draining queue.",
                          )
                        }
                      >
                        Stop accepting
                      </button>
                      <button
                        onClick={() =>
                          setModal(
                            <Modal
                              title={`${s.taName} · Queue`}
                              onClose={close}
                            >
                              <p>
                                Room {s.voiceChannelId} · Started{" "}
                                {new Date(s.activatedAt).toLocaleString()}
                              </p>
                              <ActivityList
                                events={state.events.filter(
                                  (e) =>
                                    (e.data as Record<string, unknown>)
                                      .sessionId === s.id,
                                )}
                              />
                              <Table head={["Ticket", "Student", "Status"]}>
                                {state.tickets
                                  .filter((t) => t.sessionId === s.id)
                                  .map((t) => (
                                    <tr key={t.id}>
                                      <td>#{t.sequence}</td>
                                      <td>{t.student.name}</td>
                                      <td>
                                        <Status value={t.status} />
                                      </td>
                                    </tr>
                                  ))}
                              </Table>
                            </Modal>,
                          )
                        }
                      >
                        Details
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </Table>
        ) : (
          <Empty title="No active TA sessions">
            Join an inspection voice room to call the next student. Start Queue
            opens new admission slots.
          </Empty>
        )}
        <div className="panel-note">
          Any authorized TA in an inspection room can use Call Next Student.
          Start Queue opens admission capacity only; waiting tickets belong to
          the global queue.
        </div>
      </Panel>
    );
  else if (active === "students")
    content = (
      <>
        <Panel
          title="Student directory"
          detail="Student IDs remain text. Imported names never overwrite Discord mappings."
          action={
            canEdit ? (
              <div className="row-actions">
                <button
                  disabled={busy || !students.data?.length}
                  onClick={() => void mutate("students/recover-mappings")}
                >
                  Recover Discord mappings
                </button>
                <a className="button" href="/api/students/template">
                  <Download size={15} /> CSV template
                </a>
                <label className="button">
                  <Upload size={15} /> Import CSV
                  <input
                    className="sr-only"
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void uploadCsv(file);
                      e.target.value = "";
                    }}
                  />
                </label>
                <button className="primary" onClick={() => studentForm()}>
                  <Plus size={16} /> Add student
                </button>
              </div>
            ) : null
          }
        >
          <p className="panel-note">
            Recovery runs after import. Only members with the configured Student
            role and a matching student ID and name are linked. Ambiguous
            matches and existing mappings stay unchanged.
          </p>
          {ops.data
            ?.filter((op) => op.action === "recover_identities")
            .slice(0, 1)
            .map((op) => (
              <p className="panel-note" role="status" key={op.id}>
                Discord mapping recovery: {label(op.status)}
                {op.error
                  ? ` · ${op.error}`
                  : op.status === "COMPLETED" &&
                      op.data &&
                      typeof op.data === "object" &&
                      !Array.isArray(op.data)
                    ? ` · ${String(op.data.recovered ?? 0)} recovered · ${String(op.data.skipped ?? 0)} unchanged`
                    : ""}
              </p>
            ))}
          <div className="table-toolbar">
            <SearchBox value={search} onChange={setSearch} />
            <a className="button" href="/api/students/export">
              <Download size={15} /> Export CSV
            </a>
          </div>
          {students.data?.length ? (
            <Table
              head={[
                "Student ID",
                "Student",
                "Discord account",
                "Registration",
                ...(canEdit ? ["Actions"] : []),
              ]}
            >
              {students.data
                .filter((s) =>
                  `${s.studentId} ${s.name} ${s.lastname} ${s.registration} ${s.discordId || ""}`
                    .toLowerCase()
                    .includes(search.toLowerCase()),
                )
                .map((s) => (
                  <tr key={s.id}>
                    <td className="number">{s.studentId}</td>
                    <td>
                      <strong>
                        {s.name} {s.lastname}
                      </strong>
                    </td>
                    <td>{s.discordId || "Not linked"}</td>
                    <td>
                      <Status value={s.registration} />
                    </td>
                    {canEdit && (
                      <td>
                        <div className="row-actions">
                          <button onClick={() => studentForm(s)}>Edit</button>
                          <button onClick={() => mapping(s)}>Identity</button>
                          {s.registration === "APPROVAL_PENDING" && (
                            <button
                              onClick={() =>
                                void confirm(
                                  `students/${s.id}/approve`,
                                  {},
                                  "Approve this student identity and grant the Student role?",
                                )
                              }
                            >
                              Approve verification
                            </button>
                          )}
                          <button
                            className="danger-text"
                            onClick={() => {
                              if (
                                window.confirm(
                                  `Remove ${s.name}? Records with queue history cannot be deleted.`,
                                )
                              )
                                void mutate(`students/${s.id}`, {}, "DELETE");
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
            </Table>
          ) : (
            <Empty title="Add your student roster">
              Upload a CSV with id, name, lastname or create a student manually.
            </Empty>
          )}
        </Panel>
      </>
    );
  else if (active === "coursework")
    content = (
      <Panel
        title="Coursework"
        detail="Configure what students can select and which TAs can accept it."
        action={
          canEdit && (
            <button className="primary" onClick={() => courseworkForm()}>
              <Plus size={16} /> Create coursework
            </button>
          )
        }
      >
        {courses.data?.length ? (
          <Table
            head={[
              "Assignment",
              "Course label",
              "Eligibility",
              "Admission",
              ...(canEdit ? ["Actions"] : []),
            ]}
          >
            {courses.data.map((c) => (
              <tr key={c.id}>
                <td>
                  <strong>{c.name}</strong>
                  <small className="subtext">
                    {c.description || "No description"}
                    <br />
                    ID: {c.id}
                  </small>
                </td>
                <td>{c.label || "—"}</td>
                <td>
                  {c.eligibleUsers.length + c.eligibleRoles.length
                    ? `${c.eligibleUsers.length} users, ${c.eligibleRoles.length} roles`
                    : "All authorized TAs"}
                </td>
                <td>
                  <Status
                    value={
                      c.archived
                        ? "ARCHIVED"
                        : c.enabled
                          ? "ACCEPTING"
                          : "PAUSED"
                    }
                  />
                </td>
                {canEdit && (
                  <td>
                    <div className="row-actions">
                      <button onClick={() => courseworkForm(c)}>Edit</button>
                      <button
                        onClick={() =>
                          void confirm(
                            `coursework/${c.id}`,
                            {
                              ...c,
                              startsAt: c.startsAt
                                ? new Date(c.startsAt).toISOString()
                                : null,
                              endsAt: c.endsAt
                                ? new Date(c.endsAt).toISOString()
                                : null,
                              archived: !c.archived,
                            },
                            c.archived
                              ? "Restore this coursework?"
                              : "Archive this coursework? Existing tickets remain valid.",
                          )
                        }
                      >
                        {c.archived ? "Restore" : "Archive"}
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </Table>
        ) : (
          <Empty title="No coursework configured">
            Create an assignment to enable student selections.
          </Empty>
        )}
      </Panel>
    );
  else if (active === "queue-config")
    content = settings.data ? (
      <>
        <SettingsForm
          settings={settings.data}
          disabled={!canEdit || busy}
          onSave={(value) => void mutate("settings", value)}
          fields={[
            "defaultCapacity",
            "minCapacity",
            "maxCapacity",
            "inspectionConcurrency",
            "maintenance",
            "requireIdentity",
            "allowCancellation",
            "maxMoveAttempts",
            "claimLeaseSeconds",
            "noShowTimeoutSeconds",
          ]}
          title="Queue admission & recovery"
        />
        <SettingsForm
          settings={settings.data}
          disabled={!canEdit || busy}
          onSave={(value) => void mutate("settings", value)}
          fields={[
            "autoMute",
            "muteCleanup",
            "routineAnnouncements",
            "publicStudentIds",
            "queueShowCoursework",
            "calledText",
            "publicStudentNames",
            "publicStudentRanking",
          ]}
          title="Voice & student privacy"
        />
        <Panel
          title="Alerts"
          detail="Waiting Room: no ticket yet. Abandoned Queue: tickets already exist. Operations: transfers or jobs need attention."
        >
          <div
            role="tablist"
            aria-label="Queue alert types"
            className="alert-tabs"
          >
            {[
              ["waiting", "Waiting Room"],
              ["abandoned", "Abandoned Queue"],
              ["operations", "Operations"],
            ].map(([key, title], index) => (
              <button
                key={key}
                id={`alert-tab-${key}`}
                role="tab"
                type="button"
                aria-selected={alertTab === key}
                aria-controls={`alert-panel-${key}`}
                tabIndex={alertTab === key ? 0 : -1}
                onClick={() => setAlertTab(key)}
                onKeyDown={(e) => {
                  if (
                    ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)
                  ) {
                    e.preventDefault();
                    const next =
                      e.key === "Home"
                        ? 0
                        : e.key === "End"
                          ? 2
                          : (index + (e.key === "ArrowRight" ? 1 : 2)) % 3;
                    setAlertTab(["waiting", "abandoned", "operations"][next]);
                    e.currentTarget.parentElement
                      ?.querySelectorAll<HTMLButtonElement>("button")
                      [next].focus();
                  }
                }}
              >
                {title}
              </button>
            ))}
          </div>
          <div
            id="alert-panel-waiting"
            role="tabpanel"
            aria-labelledby="alert-tab-waiting"
            hidden={alertTab !== "waiting"}
          >
            <WaitingAlerts
              settings={settings.data}
              bindings={bindings.data || []}
              directory={directory.data}
              disabled={!canEdit || busy}
              mutate={mutate}
              onTemplates={() => go("embeds")}
            />
          </div>
          <div
            id="alert-panel-abandoned"
            role="tabpanel"
            aria-labelledby="alert-tab-abandoned"
            hidden={alertTab !== "abandoned"}
          >
            <p className="form-padding muted">
              Notify staff when unresolved queue tickets already exist and no
              eligible TA is physically present. This does not detect students
              without tickets.
            </p>
            <SettingsForm
              settings={settings.data}
              disabled={!canEdit || busy}
              onSave={(value) => void mutate("settings", value)}
              fields={[
                "alertGraceSeconds",
                "alertCooldownSeconds",
                "alertText",
              ]}
              title="Abandoned Queue Alerts"
            />
            <p className="form-padding muted">
              Uses the Queue Alert channel binding. The grace period prevents
              brief TA room changes from creating an incident.
            </p>
          </div>
          <div
            id="alert-panel-operations"
            role="tabpanel"
            aria-labelledby="alert-tab-operations"
            hidden={alertTab !== "operations"}
          >
            <p className="form-padding muted">
              Notify staff about failed voice moves, stalled tickets and other
              queue errors. Configure Error Log and Queue Alert destinations in
              Discord Channels.
            </p>
            <SettingsForm
              settings={settings.data}
              disabled={!canEdit || busy}
              onSave={(value) => void mutate("settings", value)}
              fields={["notifications", "staleWarningSeconds", "failedText"]}
              title="Queue Operation Alerts"
            />
          </div>
        </Panel>
        <SettingsForm
          title="No Show notifications"
          settings={settings.data}
          disabled={!canEdit || busy}
          onSave={(value) => void mutate("settings", value)}
          fields={["noShowDMEnabled"]}
        />
        <p className="form-padding muted">
          No Show is a confirmed TA decision about their current student. It
          never awards completion credit. Edit the No Show DM template in Embed
          Builder; blocked DMs do not undo the decision.
        </p>
        <p className="form-padding muted">
          Routine call and arrival announcements are off by default. Enable them
          above and edit the Student Called template in Embed Builder. Room
          panels always update in place.
        </p>
        <SettingsForm
          title="Verification & live Discord panels"
          settings={settings.data}
          disabled={!canEdit || busy}
          onSave={(value) => void mutate("settings", value)}
          fields={[
            "verificationMode",
            "embedAutoRefreshEnabled",
            "embedRefreshIntervalSeconds",
            "embedUpdateDebounceMs",
          ]}
        />
        <p className="notice warning">
          Student ID alone is not strong identity proof. Use administrator
          approval when IDs are easy to obtain. Auto-refresh controls periodic
          reconciliation; committed events still trigger updates.
        </p>
      </>
    ) : null;
  else if (active === "channels")
    content = (
      <>
        <Panel
          title="TA Room Queue Panels"
          detail="Room-scoped controls for the existing global FIFO queue."
        >
          <RoomPanels
            directory={directory.data}
            bindings={bindings.data || []}
            templates={templates.data || []}
            disabled={!canEdit || busy}
            mutate={mutate}
            read={api}
          />
        </Panel>
        <div className="notice">
          <Volume2 size={18} />
          <span>
            Choose channels fetched from your Discord server. Voice destinations
            remain bound to each TA session.
          </span>
        </div>
        {directory.error && (
          <div className="notice warning">{directory.error.message}</div>
        )}
        <Panel
          title="Channel bindings"
          detail="Changes apply without restarting the bot."
          action={
            canOperate && (
              <button
                onClick={() =>
                  void mutate("operations", { action: "validate_channels" })
                }
              >
                <Shield size={16} /> Check permissions
              </button>
            )
          }
        >
          <Table
            head={[
              "Feature",
              "Bound channels",
              ...(canEdit ? ["Actions"] : []),
            ]}
          >
            {bindingFeatures.map((f) => (
              <tr key={f}>
                <td>{label(f)}</td>
                <td>
                  {bindings.data
                    ?.find((b) => b.feature === f)
                    ?.channelIds.map(
                      (id) =>
                        directory.data?.channels.find((c) => c.id === id)
                          ?.name || id,
                    )
                    .join(", ") || (
                    <span className="muted">Not configured</span>
                  )}
                </td>
                {canEdit && (
                  <td>
                    <button
                      disabled={!directory.data}
                      onClick={() =>
                        setModal(
                          <Modal title={`Bind ${label(f)}`} onClose={close}>
                            <form
                              onSubmit={async (e) => {
                                e.preventDefault();
                                if (!settings.data) return;
                                const channelIds = new FormData(e.currentTarget)
                                  .getAll("channels")
                                  .map(String);
                                const selected = [
                                  ...(bindings.data || []).filter(
                                    (b) => b.feature !== f,
                                  ),
                                  { feature: f, channelIds },
                                ];
                                const proposed = settings.data;
                                const plan = await mutate<AccessPlan>(
                                  "access/preview",
                                  { settings: proposed, bindings: selected },
                                );
                                if (plan)
                                  setModal(
                                    <AccessPreview
                                      plan={plan}
                                      disabled={busy}
                                      onClose={close}
                                      onConfirm={async () => {
                                        const saved = await mutate("access", {
                                          settings: proposed,
                                          bindings: selected,
                                          fingerprint: plan.fingerprint,
                                        });
                                        if (saved) close();
                                      }}
                                    />,
                                  );
                              }}
                            >
                              <p>Select the channels this feature can use.</p>
                              <div className="channel-options">
                                {directory.data?.channels
                                  .filter((c) =>
                                    f.includes("voice") ||
                                    f === "post_inspection"
                                      ? c.type === 2
                                      : f === "ticket_category"
                                        ? c.type === 4
                                        : [0, 5].includes(c.type),
                                  )
                                  .map((c) => (
                                    <label className="check" key={c.id}>
                                      <input
                                        type="checkbox"
                                        name="channels"
                                        value={c.id}
                                        defaultChecked={bindings.data
                                          ?.find((b) => b.feature === f)
                                          ?.channelIds.includes(c.id)}
                                      />
                                      {c.type === 2 ? (
                                        <Volume2 size={16} />
                                      ) : (
                                        <MessageSquare size={16} />
                                      )}{" "}
                                      {c.name}
                                    </label>
                                  ))}
                              </div>
                              <div className="form-actions">
                                <button className="primary" disabled={busy}>
                                  Save channel binding
                                </button>
                              </div>
                            </form>
                          </Modal>,
                        )
                      }
                    >
                      Configure
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </Table>
        </Panel>
      </>
    );
  else if (active === "roles")
    content = settings.data ? (
      <>
        <Panel
          title="Discord Roles & Feature Access"
          detail="Use presets for ordinary setup. Review changes before applying them."
        >
          {directory.error && (
            <div className="notice warning">{directory.error.message}</div>
          )}
          <RolesAccess
            settings={settings.data}
            bindings={bindings.data || []}
            directory={directory.data}
            disabled={!canEdit || busy}
            mutate={mutate}
          />
          <ChannelVisibility
            settings={settings.data}
            bindings={bindings.data || []}
            directory={directory.data}
            disabled={!canEdit || busy}
            mutate={mutate}
          />
          {ops.data
            ?.filter((o) => o.action === "sync_permissions")
            .slice(0, 3)
            .map((o) => (
              <div className="notice" key={o.id}>
                <Status value={o.status} />
                <span>
                  {o.error ||
                    (o.status === "COMPLETED"
                      ? "Discord permissions synchronized."
                      : "Permission sync is waiting for the bot. Changes are already saved.")}
                </span>
              </div>
            ))}
        </Panel>
        <details>
          <summary className="form-padding">Advanced Permissions</summary>
          <label className="check form-padding">
            <input
              type="checkbox"
              checked={settings.data.advancedPermissionsEnabled}
              disabled={!canEdit || busy}
              onChange={(e) =>
                void updateSetting({
                  advancedPermissionsEnabled: e.target.checked,
                })
              }
            />{" "}
            Enable extra action role restrictions (verification always stays
            public)
          </label>
          <Panel
            title="Moderator roles"
            detail="Optional server moderation role binding."
          >
            <Field name="Moderator Roles">
              <select
                multiple
                name="moderatorRoles"
                disabled={!canEdit || busy || !directory.data}
                value={settings.data.moderatorRoles}
                onChange={(e) =>
                  void updateSetting({
                    moderatorRoles: [...e.target.selectedOptions]
                      .map((o) => o.value)
                      .filter(Boolean),
                  })
                }
              >
                <option value="">Not configured</option>
                {directory.data?.roles
                  .filter((r) => r.name !== "@everyone")
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </select>
            </Field>
          </Panel>
          <Panel
            title="Feature permission matrix"
            detail="Extra role restrictions are optional. Verification always accepts every guild member. Presets control channel access; action authorization still applies."
          >
            <Table
              head={["Action", "Required group", "Additional allowed roles"]}
            >
              {actions
                .filter((a) => !["next", "help"].includes(a))
                .map((a) => (
                  <tr key={a}>
                    <td>{label(a)}</td>
                    <td>
                      <Badge>
                        {a.startsWith("support_") && a !== "support_open"
                          ? "Support staff"
                          : [
                                "start",
                                "stop",
                                "CALL_NEXT_STUDENT",
                                "complete",
                                "my_queue",
                                "session_settings",
                                "retry",
                                "return",
                                "note",
                                "no_show",
                              ].includes(a)
                            ? "TA"
                            : a === "refresh" || a === "verify"
                              ? "Any member"
                              : "Student"}
                      </Badge>
                    </td>
                    <td>
                      <select
                        multiple
                        aria-label={`Additional roles for ${a}`}
                        disabled={!canEdit || !directory.data || a === "verify"}
                        value={settings.data!.featurePermissions[a] || []}
                        onChange={(e) =>
                          void updateSetting({
                            featurePermissions: {
                              ...settings.data!.featurePermissions,
                              [a]: [...e.target.selectedOptions].map(
                                (o) => o.value,
                              ),
                            },
                          })
                        }
                      >
                        {directory.data?.roles
                          .filter((r) => r.name !== "@everyone")
                          .map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                      </select>
                    </td>
                  </tr>
                ))}
            </Table>
          </Panel>
        </details>
      </>
    ) : null;
  else if (active === "embeds")
    content = (
      <EmbedEditor
        templates={templates.data || []}
        directory={directory.data}
        canEdit={canEdit}
        busy={busy}
        mutate={mutate}
      />
    );
  else if (active === "support")
    content = (
      <>
        <Panel
          title="Support tickets"
          detail="Private channels, support staff claims, and audited closure."
        >
          <div className="table-toolbar">
            <SearchBox value={search} onChange={setSearch} />
          </div>
          {supports.data?.length ? (
            <Table
              head={[
                "Ticket",
                "Subject",
                "Creator",
                "Assigned staff",
                "Status",
                ...(canOperate ? ["Actions"] : []),
              ]}
            >
              {supports.data
                .filter((t) =>
                  `${t.subject} ${t.description} ${t.category} ${t.creatorId} ${t.closedBy || ""} ${t.status}`
                    .toLowerCase()
                    .includes(search.toLowerCase()),
                )
                .map((t) => (
                  <tr key={t.id}>
                    <td>{t.id.slice(-8)}</td>
                    <td>
                      <strong className="support-subject">{t.subject}</strong>
                      <small className="subtext">{t.category}</small>
                    </td>
                    <td>{t.creatorId}</td>
                    <td>{t.assignedId || "Unassigned"}</td>
                    <td>
                      <Status value={t.status} />
                      {t.cleanupError && (
                        <small className="subtext">
                          {t.cleanupError} · {t.cleanupAttempts}/5 attempts
                        </small>
                      )}
                      {t.channelDeletedAt && (
                        <small className="subtext">
                          Discord channel deleted
                        </small>
                      )}
                    </td>
                    {canOperate && (
                      <td>
                        <div className="row-actions">
                          <button
                            onClick={() =>
                              setModal(
                                <Modal
                                  title="Support ticket details"
                                  onClose={close}
                                >
                                  <p className="support-subject">
                                    <strong>{t.subject}</strong>
                                  </p>
                                  <p>{t.description}</p>
                                  <p>{t.additional}</p>
                                  {t.closedBy && (
                                    <p>
                                      Closed by: {t.closedBy} ·{" "}
                                      {t.closureReason || "No reason provided"}
                                    </p>
                                  )}
                                  {t.transcript && (
                                    <details>
                                      <summary>Saved transcript</summary>
                                      <pre>
                                        {JSON.stringify(t.transcript, null, 2)}
                                      </pre>
                                    </details>
                                  )}
                                  <p>
                                    Channel: {t.channelId || "Creation pending"}
                                  </p>
                                  <ActivityList
                                    events={t.events.map((e) => ({
                                      id: e.id,
                                      type: e.action,
                                      message: e.note || e.action,
                                      createdAt: e.createdAt,
                                      severity: "info",
                                    }))}
                                  />
                                  <form
                                    onSubmit={async (e) => {
                                      e.preventDefault();
                                      const fd = new FormData(e.currentTarget);
                                      const action = fd.get("action") as string;
                                      if (
                                        action === "close" &&
                                        !window.confirm(
                                          "Close ticket, save its history and delete the Discord channel?",
                                        )
                                      )
                                        return;
                                      const v = await mutate(
                                        `support/${t.id}`,
                                        {
                                          action,
                                          note: fd.get("note"),
                                          ...(fd.get("assignedId")
                                            ? {
                                                assignedId:
                                                  fd.get("assignedId"),
                                              }
                                            : {}),
                                        },
                                      );
                                      if (v) close();
                                    }}
                                  >
                                    <Field name="Action">
                                      <select name="action">
                                        {[
                                          "claim",
                                          "reply",
                                          "close",
                                          "reopen",
                                          "escalate",
                                          "assign",
                                          "retry_cleanup",
                                        ].map((a) => (
                                          <option key={a} value={a}>
                                            {label(a)}
                                          </option>
                                        ))}
                                      </select>
                                    </Field>
                                    <Field name="Staff Discord ID (for assignment)">
                                      <input
                                        name="assignedId"
                                        pattern="[0-9]{17,20}"
                                      />
                                    </Field>
                                    <Field name="Update note">
                                      <textarea name="note" maxLength={2000} />
                                    </Field>
                                    <div className="form-actions">
                                      <button
                                        className="primary"
                                        disabled={busy}
                                      >
                                        Update ticket
                                      </button>
                                    </div>
                                  </form>
                                </Modal>,
                              )
                            }
                          >
                            Manage
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
            </Table>
          ) : (
            <Empty title="No support tickets">
              Students open private tickets from the configured Discord support
              panel.
            </Empty>
          )}
        </Panel>
        {settings.data && (
          <SettingsForm
            title="Support configuration"
            settings={settings.data}
            disabled={!canEdit || busy}
            onSave={(value) => void mutate("settings", value)}
            fields={[
              "supportCategories",
              "maxOpenSupport",
              "retainTranscripts",
              "transcriptRetentionDays",
            ]}
          />
        )}
      </>
    );
  else if (active === "analytics")
    content = (
      <>
        <div className="table-toolbar">
          <div className="row-actions">
            <Field name="From">
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
              />
            </Field>
            <Field name="Through">
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
              />
            </Field>
          </div>
          <a
            className="button"
            href={`/api/analytics/export?from=${dateFrom}&to=${dateTo}`}
          >
            <Download size={16} /> Export rankings
          </a>
        </div>
        <div className="inline-summary">
          <span>
            <strong>{analytics.data?.totalTickets ?? 0}</strong> tickets
          </span>
          <span>
            <strong>{analytics.data?.completed ?? 0}</strong> completed
            inspections
          </span>
          <span>
            <strong>
              {analytics.data?.averageWaitSeconds === null
                ? "—"
                : Math.round((analytics.data?.averageWaitSeconds || 0) / 60)}
            </strong>{" "}
            average wait minutes
          </span>
        </div>
        <Panel
          title="TA rankings"
          detail="Credit comes from completed inspections, including assistance."
        >
          {analytics.data?.taRanking.length ? (
            <Table
              head={[
                "Rank",
                "TA",
                "Completed",
                "No Shows",
                "Unique students",
                "Average inspection",
                "Assistance",
              ]}
            >
              {analytics.data.taRanking.map((t, i) => (
                <tr key={t.taId}>
                  <td>{t.completed ? i + 1 : "—"}</td>
                  <td>{t.name}</td>
                  <td>{t.completed}</td>
                  <td>{t.noShows}</td>
                  <td>{t.students}</td>
                  <td>{Math.round(t.averageSeconds / 60)} min</td>
                  <td>{t.assisted}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <Empty title="No completed inspections in this period">
              Rankings appear after TAs complete verified inspections.
            </Empty>
          )}
        </Panel>
        <div className="overview-grid">
          <Panel title="Coursework distribution" detail="Tickets by assignment">
            {analytics.data?.courses.length ? (
              <div className="chart">
                <CourseworkChart data={analytics.data.courses} />
              </div>
            ) : (
              <Empty title="No coursework activity" />
            )}
          </Panel>
          <Panel
            title="Student rankings"
            detail="Admin-only records. Raw student IDs are excluded."
          >
            {analytics.data?.studentRanking.length ? (
              <Table
                head={[
                  "Student",
                  "Tickets",
                  "Completed",
                  "Cancelled",
                  "No-shows",
                ]}
              >
                {analytics.data.studentRanking.map((s) => (
                  <tr key={s.id}>
                    <td>{s.name}</td>
                    <td>{s.tickets}</td>
                    <td>{s.completed}</td>
                    <td>{s.cancelled}</td>
                    <td>{s.noShows}</td>
                  </tr>
                ))}
              </Table>
            ) : (
              <Empty title="No student activity" />
            )}
          </Panel>
        </div>
        <InspectionHistory canEdit={canEdit} mutate={mutate} />
      </>
    );
  else if (active === "logs")
    content = (
      <>
        <Panel
          title="Logs & audit"
          detail="Queue transitions, administrator changes, registrations, and service failures."
          action={<SearchBox value={search} onChange={setSearch} />}
        >
          <Table
            head={[
              "Time",
              "Severity",
              "Event",
              "Description",
              "Actor",
              "Correlation ID",
            ]}
          >
            {logs.data
              ?.filter((e) =>
                `${e.type} ${e.message} ${e.severity} ${e.actorId}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              )
              .map((e) => (
                <tr key={e.id}>
                  <td>{new Date(e.createdAt).toLocaleString()}</td>
                  <td>
                    <Badge
                      tone={
                        e.severity === "error"
                          ? "danger"
                          : e.severity === "warn"
                            ? "warning"
                            : "neutral"
                      }
                    >
                      {e.severity}
                    </Badge>
                  </td>
                  <td>{e.type}</td>
                  <td>
                    {e.message}
                    <details>
                      <summary>Event data</summary>
                      <pre>{JSON.stringify(e.data, null, 2)}</pre>
                    </details>
                  </td>
                  <td>{e.actorId}</td>
                  <td className="number">{e.correlationId.slice(0, 8)}</td>
                </tr>
              ))}
          </Table>
          {!logs.data?.length && <Empty title="No events recorded" />}
        </Panel>
        {canEdit && (
          <Panel
            title="Runtime diagnostics"
            detail="Most recent 200 structured records. Stack traces are restricted to administrators."
          >
            {runtimeLog.error && (
              <div className="notice danger">{runtimeLog.error.message}</div>
            )}
            <div className="form-padding">
              {runtimeLog.data
                ?.filter((record) =>
                  JSON.stringify(record)
                    .toLowerCase()
                    .includes(search.toLowerCase()),
                )
                .map((record, index) => (
                  <details key={index}>
                    <summary>
                      {record.time
                        ? new Date(Number(record.time)).toLocaleString()
                        : "Runtime"}{" "}
                      · {String(record.msg || "Diagnostic record")}
                    </summary>
                    <pre>{JSON.stringify(record, null, 2)}</pre>
                  </details>
                ))}
              {!runtimeLog.data?.length && (
                <Empty title="No runtime records yet" />
              )}
            </div>
          </Panel>
        )}
      </>
    );
  else if (active === "operations")
    content = (
      <>
        <Panel
          title="Data Management"
          detail="Back up, preview and confirm historical cleanup."
        >
          <DataManagement
            owner={me.data.role === "OWNER"}
            disabled={busy}
            mutate={mutate}
            read={api}
          />
        </Panel>
        <Panel
          title="Service health"
          detail="Offline processes cannot publish panels or move students."
        >
          <div className="health-grid">
            {[
              {
                name: "Website",
                online: true,
                detail: "Local administration server",
              },
              {
                name: "PostgreSQL",
                online: health.data?.database,
                detail: "Authoritative queue storage",
              },
              {
                name: "Redis",
                online: health.data?.redis,
                detail: "Job delivery and synchronization",
              },
              ...(health.data?.services.map((s) => ({
                name: label(s.service),
                online: s.online && s.status === "online",
                detail: s.detail,
              })) || []),
            ].map((s) => (
              <div key={s.name}>
                <Server size={20} />
                <strong>{s.name}</strong>
                <Status value={s.online ? "online" : "offline"} />
                <small>{s.detail}</small>
              </div>
            ))}
          </div>
        </Panel>
        <Panel
          title="Recovery & service controls"
          detail="Logical reloads preserve process state. Process restarts require the restricted local supervisor."
        >
          <div className="operation-list">
            {operations.map((op) => (
              <div key={op}>
                <div>
                  <strong>{label(op)}</strong>
                  <small>
                    {op.startsWith("restart_") && op !== "restart_sync"
                      ? "Graceful process restart. Requires enabled service supervisor."
                      : op === "backup"
                        ? "Creates a private PostgreSQL backup on the server."
                        : "Runs a recorded, non-destructive maintenance operation."}
                  </small>
                </div>
                <button
                  aria-label={`Run ${label(op)}`}
                  disabled={!canOperate || busy}
                  onClick={() =>
                    void confirm(
                      "operations",
                      { action: op },
                      `Run ${label(op)}? Active tickets and history are preserved.`,
                    )
                  }
                >
                  Run <ArrowUpRight size={14} />
                </button>
              </div>
            ))}
          </div>
        </Panel>
        <Panel
          title="Operation history"
          detail="Requests remain recorded until completed or failed."
        >
          {ops.data?.length ? (
            <Table head={["Requested", "Operation", "Status", "Result"]}>
              {ops.data.map((o) => (
                <tr key={o.id}>
                  <td>{new Date(o.createdAt).toLocaleString()}</td>
                  <td>{label(o.action)}</td>
                  <td>
                    <Status value={o.status} />
                  </td>
                  <td>
                    {o.error ||
                      (o.completedAt ? "Completed" : "Awaiting executor")}
                    {o.status === "FAILED" && canOperate && (
                      <button
                        onClick={() => void mutate(`operations/${o.id}/retry`)}
                      >
                        Retry operation
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          ) : (
            <Empty title="No operations requested" />
          )}
        </Panel>
      </>
    );
  else
    content = (
      <>
        {settings.data && (
          <SettingsForm
            title="Website & server preferences"
            settings={settings.data}
            disabled={!canEdit || busy}
            onSave={(value) => void mutate("settings", value)}
            fields={["timezone", "nicknameTemplate"]}
          />
        )}
        <Panel title="Interface appearance" detail="Saved in this browser.">
          <div className="setting-row">
            <div>
              <strong>Theme</strong>
              <small>Dark by default. Light theme available.</small>
            </div>
            <button onClick={toggleTheme}>
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />} Switch
              to {theme === "dark" ? "light" : "dark"}
            </button>
          </div>
        </Panel>
        {me.data.role === "OWNER" && (
          <Panel
            title="Administrator accounts"
            detail="Eight-hour sessions. Account changes revoke active sessions."
            action={
              <button className="primary" onClick={() => accountForm()}>
                <Plus size={16} /> Add administrator
              </button>
            }
          >
            <Table head={["Username", "Role", "Status", "Actions"]}>
              {accounts.data?.map((a) => (
                <tr key={a.id}>
                  <td>{a.username}</td>
                  <td>{a.role}</td>
                  <td>
                    <Status value={a.disabled ? "DISABLED" : "online"} />
                  </td>
                  <td>
                    <button onClick={() => accountForm(a)}>Edit account</button>
                  </td>
                </tr>
              ))}
            </Table>
          </Panel>
        )}
        <Panel
          title="Configuration transfer"
          detail="Exports exclude credentials. Imported channel bindings must be validated separately."
        >
          <div className="table-toolbar">
            <a
              className="button"
              href="/api/configuration"
              download="ta-configuration.json"
            >
              <Download size={16} /> Export configuration
            </a>
            {canEdit && (
              <label className="button">
                <Upload size={16} /> Import settings & templates
                <input
                  className="sr-only"
                  type="file"
                  accept=".json,application/json"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    if (file.size > 2 * 1024 * 1024) {
                      notify("Configuration exceeds 2 MB.", true);
                      return;
                    }
                    try {
                      const data = JSON.parse(await file.text());
                      if (
                        window.confirm(
                          "Import settings and add these templates? Existing templates and queue data are preserved.",
                        )
                      )
                        await mutate("configuration", data);
                    } catch {
                      notify("Invalid JSON configuration.", true);
                    }
                    e.target.value = "";
                  }}
                />
              </label>
            )}
          </div>
        </Panel>
      </>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/">
          <span className="brand-mark">
            <GraduationCap size={23} />
          </span>
          <span>
            TA Queue<small>Coursework operations</small>
          </span>
        </a>
        <div className="workspace">
          <span className="workspace-avatar">
            {state?.guild.name?.[0] || "C"}
          </span>
          <div>
            <strong>{state?.guild.name || "Coursework Support"}</strong>
            <small>Administration</small>
          </div>
          <ChevronDown size={14} />
        </div>
        <nav aria-label="Main navigation">
          {navigation.map((n, i) => (
            <a
              key={n.key}
              href={`/?view=${n.key}`}
              className={`${active === n.key ? "active" : ""} ${i === 5 || i === 11 ? "nav-gap" : ""}`}
              aria-current={active === n.key ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                go(n.key);
              }}
            >
              <n.icon size={18} />
              <span>{n.name}</span>
              {n.key === "queue" && !!state?.metrics.waiting && (
                <span className="nav-count">{state.metrics.waiting}</span>
              )}
            </a>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className={`connection ${botOnline ? "connected" : ""}`}>
            <span className="status-dot" />
            {botOnline ? "Discord connected" : "Discord offline"}
          </div>
          <small>Persistent queues. Independent sessions.</small>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <span>/</span>{" "}
            <strong>{navigation.find((n) => n.key === active)?.name}</strong>
          </div>
          <div className="topbar-right">
            <Badge tone="neutral">
              <Monitor size={12} /> Local instance
            </Badge>
            <button
              className="icon-button"
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
              onClick={toggleTheme}
            >
              {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <span className="top-divider" />
            <span className="account-avatar">
              {me.data.username[0].toUpperCase()}
            </span>
            <span className="account-name">
              {me.data.username}
              <small>{label(me.data.role)}</small>
            </span>
            <button
              className="icon-button"
              aria-label="Sign out"
              onClick={async () => {
                await mutate("logout");
                client.clear();
                location.reload();
              }}
            >
              <LogOut size={16} />
            </button>
          </div>
        </header>
        <div className="mobile-nav">
          <label className="sr-only" htmlFor="mobile-page">
            Page
          </label>
          <select
            id="mobile-page"
            value={active}
            onChange={(e) => go(e.target.value)}
          >
            {navigation.map((n) => (
              <option key={n.key} value={n.key}>
                {n.name}
              </option>
            ))}
          </select>
        </div>
        <main id="main-content">
          <div className="page-heading">
            <div>
              <h1>
                {active === "overview"
                  ? "Workspace overview"
                  : navigation.find((n) => n.key === active)?.name}
              </h1>
              <p>
                {active === "overview"
                  ? "Your coursework sessions, all in one place."
                  : (
                      {
                        queue:
                          "Follow every ticket from admission to inspection.",
                        tas: "Keep each TA’s capacity, room, and backlog in view.",
                        students:
                          "Manage your roster and verified Discord identities.",
                        coursework:
                          "Organize the assignments your TAs inspect.",
                        embeds:
                          "Build Discord panels that work for your server.",
                        operations:
                          "Keep services healthy and recover interrupted work.",
                      } as Record<string, string>
                    )[active] ||
                    "Configure and manage your coursework platform."}
              </p>
            </div>
            <div className="page-heading-actions">
              <span className="freshness">
                <span
                  className={`status-dot ${overview.isError ? "error" : ""}`}
                />
                {overview.isError
                  ? "Update failed"
                  : overview.isFetching
                    ? "Updating…"
                    : overview.dataUpdatedAt
                      ? `Updated ${relative(new Date(overview.dataUpdatedAt))}`
                      : "Loading…"}
              </span>
              <button
                disabled={busy || overview.isFetching}
                onClick={() => void client.invalidateQueries()}
              >
                <RefreshCw size={15} /> Refresh
              </button>
            </div>
          </div>
          {allErrors.length > 0 && (
            <div className="notice danger" role="alert">
              {[...new Set(allErrors)].join(" ")}
            </div>
          )}
          {content}
          {active === "tas" && <SessionHistory />}
          <footer className="page-footer">
            <span>TA Queue · Coursework support</span>
            <span>Queue data stored in PostgreSQL</span>
          </footer>
        </main>
      </div>
      {message && (
        <div
          className={`toast ${message.error ? "toast-error" : ""}`}
          role={message.error ? "alert" : "status"}
        >
          {message.error ? (
            <AlertTriangle size={19} />
          ) : (
            <CheckCircle2 size={19} />
          )}
          <span>{message.text}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setMessage(null)}
          >
            <X size={16} />
          </button>
        </div>
      )}
      <BusyContext.Provider value={busy}>{modal}</BusyContext.Provider>
    </div>
  );
}
function Login({
  onSuccess,
  toggleTheme,
}: {
  onSuccess: () => void;
  toggleTheme: () => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main className="login-page">
      <button
        className="icon-button login-theme"
        onClick={toggleTheme}
        aria-label="Toggle theme"
      >
        <Sun size={20} />
      </button>
      <div className="login-brand">
        <span className="brand-mark">
          <GraduationCap size={26} />
        </span>
        TA Queue
      </div>
      <section className="login-panel">
        <h1>Welcome back</h1>
        <p>Sign in to manage your coursework queues.</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            const fd = new FormData(e.currentTarget);
            try {
              await api("login", {
                method: "POST",
                body: JSON.stringify({
                  username: fd.get("username"),
                  password: fd.get("password"),
                }),
              });
              onSuccess();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Sign-in failed.");
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field name="Username">
            <input
              name="username"
              required
              autoComplete="username"
              autoFocus
              maxLength={64}
            />
          </Field>
          <Field name="Password">
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
              maxLength={256}
            />
          </Field>
          {error && (
            <div className="notice danger" role="alert">
              {error}
            </div>
          )}
          <button className="primary login-submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
            <ArrowUpRight size={17} />
          </button>
        </form>
        <div className="login-note">
          <Shield size={16} /> Local administrator access
        </div>
      </section>
      <p className="login-help">
        First run? Create an owner account using the secure bootstrap script.
      </p>
    </main>
  );
}
function SearchBox({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="search">
      <Search size={16} />
      <input
        aria-label="Search records"
        placeholder="Search records…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
function ActivityList({
  events,
}: {
  events: {
    id: number | string;
    type: string;
    message: string;
    createdAt: string | Date;
    severity: string;
  }[];
}) {
  return events.length ? (
    <div className="activity-list">
      {events.map((e) => (
        <div key={e.id}>
          <span
            className={`activity-dot ${e.severity === "error" ? "error" : ""}`}
          />
          <div>
            <strong>{e.message}</strong>
            <small>{e.type}</small>
          </div>
          <time dateTime={new Date(e.createdAt).toISOString()}>
            {relative(e.createdAt)}
          </time>
        </div>
      ))}
    </div>
  ) : (
    <Empty title="No activity yet">
      Events appear here after platform actions.
    </Empty>
  );
}
const fieldNames: Record<string, string> = {
  defaultCapacity: "Default waiting capacity",
  minCapacity: "Minimum waiting capacity",
  maxCapacity: "Maximum waiting capacity",
  inspectionConcurrency: "Concurrent inspections per TA",
  maintenance: "Pause new queue admission",
  requireIdentity: "Require verified student identity",
  allowCancellation: "Allow student cancellation",
  maxMoveAttempts: "Maximum transfer attempts",
  claimLeaseSeconds: "Transfer claim lease (seconds)",
  noShowTimeoutSeconds: "Disconnected waiting no-show timeout (0 = disabled)",
  staleWarningSeconds: "Stale transfer warning (seconds)",
  autoMute: "Server mute students in waiting rooms",
  muteCleanup: "Remove verified bot-owned mutes",
  noShowDMEnabled: "Send a private No Show notification to the student",
  alertGraceSeconds: "Abandoned queue grace period (seconds)",
  alertCooldownSeconds: "Alert cooldown (seconds)",
  alertText: "Abandoned queue notification",
  notifications: "Operational voice warnings",
  routineAnnouncements:
    "Routine call and arrival announcements (off by default)",
  publicStudentIds: "Public student IDs: HIDDEN, MASKED or FULL",
  queueShowCoursework: "Show coursework in waiting lists",
  calledText: "Student called message",
  movedText: "Successful transfer message",
  failedText: "Failed transfer message",
  publicStudentNames: "Show student names in public queue panels",
  publicStudentRanking: "Enable public student rankings",
  verificationMode: "Student verification method",
  embedAutoRefreshEnabled: "Periodic Discord panel reconciliation",
  embedRefreshIntervalSeconds: "Panel reconciliation interval (seconds)",
  embedUpdateDebounceMs: "Panel update debounce (milliseconds)",
  supportCategories: "Support issue categories",
  maxOpenSupport: "Open support tickets per student",
  retainTranscripts: "Retain support transcripts (last 100 messages)",
  transcriptRetentionDays: "Transcript retention (days)",
  nicknameTemplate: "Student nickname template",
  language: "Interface language preference",
  timezone: "Reporting timezone",
};
function SettingsForm({
  settings,
  fields,
  title,
  disabled,
  onSave,
}: {
  settings: GuildSettings;
  fields: (keyof GuildSettings)[];
  title: string;
  disabled: boolean;
  onSave: (value: GuildSettings) => void;
}) {
  return (
    <Panel
      title={title}
      detail="Validated settings apply without a service restart."
    >
      <form
        key={JSON.stringify(fields.map((f) => settings[f]))}
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          const copy = { ...settings };
          for (const key of fields) {
            const old = settings[key];
            const value =
              typeof old === "boolean"
                ? fd.has(key)
                : typeof old === "number"
                  ? Number(fd.get(key))
                  : Array.isArray(old)
                    ? (fd.get(key)?.toString() || "")
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean)
                    : fd.get(key)?.toString() || "";
            Object.assign(copy, { [key]: value });
          }
          onSave(copy);
        }}
      >
        <div className="settings-fields">
          {fields.map((key) => (
            <div className="setting-row" key={key}>
              <div>
                <label htmlFor={`setting-${key}`}>
                  {fieldNames[key] || label(key)}
                </label>
                {key === "nicknameTemplate" && (
                  <small>
                    Use {"{name}"}, {"{lastname}"}, {"{id}"}. Discord nicknames
                    are limited to 32 characters.
                  </small>
                )}
                {key === "maintenance" && (
                  <small>Existing tickets and inspections are preserved.</small>
                )}
                {key === "autoMute" && (
                  <small>
                    Needs Mute Members and View Audit Log. Ambiguous mute
                    ownership requires moderator review.
                  </small>
                )}
              </div>
              {typeof settings[key] === "boolean" ? (
                <input
                  id={`setting-${key}`}
                  name={key}
                  type="checkbox"
                  defaultChecked={settings[key] as boolean}
                  disabled={disabled}
                />
              ) : key === "publicStudentIds" ? (
                <select
                  id={`setting-${key}`}
                  name={key}
                  defaultValue={settings.publicStudentIds}
                  disabled={disabled}
                >
                  <option value="HIDDEN">Hidden</option>
                  <option value="MASKED">Masked (last four digits)</option>
                  <option value="FULL">Full student ID</option>
                </select>
              ) : key === "verificationMode" ? (
                <select
                  id={`setting-${key}`}
                  name={key}
                  defaultValue={settings.verificationMode}
                  disabled={disabled}
                >
                  <option value="STUDENT_ID">Student ID</option>
                  <option value="ADMIN_APPROVAL">
                    Student ID + administrator approval
                  </option>
                </select>
              ) : key.toLowerCase().includes("text") ? (
                <textarea
                  id={`setting-${key}`}
                  name={key}
                  defaultValue={String(settings[key])}
                  disabled={disabled}
                />
              ) : (
                <input
                  id={`setting-${key}`}
                  name={key}
                  type={typeof settings[key] === "number" ? "number" : "text"}
                  defaultValue={
                    Array.isArray(settings[key])
                      ? (settings[key] as string[]).join(", ")
                      : String(settings[key])
                  }
                  disabled={disabled}
                  required
                />
              )}
            </div>
          ))}
        </div>
        <div className="form-actions form-padding">
          <button className="primary" disabled={disabled}>
            Save changes
          </button>
        </div>
      </form>
    </Panel>
  );
}
function EmbedEditor({
  templates,
  directory,
  canEdit,
  busy,
  mutate,
}: {
  templates: PanelTemplate[];
  directory?: Directory;
  canEdit: boolean;
  busy: boolean;
  mutate: <T>(
    path: string,
    data?: unknown,
    method?: string,
  ) => Promise<T | undefined>;
}) {
  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState<Template | null>(null);
  const [channel, setChannel] = useState("");
  const [error, setError] = useState("");
  const current = templates.find((t) => t.id === selected) || templates[0];
  const document = normalizeActions(draft || current?.document) as Template;
  const edit = (patch: Partial<Template>) =>
    setDraft({ ...document, ...patch });
  if (!current || !document)
    return (
      <Empty title="No panel templates">
        Run the database seed to install the default Discord panels.
      </Empty>
    );
  const values: Record<string, string> = {
    "queue.total": "0",
    "queue.waiting": "0",
    "queue.available": "0",
    "queue.capacity": "0",
    "queue.draining": "0",
    "queue.active_tas": "0",
    "queue.in_progress": "0",
    "queue.top": th.noWaiting,
    "queue.overview":
      "🎟️ คิวว่าง: 0\n👥 นักศึกษารอคิว: 0\n🎓 ผู้ช่วยสอนที่เปิดรับคิว: 0",
    "room.current": "ยังไม่มีนักศึกษากำลังตรวจงาน",
    "room.current.student_id": "ไม่พบรหัสนักศึกษา",
    "room.current.student_name": "นักศึกษา",
    "room.current.coursework": "—",
    "room.current.ticket": "—",
    "room.current.ta": "—",
    "room.current.status": "—",
    "room.status": "ยังไม่มีผู้ช่วยสอนในห้องตรวจงาน",
    "queue.available_tas": "0",
    "queue.current": "ยังไม่มีนักศึกษากำลังตรวจงาน",
    "queue.warnings": "",
    "waiting.unqueued_count": "0",
    "waiting.status": "รอผู้ช่วยสอนเปิดรับคิว",
    "waiting.incident": "ตัวอย่าง",
    "ta.table": th.noSessions,
    "ranking.ta": th.noCompleted,
  };
  if (document.roomLayout) {
    if (!document.roomLayout.overview) values["queue.overview"] = "";
    if (!document.roomLayout.waiting) values["queue.top"] = "";
    if (!document.roomLayout.current)
      for (const key of Object.keys(values))
        if (key === "room.current" || key.startsWith("room.current."))
          values[key] = "";
  }
  const replace = (text: string) =>
    text.replace(/\{([^{}]+)\}/g, (_, p) => values[p] ?? `{${p}}`);
  return (
    <>
      <div className="editor-toolbar">
        <Field name="Panel template">
          <select
            value={current.id}
            onChange={(e) => {
              if (
                draft &&
                !window.confirm("Discard unsaved changes to this template?")
              )
                return;
              setSelected(e.target.value);
              setDraft(null);
              setError("");
            }}
          >
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} · v{t.version}
              </option>
            ))}
          </select>
        </Field>
        <div className="row-actions">
          <button
            disabled={!canEdit || busy}
            onClick={async () => {
              await mutate(`templates/${current.id}/duplicate`, {});
            }}
          >
            Duplicate
          </button>
          <button
            disabled={!canEdit || busy}
            onClick={async () => {
              if (
                window.confirm(
                  "Apply the Thai default to this template? The current version remains in history. Republish the panel to update Discord.",
                )
              ) {
                const saved = await mutate(`templates/${current.id}/reset`, {});
                if (saved) setDraft(null);
              }
            }}
          >
            Apply Thai default
          </button>
          <button
            className="primary"
            disabled={!canEdit || busy}
            onClick={async () => {
              const saved = await mutate(`templates/${current.id}`, {
                name: current.name,
                feature: current.feature,
                document,
              });
              if (saved) setDraft(null);
            }}
          >
            Save draft
          </button>
        </div>
      </div>
      <div className="embed-grid">
        <Panel
          title="Message properties"
          detail="Only registered, permission-checked actions can be used."
        >
          <div className="form-padding">
            <Field name="Rendering mode">
              <select
                value={document.mode}
                disabled={!canEdit}
                onChange={(e) =>
                  edit({ mode: e.target.value as Template["mode"] })
                }
              >
                <option value="EMBED">Traditional embed</option>
                <option value="V2">Components V2</option>
              </select>
            </Field>
            <Field name="Title">
              <input
                value={document.title}
                maxLength={256}
                disabled={!canEdit}
                onChange={(e) => edit({ title: e.target.value })}
              />
            </Field>
            <Field name="Description">
              <textarea
                rows={6}
                value={document.description}
                maxLength={4000}
                disabled={!canEdit}
                onChange={(e) => edit({ description: e.target.value })}
              />
            </Field>
            <div className="form-grid">
              <Field name="Accent color">
                <ColorPicker
                  key={current.id}
                  value={document.color}
                  defaultColor={defaults[current.feature].color}
                  disabled={!canEdit || busy}
                  onChange={(color) => edit({ color })}
                />
              </Field>
              <Field name="Author">
                <input
                  value={document.author}
                  disabled={!canEdit || document.mode === "V2"}
                  onChange={(e) => edit({ author: e.target.value })}
                />
              </Field>
            </div>
            <Field name="Footer">
              <input
                value={document.footer}
                maxLength={2048}
                disabled={!canEdit}
                onChange={(e) => edit({ footer: e.target.value })}
              />
            </Field>
            <Field name="Thumbnail URL">
              <input
                type="url"
                value={document.thumbnail}
                disabled={!canEdit}
                placeholder="https://…"
                onChange={(e) => edit({ thumbnail: e.target.value })}
              />
            </Field>
            <Field name="Image URL">
              <input
                type="url"
                value={document.image}
                disabled={!canEdit}
                placeholder="https://…"
                onChange={(e) => edit({ image: e.target.value })}
              />
            </Field>
            <details>
              <summary>Dynamic placeholders</summary>
              <p className="muted">
                Use room.current.student_id, student_name, coursework, ticket,
                ta and status to customize the current inspection. Full Student
                IDs require TA-only access or an acknowledged Full Inspection
                Details policy for the individual room panel. Public-safe panels
                hide IDs or use the configured mask. Missing verified mappings
                show “ไม่พบรหัสนักศึกษา”; check Students → Discord identity
                mapping.
              </p>
              <div className="placeholder-list">
                {placeholders.map((p) => (
                  <code key={p}>{`{${p}}`}</code>
                ))}
              </div>
            </details>
            <h3>Fields</h3>
            {document.fields.map((f, i) => (
              <div className="editor-field" key={i}>
                <Field name={`Field ${i + 1} name`}>
                  <input
                    value={f.name}
                    disabled={!canEdit}
                    onChange={(e) =>
                      edit({
                        fields: document.fields.map((x, n) =>
                          n === i ? { ...x, name: e.target.value } : x,
                        ),
                      })
                    }
                  />
                </Field>
                <Field name="Value">
                  <textarea
                    value={f.value}
                    disabled={!canEdit}
                    onChange={(e) =>
                      edit({
                        fields: document.fields.map((x, n) =>
                          n === i ? { ...x, value: e.target.value } : x,
                        ),
                      })
                    }
                  />
                </Field>
                <div className="row-actions">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={f.inline}
                      disabled={!canEdit}
                      onChange={(e) =>
                        edit({
                          fields: document.fields.map((x, n) =>
                            n === i ? { ...x, inline: e.target.checked } : x,
                          ),
                        })
                      }
                    />{" "}
                    Inline
                  </label>
                  <button
                    disabled={!canEdit || i === 0}
                    onClick={() => {
                      const fields = [...document.fields];
                      [fields[i - 1], fields[i]] = [fields[i], fields[i - 1]];
                      edit({ fields });
                    }}
                  >
                    Move up
                  </button>
                  <button
                    disabled={!canEdit}
                    onClick={() =>
                      edit({
                        fields: document.fields.filter((_, n) => n !== i),
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
            <button
              disabled={!canEdit || document.fields.length >= 25}
              onClick={() =>
                edit({
                  fields: [
                    ...document.fields,
                    {
                      name: "Field title",
                      value: "Field value",
                      inline: false,
                    },
                  ],
                })
              }
            >
              <Plus size={15} /> Add field
            </button>
            <h3>Buttons & controls</h3>
            {current.feature === "ta_room_queue_panel" && (
              <button
                disabled={!canEdit || busy}
                className="secondary"
                onClick={() =>
                  edit({ buttons: defaults.ta_room_queue_panel.buttons })
                }
              >
                Restore default room controls
              </button>
            )}
            {document.buttons.map((b, i) => (
              <div className="editor-field" key={i}>
                <Field name="Label">
                  <input
                    value={b.label}
                    maxLength={80}
                    disabled={!canEdit}
                    onChange={(e) =>
                      edit({
                        buttons: document.buttons.map((x, n) =>
                          n === i ? { ...x, label: e.target.value } : x,
                        ),
                      })
                    }
                  />
                </Field>
                <div className="form-grid">
                  <Field name="Action">
                    <select
                      value={b.action}
                      disabled={!canEdit}
                      onChange={(e) =>
                        edit({
                          buttons: document.buttons.map((x, n) =>
                            n === i
                              ? {
                                  ...x,
                                  action: e.target.value as typeof b.action,
                                }
                              : x,
                          ),
                        })
                      }
                    >
                      {panelActions(current.feature).map((x) => (
                        <option key={x.action} value={x.action}>
                          {label(x.action)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field name="Style">
                    <select
                      value={b.style}
                      disabled={!canEdit}
                      onChange={(e) =>
                        edit({
                          buttons: document.buttons.map((x, n) =>
                            n === i
                              ? {
                                  ...x,
                                  style: e.target.value as typeof b.style,
                                }
                              : x,
                          ),
                        })
                      }
                    >
                      {["Primary", "Secondary", "Success", "Danger"].map(
                        (s) => (
                          <option key={s}>{s}</option>
                        ),
                      )}
                    </select>
                  </Field>
                </div>
                <Field name="Emoji (optional)">
                  <input
                    value={b.emoji}
                    disabled={!canEdit}
                    onChange={(e) =>
                      edit({
                        buttons: document.buttons.map((x, n) =>
                          n === i ? { ...x, emoji: e.target.value } : x,
                        ),
                      })
                    }
                  />
                </Field>
                <div className="row-actions">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={b.visible}
                      disabled={!canEdit}
                      onChange={(e) =>
                        edit({
                          buttons: document.buttons.map((x, n) =>
                            n === i ? { ...x, visible: e.target.checked } : x,
                          ),
                        })
                      }
                    />{" "}
                    Visible
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={b.disabled}
                      disabled={!canEdit}
                      onChange={(e) =>
                        edit({
                          buttons: document.buttons.map((x, n) =>
                            n === i ? { ...x, disabled: e.target.checked } : x,
                          ),
                        })
                      }
                    />{" "}
                    Disabled
                  </label>
                  <button
                    disabled={!canEdit || i === 0}
                    onClick={() => {
                      const buttons = [...document.buttons];
                      [buttons[i - 1], buttons[i]] = [
                        buttons[i],
                        buttons[i - 1],
                      ];
                      edit({ buttons });
                    }}
                  >
                    Move up
                  </button>
                  <button
                    disabled={!canEdit}
                    onClick={() =>
                      edit({
                        buttons: document.buttons.filter((_, n) => n !== i),
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
            {panelActions(current.feature).length > 0 && (
              <button
                disabled={!canEdit || document.buttons.length >= 20}
                onClick={() =>
                  edit({
                    buttons: [
                      ...document.buttons,
                      panelActions(current.feature)[0],
                    ],
                  })
                }
              >
                <Plus size={15} /> Add button
              </button>
            )}
            {current.feature === "student_queue" && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={document.courseworkSelect}
                  disabled={!canEdit}
                  onChange={(e) => edit({ courseworkSelect: e.target.checked })}
                />{" "}
                Show coursework dropdown
              </label>
            )}
          </div>
        </Panel>
        <div className="preview-column">
          <Panel
            title="Discord preview"
            detail="Zero counts are preview values. Published panels use live data."
          >
            <div className="discord-preview">
              <div className="discord-author">
                <span className="bot-avatar">
                  <GraduationCap size={21} />
                </span>
                <strong>TA Queue</strong>
                <span className="bot-label">APP</span>
              </div>
              <div
                className={`discord-message ${document.mode === "V2" ? "v2" : ""}`}
                style={{ borderColor: document.color }}
              >
                {document.author && document.mode !== "V2" && (
                  <small>{document.author}</small>
                )}
                <h3>{replace(document.title)}</h3>
                <div className="discord-description">
                  {replace(document.description)}
                </div>
                {document.thumbnail && (
                  <img
                    className="discord-thumbnail"
                    src={document.thumbnail}
                    alt="Embed thumbnail"
                  />
                )}
                <div className="discord-fields">
                  {document.fields
                    .filter((f) => replace(f.value).trim())
                    .map((f, i) => (
                      <div key={i} className={f.inline ? "inline" : ""}>
                        <strong>{replace(f.name)}</strong>
                        <p>{replace(f.value)}</p>
                      </div>
                    ))}
                </div>
                {document.image && (
                  <img
                    className="discord-image"
                    src={document.image}
                    alt="Embed image"
                  />
                )}
                <small>
                  {replace(
                    current.feature === "waiting_room_alert" &&
                      !document.footer.includes("{waiting.incident}")
                      ? `${document.footer} · อ้างอิง {waiting.incident}`
                      : document.footer,
                  )}
                </small>
              </div>
              {document.courseworkSelect && (
                <div className="discord-select">
                  {th.selectCoursework} <ChevronDown size={16} />
                </div>
              )}
              <div className="discord-buttons">
                {document.buttons
                  .filter((b) => b.visible)
                  .map((b, i) => (
                    <span
                      key={i}
                      className={`discord-button ${b.style.toLowerCase()} ${b.disabled ? "disabled" : ""}`}
                    >
                      {b.emoji} {b.label}
                    </span>
                  ))}
              </div>
            </div>
          </Panel>
          {current.feature === "no_show_dm" ? (
            <Panel
              title="No Show DM"
              detail="Sent privately after a confirmed No Show. Save draft to apply; no panel publication is needed."
            >
              <p className="form-padding muted">
                Only the affected student receives this message. Enable or
                disable delivery in Queue Configuration → No Show notifications.
              </p>
            </Panel>
          ) : current.feature === "waiting_room_alert" ? (
            <Panel
              title="Waiting Room Alert"
              detail="Save draft to apply to future alerts. Configure channels, roles, grace period and triggers in Queue Configuration → Waiting Room Alerts."
            >
              <p className="form-padding muted">
                Alerts update their saved incident message automatically. No
                panel publication is needed. Test delivery from Queue
                Configuration.
              </p>
            </Panel>
          ) : current.feature === "arrival" ? (
            <Panel
              title="Arrival notification"
              detail="Sent after verified transfer, preferably in the actual TA voice-room chat. Save draft to apply."
            >
              <div className="form-padding form-grid">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={document.notificationEnabled ?? true}
                    disabled={!canEdit || busy}
                    onChange={(e) =>
                      edit({ notificationEnabled: e.target.checked })
                    }
                  />
                  Enable arrival notifications
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={document.includeStudentId ?? false}
                    disabled={!canEdit || busy}
                    onChange={(e) =>
                      edit({ includeStudentId: e.target.checked })
                    }
                  />
                  Allow student ID placeholder in this notification
                </label>
                <Field name="Arrival fallback text channel">
                  <select
                    value={document.fallbackChannelId || ""}
                    disabled={!canEdit || busy || !directory}
                    onChange={(e) =>
                      edit({ fallbackChannelId: e.target.value })
                    }
                  >
                    <option value="">No fallback</option>
                    {directory?.channels
                      .filter((c) => [0, 5].includes(c.type))
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          #{c.name}
                        </option>
                      ))}
                  </select>
                </Field>
                <p className="muted">
                  Keep student IDs private unless this destination is
                  authorized. Coursework must remain in the template. Mentions
                  never ping.
                </p>
              </div>
            </Panel>
          ) : current.feature === "ta_room_queue_panel" ? (
            <Panel
              title="Room panel publishing"
              detail="Save this template, then select a room mapping in Discord Channels → TA Inspection Rooms. All mapped messages update automatically."
            >
              <div className="form-padding">
                <p>
                  Existing customized templates stay unchanged. Apply the
                  default above, or add the room section below, then save the
                  draft.
                </p>
                <button
                  disabled={
                    !canEdit ||
                    busy ||
                    document.fields.some((f) => f.value === "{room.current}")
                  }
                  onClick={() => {
                    if (
                      window.confirm(
                        "Add a current-inspection field to this draft? Existing fields and text remain unchanged.",
                      )
                    )
                      edit({
                        fields: [
                          ...document.fields,
                          {
                            name: "🎓・กำลังตรวจงาน",
                            value: "{room.current}",
                            inline: false,
                          },
                        ],
                      });
                  }}
                >
                  Add current inspection section
                </button>
                {Object.entries({
                  overview: "Queue overview",
                  waiting: "Waiting list",
                  current: "Current inspection",
                  coursework: "Coursework",
                  number: "Queue number",
                  ta: "Inspecting TA",
                  status: "Status",
                }).map(([key, label]) => (
                  <label key={key} className="check">
                    <input
                      type="checkbox"
                      disabled={!canEdit}
                      checked={
                        document.roomLayout?.[
                          key as keyof NonNullable<Template["roomLayout"]>
                        ] ?? true
                      }
                      onChange={(e) =>
                        edit({
                          roomLayout: {
                            overview: true,
                            waiting: true,
                            current: true,
                            coursework: true,
                            number: true,
                            ta: true,
                            status: true,
                            ...document.roomLayout,
                            [key]: e.target.checked,
                          },
                        })
                      }
                    />
                    {label}
                  </label>
                ))}
                <p className="muted">
                  Overview and waiting toggles control their section
                  placeholders. Apply the default to migrate older layouts.
                  Public destinations follow queue privacy settings.
                </p>
                Room destinations are configured with their voice room so calls
                cannot be routed to another room.
              </div>
            </Panel>
          ) : (
            <Panel
              title="Publish panel"
              detail="Save the draft first. Existing messages update in place."
            >
              <div className="form-padding">
                <Field name="Target Discord channel">
                  <select
                    value={channel}
                    onChange={(e) => setChannel(e.target.value)}
                    disabled={!directory}
                  >
                    <option value="">Select text channel</option>
                    {directory?.channels
                      .filter((c) => [0, 5].includes(c.type))
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          # {c.name}
                        </option>
                      ))}
                  </select>
                </Field>
                {!directory && (
                  <p className="muted">
                    Configure the bot token to load Discord channels.
                  </p>
                )}
                <button
                  className="primary"
                  disabled={!canEdit || busy || !channel || !!draft}
                  onClick={() =>
                    void mutate(`templates/${current.id}/publish`, {
                      channelId: channel,
                    })
                  }
                >
                  Publish / republish
                </button>
                {current.panels.map((p) => (
                  <div className="publish-state" key={p.id}>
                    <Status
                      value={
                        p.error
                          ? "FAILED"
                          : p.publishedAt
                            ? "COMPLETED"
                            : "PENDING"
                      }
                    />
                    <small>
                      {p.error ||
                        (p.publishedAt
                          ? `Published ${relative(p.publishedAt)} · v${p.version}`
                          : "Waiting for bot synchronization")}
                      {p.messageId && (
                        <>
                          {" "}
                          ·{" "}
                          <a
                            href={`https://discord.com/channels/${p.guildId}/${p.channelId}/${p.messageId}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open Discord message
                          </a>
                        </>
                      )}
                    </small>
                  </div>
                ))}
                {error && <div className="notice danger">{error}</div>}
              </div>
            </Panel>
          )}
          <Panel
            title="Version history"
            detail="Restore creates a new version and preserves current draft."
          >
            <div className="form-padding">
              {(current.versions as { version: number }[]).length ? (
                (current.versions as { version: number }[])
                  .slice()
                  .reverse()
                  .map((v) => (
                    <div className="setting-row" key={v.version}>
                      <span>Version {v.version}</span>
                      <button
                        disabled={!canEdit || busy}
                        onClick={async () => {
                          if (window.confirm(`Restore version ${v.version}?`)) {
                            const saved = await mutate(
                              `templates/${current.id}/restore`,
                              { version: v.version },
                            );
                            if (saved) setDraft(null);
                          }
                        }}
                      >
                        Restore
                      </button>
                    </div>
                  ))
              ) : (
                <p className="muted">
                  Earlier versions appear after the first edit.
                </p>
              )}
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}

function InspectionHistory({
  canEdit,
  mutate,
}: {
  canEdit: boolean;
  mutate: <T>(path: string, data?: unknown) => Promise<T | undefined>;
}) {
  type Row = {
    id: string;
    startedAt: string;
    completedAt: string;
    completionReason: string;
    voided: boolean;
    note: string;
    ticket: {
      sequence: number;
      student: { name: string; lastname: string };
      coursework: { name: string };
      session: { taName: string };
    };
  };
  const records = useQuery({
    queryKey: ["inspections"],
    queryFn: () => api<Row[]>("inspections"),
    refetchInterval: 10000,
  });
  const [selected, setSelected] = useState<Row | null>(null);
  return (
    <Panel
      title="Inspection history"
      detail="Latest 200 completed records. Administrators can correct time/notes or void credit without changing queue history."
    >
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Ticket / student</th>
              <th>Coursework / TA</th>
              <th>Completion</th>
              <th>Credit</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {records.data?.map((r) => (
              <tr key={r.id}>
                <td>
                  #{r.ticket.sequence} · {r.ticket.student.name}{" "}
                  {r.ticket.student.lastname}
                </td>
                <td>
                  {r.ticket.coursework.name} ·{" "}
                  {r.ticket.session?.taName || "Unclaimed"}
                </td>
                <td>
                  {r.completionReason}
                  <br />
                  {new Date(r.completedAt).toLocaleString()}
                </td>
                <td>{r.voided ? "Voided" : "Counted"}</td>
                <td>
                  <button disabled={!canEdit} onClick={() => setSelected(r)}>
                    Correct inspection
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected && (
        <Modal
          title="Correct completed inspection"
          onClose={() => setSelected(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              const saved = await mutate(`inspections/${selected.id}`, {
                completedAt: String(fd.get("completedAt")),
                note: String(fd.get("note")),
                voided: fd.has("voided"),
              });
              if (saved) setSelected(null);
            }}
          >
            <Field name="Inspection end time (ISO UTC)">
              <input
                name="completedAt"
                defaultValue={selected.completedAt}
                required
              />
            </Field>
            <Field name="Correction reason / inspection note">
              <textarea
                name="note"
                defaultValue={selected.note}
                required
                maxLength={2000}
              />
            </Field>
            <label className="check">
              <input
                name="voided"
                type="checkbox"
                defaultChecked={selected.voided}
              />
              Exclude this inspection from rankings
            </label>
            <p>
              Queue history and TA attribution are retained. This correction is
              audited.
            </p>
            <button className="primary">Save correction</button>
          </form>
        </Modal>
      )}
    </Panel>
  );
}
function SessionHistory() {
  type History = {
    id: string;
    taName: string;
    status: string;
    capacity: number;
    activatedAt: string;
    completedAt: string | null;
    _count: { tickets: number };
    completedCount: number;
  };
  const data = useQuery({
    queryKey: ["session-history"],
    queryFn: () => api<History[]>("sessions"),
  });
  return (
    <Panel
      title="Session history"
      detail="Recorded sessions and completed work remain after stopping or restarting."
    >
      {data.data?.length ? (
        <Table
          head={[
            "TA",
            "Started",
            "Status",
            "Tickets",
            "Completed",
            "Inspection notes",
          ]}
        >
          {data.data.map((s) => (
            <tr key={s.id}>
              <td>{s.taName}</td>
              <td>{new Date(s.activatedAt).toLocaleString()}</td>
              <td>
                <Status value={s.status} />
              </td>
              <td>{s._count.tickets}</td>
              <td>{s.completedCount}</td>
              <td>
                <SessionWork sessionId={s.id} />
              </td>
            </tr>
          ))}
        </Table>
      ) : (
        <Empty title="No session history yet" />
      )}
    </Panel>
  );
}

function SessionWork({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [pages, setPages] = useState<(number | undefined)[]>([undefined]);
  const before = pages.at(-1);
  const work = useQuery({
    queryKey: ["session-work", sessionId, before],
    enabled: open,
    queryFn: () =>
      api<{
        tickets: {
          id: string;
          sequence: number;
          status: string;
          student: { name: string; lastname: string };
          inspection: { note: string } | null;
        }[];
        next: number | null;
      }>(`sessions/${sessionId}${before ? `?before=${before}` : ""}`),
  });
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>View recorded work</summary>
      {open &&
        (work.isPending ? (
          <p role="status">Loading recorded work…</p>
        ) : work.isError ? (
          <p role="alert">
            Could not load recorded work.{" "}
            <button onClick={() => void work.refetch()}>Retry</button>
          </p>
        ) : (
          <>
            {work.data.tickets.length ? (
              work.data.tickets.map((t) => (
                <p key={t.id}>
                  #{t.sequence} {t.student.name} {t.student.lastname} ·{" "}
                  {label(t.status)}
                  {t.inspection?.note ? ` · ${t.inspection.note}` : ""}
                </p>
              ))
            ) : (
              <p>No recorded work.</p>
            )}
            <div className="form-actions">
              <button
                disabled={pages.length === 1}
                onClick={() => setPages((p) => p.slice(0, -1))}
              >
                Newer
              </button>
              <button
                disabled={!work.data.next}
                onClick={() => setPages((p) => [...p, work.data.next!])}
              >
                Older
              </button>
            </div>
          </>
        ))}
    </details>
  );
}
