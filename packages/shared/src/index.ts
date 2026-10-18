import { z } from "zod";
export const snowflake = z
  .string()
  .regex(/^\d{17,20}$/, "Enter a valid Discord ID.");
export const waitingAlertSchema = z.object({
  enabled: z.boolean().default(true),
  waitingChannelIds: z.array(snowflake).max(30).default([]),
  channelId: z.union([snowflake, z.literal("")]).default(""),
  roleIds: z.array(snowflake).max(20).default([]),
  graceSeconds: z.number().int().min(5).max(3600).default(30),
  cooldownSeconds: z.number().int().min(60).max(86400).default(300),
  noAccepting: z.boolean().default(true),
  noAvailable: z.boolean().default(true),
  triggerMode: z.enum(["ANY", "ALL"]).default("ANY"),
  queueFull: z.boolean().default(false),
  group: z.boolean().default(true),
  autoResolve: z.boolean().default(true),
});
export const taRoomActions = [
  "start",
  "stop",
  "CALL_NEXT_STUDENT",
  "complete",
  "my_queue",
  "no_show",
  "MARK_STUDENT_NO_SHOW",
  "retry",
  "return",
  "session_settings",
  "note",
  "refresh",
] as const;
export const settingsSchema = z
  .object({
    verificationMode: z
      .enum(["STUDENT_ID", "ADMIN_APPROVAL"])
      .default("STUDENT_ID"),
    embedAutoRefreshEnabled: z.boolean().default(true),
    embedRefreshIntervalSeconds: z.number().int().min(5).max(3600).default(30),
    embedUpdateDebounceMs: z.number().int().min(100).max(10000).default(1500),
    studentVoiceVisible: z.boolean().default(true),
    channelVisibility: z
      .array(
        z.object({
          channelId: snowflake,
          policy: z.enum([
            "EVERYONE",
            "UNVERIFIED_ONLY",
            "STUDENTS",
            "TAS",
            "SUPPORT",
            "ADMINS",
            "CUSTOM",
          ]),
          roleIds: z.array(snowflake).max(30).default([]),
          deniedRoleIds: z.array(snowflake).max(30).default([]),
          autoSync: z.boolean().default(true),
        }),
      )
      .max(50)
      .refine(
        (v) => new Set(v.map((r) => r.channelId)).size === v.length,
        "One visibility policy per channel is allowed.",
      )
      .default([]),
    featureAccess: z
      .record(
        z.string(),
        z.enum(["EVERYONE", "STUDENTS", "TAS", "SUPPORT", "ADMINS"]),
      )
      .default({}),
    taStudentChannelAccess: z.boolean().default(true),
    taStudentChannelExceptions: z.array(snowflake).max(100).default([]),
    taStudentConnectChannels: z.array(snowflake).max(30).default([]),
    noShowDMEnabled: z.boolean().default(true),
    studentRole: z.union([snowflake, z.literal("")]).default(""),
    taRole: z.union([snowflake, z.literal("")]).default(""),
    supportRoles: z.array(snowflake).default([]),
    adminRoles: z.array(snowflake).default([]),
    moderatorRoles: z.array(snowflake).default([]),
    minCapacity: z.number().int().min(1).max(100).default(3),
    maxCapacity: z.number().int().min(1).max(200).default(30),
    defaultCapacity: z.number().int().positive().default(5),
    inspectionConcurrency: z.number().int().min(1).max(5).default(1),
    allocation: z
      .enum(["OLDEST", "LEAST_FILLED", "WEIGHTED"])
      .default("OLDEST"),
    maintenance: z.boolean().default(false),
    requireIdentity: z.boolean().default(true),
    autoMute: z.boolean().default(false),
    muteCleanup: z.boolean().default(true),
    allowCancellation: z.boolean().default(true),
    assistance: z.boolean().default(true),
    maxMoveAttempts: z.number().int().min(1).max(10).default(3),
    noShowTimeoutSeconds: z.number().int().min(0).max(86400).default(0),
    staleWarningSeconds: z.number().int().min(30).max(3600).default(180),
    claimLeaseSeconds: z.number().int().min(30).max(600).default(90),
    waitingRoomAlerts: waitingAlertSchema.prefault({}),
    alertGraceSeconds: z.number().int().min(5).max(3600).default(60),
    alertCooldownSeconds: z.number().int().min(60).default(600),
    alertText: z
      .string()
      .min(1)
      .max(1500)
      .default(
        "แจ้งเตือน: TA หนีงาน! ยังมีนักศึกษารอคิวอยู่ กรุณากลับมาช่วยตรวจงาน",
      ),
    supportCategories: z
      .array(z.string().min(1).max(100))
      .min(1)
      .refine(
        (v) => new Set(v).size === v.length,
        "Support categories must be unique.",
      )
      .max(20)
      .default(["Coursework", "Registration", "Technical issue"]),
    maxOpenSupport: z.number().int().min(1).max(10).default(1),
    transcriptRetentionDays: z.number().int().min(1).max(3650).default(30),
    retainTranscripts: z.boolean().default(false),
    publicStudentNames: z.boolean().default(false),
    publicStudentIds: z.enum(["HIDDEN", "MASKED", "FULL"]).default("HIDDEN"),
    queueShowCoursework: z.boolean().default(true),
    publicStudentRanking: z.boolean().default(false),
    nicknameTemplate: z.string().min(1).max(100).default("{name} {lastname}"),
    language: z.enum(["en", "th"]).default("en"),
    timezone: z
      .string()
      .refine((v) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }, "Invalid timezone")
      .default("Asia/Bangkok"),
    notifications: z.boolean().default(true),
    routineAnnouncements: z.boolean().default(false),
    calledText: z
      .string()
      .max(1000)
      .default(
        "กำลังเรียกนักศึกษา: {student.name} · #{ticket.id} · {coursework.name}",
      ),
    movedText: z
      .string()
      .max(1000)
      .default("ย้าย {student.name} เข้าห้องตรวจเรียบร้อยแล้ว"),
    failedText: z
      .string()
      .max(1000)
      .default("ไม่สามารถย้ายนักศึกษาได้: {student.name} กรุณาตรวจสอบห้องรอ"),
    advancedPermissionsEnabled: z.boolean().default(false),
    featurePermissions: z.record(z.string(), z.array(snowflake)).default({}),
  })
  .refine(
    (v) =>
      v.minCapacity <= v.defaultCapacity && v.defaultCapacity <= v.maxCapacity,
    { message: "Minimum ≤ default ≤ maximum capacity is required." },
  );
export type Settings = z.infer<typeof settingsSchema>;
export const studentSchema = z.object({
  studentId: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[\p{L}\p{N}_-]+$/u),
  name: z.string().trim().min(1).max(100),
  lastname: z.string().trim().min(1).max(100),
});
export const courseworkSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).default(""),
  label: z.string().max(50).default(""),
  enabled: z.boolean().default(true),
  archived: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
  eligibleUsers: z.array(snowflake).default([]),
  eligibleRoles: z.array(snowflake).default([]),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
});
export const bindingFeatures = [
  "onboarding_readme",
  "registration",
  "student_queue",
  "public_queue",
  "ta_dashboard",
  "waiting_voice",
  "ta_voice",
  "support",
  "ticket_category",
  "ranking",
  "summary",
  "error_log",
  "audit_log",
  "queue_alert",
  "post_inspection",
  "student_ranking",
  "system_status",
] as const;
export const actions = [
  "verify",
  "coursework",
  "join",
  "status",
  "cancel",
  "refresh",
  "start",
  "stop",
  "CALL_NEXT_STUDENT",
  "next",
  "complete",
  "my_queue",
  "help",
  "session_settings",
  "no_show",
  "MARK_STUDENT_NO_SHOW",
  "no_show_confirm",
  "no_show_cancel",
  "retry",
  "return",
  "note",
  "support_open",
  "support_claim",
  "support_close",
  "support_reopen",
  "support_escalate",
  "support_assign",
  "support_reply",
] as const;
export const actionSchema = z.enum(actions);
export const operations = [
  "sync_visibility",
  "reconnect_gateway",
  "restart_bot",
  "restart_worker",
  "restart_sync",
  "refresh_panels",
  "reconcile_transfers",
  "retry_moves",
  "rebuild_read_models",
  "reload_configuration",
  "reconcile_sessions",
  "integrity_check",
  "backup",
  "validate_channels",
  "retry_notifications",
] as const;
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}
export const ACTIVE = [
  "QUEUED",
  "CLAIMED",
  "MOVING",
  "IN_PROGRESS",
  "MOVE_FAILED",
  "NEEDS_REVIEW",
] as const;
export function canHandle(
  course: { eligibleUsers: string[]; eligibleRoles: string[] },
  session: { taId: string; roleIds: string[]; courseworkIds: string[] },
  id: string,
) {
  return (
    (!session.courseworkIds.length || session.courseworkIds.includes(id)) &&
    ((!course.eligibleUsers.length && !course.eligibleRoles.length) ||
      course.eligibleUsers.includes(session.taId) ||
      course.eligibleRoles.some((r) => session.roleIds.includes(r)))
  );
}
export function safeCsvCell(v: string) {
  return /^[=+\-@\t\r\n]/.test(v) ? `'${v}` : v;
}
export function json<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

export const accessPresets = {
  EVERYONE: "Public — Everyone",
  STUDENTS: "Verified Students",
  TAS: "Teaching Assistants",
  SUPPORT: "Support Staff",
  ADMINS: "Administrators",
} as const;
export const defaultAccess: Record<string, keyof typeof accessPresets> = {
  registration: "EVERYONE",
  student_queue: "STUDENTS",
  public_queue: "STUDENTS",
  ta_dashboard: "TAS",
  waiting_voice: "STUDENTS",
  ta_voice: "TAS",
  support: "STUDENTS",
  ticket_category: "SUPPORT",
  ranking: "TAS",
  student_ranking: "STUDENTS",
  summary: "TAS",
  error_log: "ADMINS",
  audit_log: "ADMINS",
  queue_alert: "TAS",
  post_inspection: "STUDENTS",
  system_status: "ADMINS",
};

export const supportInputSchema = z.object({
  category: z.string().min(1).max(100),
  subject: z
    .string()
    .min(1)
    .max(1000)
    .refine((v) => !!v.trim(), "Subject is required."),
  description: z.string().min(1).max(2000),
  additional: z.string().max(2000).default(""),
});

export const studentIdDisclosureWarning =
  "Full Student IDs will be visible to everyone who can access this channel, including students. Only enable this mode when your institution permits this disclosure.";
export const roomPanelSchema = z
  .object({
    voiceChannelId: snowflake,
    destinationChannelId: snowflake,
    mode: z.enum(["VOICE", "COMPANION"]),
    visibility: z
      .enum(["PUBLIC", "TAS", "FULL_INSPECTION_DETAILS"])
      .default("PUBLIC"),
    studentIdDisclosureAcknowledged: z.boolean().default(false),
    templateId: z.string().min(1),
    enabled: z.boolean().default(true),
    refreshSeconds: z.number().int().min(5).max(3600).default(30),
  })
  .refine(
    (data) =>
      data.visibility !== "FULL_INSPECTION_DETAILS" ||
      data.studentIdDisclosureAcknowledged,
    {
      path: ["studentIdDisclosureAcknowledged"],
      message: studentIdDisclosureWarning,
    },
  );
export const maintenanceInputSchema = z.object({
  kind: z.enum([
    "LOGS",
    "QUEUE_HISTORY",
    "INSPECTION_ANALYTICS",
    "SUPPORT_HISTORY",
    "RANKINGS",
    "PRODUCTION",
  ]),
  method: z.enum(["BASELINE", "DELETE"]).default("BASELINE"),
  categories: z
    .array(z.enum(["queue", "inspections", "rankings", "logs", "support"]))
    .min(1)
    .default(["queue", "inspections", "rankings", "logs", "support"]),
  from: z.string().date().nullable().default(null),
  through: z.string().date().nullable().default(null),
});
