import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { db, Prisma } from "../../database/src/index";
import {
  DomainError,
  maintenanceInputSchema,
  json,
} from "../../shared/src/index";
import { analyticsWindow } from "../../shared/src/time";
import { databaseBackup } from "../../config/src/backup";
import {
  archivePreview,
  cleanArchives,
  logsDirectory,
} from "../../config/src/log-archives";
import { locked, event, Tx } from "./index";
export const confirmationPhrase = "RESET PRODUCTION DATA";
type Input = ReturnType<typeof maintenanceInputSchema.parse>;
const terminal = ["COMPLETED", "CANCELLED", "NO_SHOW"] as const;
const resolved = ["SUCCEEDED", "CANCELLED"];
export function cleanupCategories(input: Input) {
  return input.kind === "PRODUCTION"
    ? input.categories
    : (
        {
          LOGS: ["logs"],
          QUEUE_HISTORY: ["queue"],
          INSPECTION_ANALYTICS: ["inspections", "rankings"],
          SUPPORT_HISTORY: ["support"],
          RANKINGS: ["rankings"],
        } as Record<string, string[]>
      )[input.kind];
}
async function candidates(
  tx: Tx,
  guildId: string,
  input: Input,
  cutoff: Date,
  timezone: string,
  retention: number,
) {
  const categories = cleanupCategories(input);
  const range = analyticsWindow(input.from, input.through, timezone);
  range.lt = new Date(
    Math.min(range.lt?.getTime() ?? Infinity, cutoff.getTime()),
  );
  const pendingOperations = await tx.serviceOperation.findMany({
    where: { guildId, status: { in: ["PENDING", "RUNNING"] } },
    select: { data: true },
  });
  const protectedIds = pendingOperations.flatMap((o) => {
    const id = (o.data as { ticketId?: unknown }).ticketId;
    return typeof id === "string" ? [id] : [];
  });
  const safe: Prisma.QueueTicketWhereInput = {
    guildId,
    id: { notIn: protectedIds },
    status: { in: [...terminal] },
    reservation: null,
    OR: [{ inspection: null }, { inspection: { completedAt: { not: null } } }],
    transfers: { none: { state: { notIn: resolved } } },
    completion: { isNot: { state: { not: "SUCCEEDED" } } },
    updatedAt: { lt: cutoff },
  };
  async function ids<T extends { id: string | number }>(query: Promise<T[]>) {
    const rows = await query;
    if (rows.length > 10000)
      throw new DomainError(
        "LIMIT",
        "Select a narrower date range: maximum 10,000 records per category.",
        409,
      );
    return rows.map((r) => r.id);
  }
  const queue = categories.includes("queue")
    ? await ids(
        tx.queueTicket.findMany({
          where: { ...safe, updatedAt: range },
          select: { id: true },
          orderBy: { id: "asc" },
          take: 10001,
        }),
      )
    : [];
  const sourceInspections =
    input.method === "DELETE" &&
    (categories.includes("inspections") || categories.includes("rankings"))
      ? await ids(
          tx.inspection.findMany({
            where: { completedAt: range, ticket: safe },
            select: { id: true },
            orderBy: { id: "asc" },
            take: 10001,
          }),
        )
      : [];
  const queueInspections = await tx.inspection.findMany({
    where: { ticketId: { in: queue as string[] } },
    select: { id: true },
  });
  const inspections = [
    ...new Set([...sourceInspections, ...queueInspections.map((i) => i.id)]),
  ].sort();
  const support = categories.includes("support")
    ? await ids(
        tx.supportTicket.findMany({
          where: {
            guildId,
            status: "CLOSED",
            id: { notIn: protectedIds },
            closedAt: {
              ...range,
              lt: new Date(
                Math.min(
                  range.lt.getTime(),
                  cutoff.getTime() - retention * 86400000,
                ),
              ),
            },
            OR: [{ channelDeletedAt: { not: null } }, { channelId: null }],
          },
          select: { id: true },
          orderBy: { id: "asc" },
          take: 10001,
        }),
      )
    : [];
  const active = await tx.queueTicket.findMany({
    where: {
      guildId,
      OR: [
        { status: { notIn: [...terminal] } },
        { reservation: { isNot: null } },
        { transfers: { some: { state: { notIn: resolved } } } },
      ],
    },
    select: { id: true },
  });
  const logs = categories.includes("logs")
    ? await ids(
        tx.systemEvent.findMany({
          where: {
            guildId,
            createdAt: range,
            dispatchedAt: { not: null },
            type: {
              in: [
                "queue.admitted",
                "queue.cancelled",
                "queue.claimed",
                "queue.integrity",
                "queue.no_show",
                "inspection.completed",
                "transfer.started",
                "transfer.succeeded",
                "transfer.failed",
                "bot.error",
                "worker.error",
                "system.started",
                "interaction.failed",
                "support.created",
                "support.closed",
                "session.started",
                "session.stopped",
              ],
            },
            deliveries: { none: { status: { in: ["PENDING", "RUNNING"] } } },
            AND: active.map((a) => ({
              NOT: { data: { path: ["ticketId"], equals: a.id } },
            })),
          },
          select: { id: true },
          orderBy: { id: "asc" },
          take: 10001,
        }),
      )
    : [];
  const archived = categories.includes("logs")
    ? await archivePreview(range.gte, range.lt, cutoff)
    : [];
  return {
    queue: queue as string[],
    inspections: inspections as string[],
    support: support as string[],
    logs: logs as number[],
    archived,
    range,
  };
}
const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export async function previewMaintenance(
  guildId: string,
  adminId: string,
  raw: unknown,
) {
  const input = maintenanceInputSchema.parse(raw);
  if (
    input.method === "BASELINE" &&
    (input.from || input.through) &&
    cleanupCategories(input).some((c) =>
      ["inspections", "rankings"].includes(c),
    )
  )
    throw new DomainError(
      "BASELINE",
      "A reporting baseline applies to all earlier statistics. Clear dates or choose permanent deletion.",
      400,
    );
  return locked(guildId, async (tx, settings) => {
    const cutoff = new Date();
    const chosen = await candidates(
      tx,
      guildId,
      input,
      cutoff,
      settings.timezone,
      settings.transcriptRetentionDays,
    );
    const preview = {
      ...chosen,
      counts: {
        queue: chosen.queue.length,
        inspections: chosen.inspections.length,
        support: chosen.support.length,
        events: chosen.logs.length,
        archivedLogs: chosen.archived.reduce((n, f) => n + f.records, 0),
      },
      protected: {
        activeTickets: await tx.queueTicket.count({
          where: { guildId, status: { notIn: [...terminal] } },
        }),
        activeInspections: await tx.inspection.count({
          where: { ticket: { guildId }, completedAt: null },
        }),
        openSupport: await tx.supportTicket.count({
          where: { guildId, status: { not: "CLOSED" } },
        }),
      },
      baseline:
        input.method === "BASELINE"
          ? cleanupCategories(input).filter((c) =>
              ["inspections", "rankings"].includes(c),
            )
          : [],
      notes: [
        "Current-day and recently written log files are protected.",
        "Support history must be closed, its channel removed, and transcript retention expired.",
        "Administrator, identity and configuration audit events are preserved.",
      ],
    };
    const plan = await tx.maintenancePlan.create({
      data: {
        guildId,
        adminId,
        input: json(input) as Prisma.InputJsonValue,
        preview: json(preview) as Prisma.InputJsonValue,
        fingerprint: fingerprint(chosen),
        cutoff,
        expiresAt: new Date(Date.now() + 1800000),
      },
    });
    await event(
      tx,
      guildId,
      adminId,
      "maintenance.preview",
      "Historical cleanup preview created.",
      { planId: plan.id, counts: preview.counts },
    );
    return plan;
  });
}
function allowed(
  plan: { adminId: string; expiresAt: Date; status?: string; result?: unknown },
  adminId: string,
) {
  if (plan.adminId !== adminId)
    throw new DomainError("OWNER", "This plan belongs to another owner.", 403);
  if (
    plan.expiresAt < new Date() &&
    !(plan.result && ["PARTIAL", "RUNNING"].includes(plan.status || ""))
  )
    throw new DomainError(
      "EXPIRED",
      "Cleanup preview expired. Create a new preview.",
      409,
    );
}
async function verifyBackup(path: string) {
  const info = await stat(path);
  if (info.size < 100) throw new Error("Backup is empty.");
  await new Promise<void>((ok, fail) => {
    const child = spawn("pg_restore", ["--list", path], { stdio: "ignore" });
    child.on("error", fail);
    child.on("close", (code) =>
      code === 0 ? ok() : fail(new Error("Backup verification failed.")),
    );
  });
}
export async function backupMaintenance(
  guildId: string,
  adminId: string,
  id: string,
  databaseUrl: string,
) {
  const plan = await locked(guildId, async (tx) => {
    const p = await tx.maintenancePlan.findFirstOrThrow({
      where: { id, guildId },
    });
    allowed(p, adminId);
    if (
      p.backupVerifiedAt &&
      ["READY", "COMPLETED", "PARTIAL"].includes(p.status)
    )
      return p;
    if (
      !["PREVIEW", "FAILED", "BACKING_UP"].includes(p.status) ||
      (p.leaseUntil && p.leaseUntil > new Date())
    )
      throw new DomainError(
        "BUSY",
        "A cleanup backup is already running.",
        409,
      );
    return tx.maintenancePlan.update({
      where: { id },
      data: {
        status: "BACKING_UP",
        leaseUntil: new Date(Date.now() + 600000),
        error: null,
      },
    });
  });
  if (plan.backupVerifiedAt) return plan;
  const path = resolve(
    logsDirectory,
    "../backups",
    `maintenance-${plan.id}-${Date.now()}.dump`,
  );
  try {
    await databaseBackup(databaseUrl, path);
    await verifyBackup(path);
    const saved = await db.maintenancePlan.updateMany({
      where: { id, status: "BACKING_UP", leaseUntil: plan.leaseUntil },
      data: {
        status: "READY",
        backupPath: path,
        backupVerifiedAt: new Date(),
        leaseUntil: null,
      },
    });
    if (!saved.count)
      throw new DomainError(
        "LEASE",
        "Backup lease changed. Reload the cleanup plan.",
      );
    return db.maintenancePlan.findUniqueOrThrow({ where: { id } });
  } catch (e) {
    await db.maintenancePlan.updateMany({
      where: { id, status: "BACKING_UP", leaseUntil: plan.leaseUntil },
      data: {
        status: "FAILED",
        error: "Backup failed. Check PostgreSQL client and backup storage.",
        leaseUntil: null,
      },
    });
    throw e;
  }
}
export async function executeMaintenance(
  guildId: string,
  adminId: string,
  id: string,
  phrase: string,
) {
  if (phrase !== confirmationPhrase)
    throw new DomainError(
      "CONFIRMATION",
      `Type ${confirmationPhrase} exactly.`,
      400,
    );
  const original = await db.maintenancePlan.findFirstOrThrow({
    where: { id, guildId },
  });
  if (original.adminId !== adminId)
    throw new DomainError("OWNER", "This plan belongs to another owner.", 403);
  if (original.status === "COMPLETED") return original;
  allowed(original, adminId);
  if (!original.backupPath || !original.backupVerifiedAt)
    throw new DomainError("BACKUP", "Create and verify the backup first.", 409);
  await verifyBackup(original.backupPath);
  const plan = await locked(guildId, async (tx, settings) => {
    const p = await tx.maintenancePlan.findUniqueOrThrow({ where: { id } });
    allowed(p, adminId);
    if (p.status === "COMPLETED") return p;
    if (
      await tx.maintenancePlan.findFirst({
        where: { guildId, id: { not: id }, status: "RUNNING" },
      })
    )
      throw new DomainError(
        "BUSY",
        "Another cleanup is finishing its log files. Complete or recover that plan first.",
        409,
      );

    if (
      (p.status === "RUNNING" && p.leaseUntil && p.leaseUntil > new Date()) ||
      (p.status === "PARTIAL" && p.leaseUntil && p.leaseUntil > new Date())
    )
      throw new DomainError("BUSY", "Cleanup is already running.", 409);
    if (
      p.status === "PARTIAL" ||
      (p.status === "RUNNING" &&
        p.result &&
        (!p.leaseUntil || p.leaseUntil < new Date()))
    )
      return tx.maintenancePlan.update({
        where: { id },
        data: { status: "RUNNING", leaseUntil: new Date(Date.now() + 600000) },
      });
    if (p.status !== "READY")
      throw new DomainError(
        "BUSY",
        "This cleanup is already running or requires a new preview.",
        409,
      );
    const input = maintenanceInputSchema.parse(p.input),
      chosen = await candidates(
        tx,
        guildId,
        input,
        p.cutoff,
        settings.timezone,
        settings.transcriptRetentionDays,
      );
    if (fingerprint(chosen) !== p.fingerprint)
      throw new DomainError(
        "STALE",
        "Records or log archives changed. Create a fresh preview.",
        409,
      );
    const categories = cleanupCategories(input);
    const guild = await tx.guild.findUniqueOrThrow({ where: { id: guildId } });
    if (input.method === "BASELINE" || (!input.from && !input.through))
      await tx.guild.update({
        where: { id: guildId },
        data: {
          ...(categories.includes("inspections")
            ? {
                analyticsSince:
                  guild.analyticsSince && guild.analyticsSince > p.cutoff
                    ? guild.analyticsSince
                    : p.cutoff,
              }
            : {}),
          ...(categories.includes("rankings") ||
          categories.includes("inspections")
            ? {
                rankingsSince:
                  guild.rankingsSince && guild.rankingsSince > p.cutoff
                    ? guild.rankingsSince
                    : p.cutoff,
              }
            : {}),
        },
      });
    await tx.inspectionCompletion.deleteMany({
      where: { ticketId: { in: chosen.queue }, state: "SUCCEEDED" },
    });
    const removedInspections = await tx.inspection.deleteMany({
      where: {
        OR: [
          { id: { in: chosen.inspections } },
          { ticketId: { in: chosen.queue } },
        ],
      },
    });
    await tx.voiceTransferOperation.deleteMany({
      where: { ticketId: { in: chosen.queue }, state: { in: resolved } },
    });
    const queue = await tx.queueTicket.deleteMany({
      where: { id: { in: chosen.queue } },
    });
    await tx.supportTicketEvent.deleteMany({
      where: { ticketId: { in: chosen.support } },
    });
    const support = await tx.supportTicket.deleteMany({
      where: { id: { in: chosen.support } },
    });
    await tx.notificationDelivery.deleteMany({
      where: { eventId: { in: chosen.logs } },
    });
    const logs = await tx.systemEvent.deleteMany({
      where: { id: { in: chosen.logs } },
    });
    const result = {
      queue: queue.count,
      inspections: removedInspections.count,
      support: support.count,
      events: logs.count,
      archivedLogs: 0,
      baseline:
        input.method === "BASELINE"
          ? categories.filter((c) => ["inspections", "rankings"].includes(c))
          : [],
    };
    await event(
      tx,
      guildId,
      adminId,
      "maintenance.executed",
      "Historical cleanup committed.",
      { planId: id, result },
    );
    await tx.serviceOperation.create({
      data: { guildId, actorId: adminId, action: "refresh_panels" },
    });
    return tx.maintenancePlan.update({
      where: { id },
      data: {
        status: "RUNNING",
        leaseUntil: new Date(Date.now() + 600000),
        result: result as Prisma.InputJsonValue,
      },
    });
  });
  if (plan.status === "COMPLETED") return plan;
  try {
    const preview = plan.preview as unknown as {
      archived: Awaited<ReturnType<typeof archivePreview>>;
      range: { gte?: string; lt: string };
    };
    const archivedLogs = await cleanArchives(
      preview.archived,
      join(resolve(logsDirectory, "../backups"), `maintenance-${id}-logs`),
      preview.range.gte ? new Date(preview.range.gte) : undefined,
      new Date(preview.range.lt),
    );
    return await db.maintenancePlan.update({
      where: { id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        leaseUntil: null,
        error: null,
        result: { ...(plan.result as object), archivedLogs },
      },
    });
  } catch (e) {
    await db.maintenancePlan.update({
      where: { id },
      data: {
        status: "PARTIAL",
        leaseUntil: null,
        error:
          e instanceof Error &&
          e.message === "Log archive changed; preview cleanup again."
            ? "Database cleanup committed. A log archive changed; create a new Logs preview for remaining records."
            : "Database cleanup committed; log archives were not fully cleared. Retry this plan.",
      },
    });
    throw e;
  }
}
