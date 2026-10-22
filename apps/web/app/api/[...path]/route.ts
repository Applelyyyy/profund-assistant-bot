import { roomCurrent } from "../../../../../packages/discord-ui/src/queue-display";
import {
  previewMaintenance,
  backupMaintenance,
  executeMaintenance,
} from "../../../../../packages/queue-engine/src/maintenance";
import { prepareRoomPanel } from "../../../../../packages/config/src/room-panels";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  refreshForEvents,
  consoleQueryKeys,
} from "../../../../../packages/shared/src/live-updates";
import Redis from "ioredis";
import { REST } from "discord.js";
import { db, Prisma } from "../../../../../packages/database/src/index";
import {
  measure,
  performanceSnapshot,
} from "../../../../../packages/config/src/performance";
import { env, logger } from "../../../../../packages/config/src/index";
import {
  prepareAccess,
  accessSettings,
  validateAccessRoles,
  AccessRole,
} from "../../../../../packages/config/src/access";
import { runtimeLogs } from "../../../../../packages/config/src/logs";
import { analyticsWindow } from "../../../../../packages/shared/src/time";
import {
  authenticate,
  login,
  passwordHash,
  sessionCookie,
} from "../../../../../packages/shared/src/auth";
import {
  ACTIVE,
  DomainError,
  settingsSchema,
  studentSchema,
  courseworkSchema,
  bindingFeatures,
  snowflake,
  json,
  operations,
} from "../../../../../packages/shared/src/index";
import {
  parseStudents,
  exportStudents,
} from "../../../../../packages/shared/src/csv";
import {
  templateSchema,
  arrivalTemplateSchema,
  roomPanelTemplateSchema,
  render,
  defaults,
  normalizeActions,
  panelActions,
  waitingAlertTemplateSchema,
  resolve,
} from "../../../../../packages/discord-ui/src/index";
import {
  cancelTicket,
  stopSession,
  retryMove,
  snapshot,
  locked,
  event,
  integrity,
  mutate,
} from "../../../../../packages/queue-engine/src/index";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const connection = new Redis(
  process.env.REDIS_URL || "redis://127.0.0.1:6379",
  {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 1500,
    retryStrategy: () => null,
  },
);
connection.on("error", () => {});
const result = (v: unknown, status = 200) =>
  NextResponse.json(json(v), {
    status,
    headers: { "Cache-Control": "no-store" },
  });
async function body(req: NextRequest) {
  const text = await req.text();
  if (Buffer.byteLength(text) > 3 * 1024 * 1024)
    throw new DomainError("SIZE", "Request exceeds 3 MB.", 413);
  try {
    return JSON.parse(text);
  } catch {
    throw new DomainError("JSON", "Invalid JSON request.", 400);
  }
}
async function queueIdentityRecovery(
  tx: Prisma.TransactionClient,
  guildId: string,
  actorId: string,
) {
  const pending = await tx.serviceOperation.findFirst({
    where: { guildId, action: "recover_identities", status: "PENDING" },
  });
  if (pending) return pending;
  const operation = await tx.serviceOperation.create({
    data: { guildId, actorId, action: "recover_identities" },
  });
  await event(
    tx,
    guildId,
    actorId,
    "identity.recovery_requested",
    "Recovery of previously verified Discord identities queued.",
    { operationId: operation.id },
  );
  return operation;
}
const directoryRest = new REST({
  version: "10",
  timeout: 10000,
  retries: 3,
}).setToken(env().DISCORD_BOT_TOKEN);
let directoryCache: { expires: number; value: unknown } | undefined;
let directoryFlight: Promise<unknown> | undefined;
async function discord(path: string) {
  if (!env().DISCORD_BOT_TOKEN)
    throw new DomainError(
      "DISCORD_TOKEN",
      "Configure DISCORD_BOT_TOKEN to fetch the server directory.",
      503,
    );
  try {
    return await directoryRest.get(`/${path}`);
  } catch (error) {
    const status = (error as { status?: number }).status || "unavailable";
    throw new DomainError(
      "DISCORD_API",
      `Discord directory unavailable (${status}). Check bot permissions, token and guild membership.`,
      503,
    );
  }
}

async function route(
  req: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const parts = (await context.params).path;
  const resource = parts[0];
  const id = parts[1];
  const action = parts[2];
  const write = req.method !== "GET";
  const guildId = env().DISCORD_GUILD_ID;
  if (resource === "login" && req.method === "POST") {
    if (req.headers.get("origin") !== new URL(env().APP_BASE_URL).origin)
      throw new DomainError("ORIGIN", "Request origin is not allowed.", 403);
    const input = z
      .object({
        username: z.string().min(1).max(64),
        password: z.string().min(1).max(256),
      })
      .parse(await body(req));
    // Direct localhost deployment has no trusted proxy; never trust forwarded client IP headers.
    const data = await login(input.username, input.password, "local");
    await locked(guildId, (tx) =>
      event(
        tx,
        guildId,
        data.user.id,
        "admin.login",
        "Administrator signed in.",
      ),
    );
    const r = result({
      username: data.user.username,
      role: data.user.role,
      csrf: data.session.csrf,
    });
    r.headers.set("Set-Cookie", sessionCookie(data.token));
    return r;
  }
  const required =
    !write || resource === "logout"
      ? "VIEWER"
      : ["queue", "sessions", "operations", "support"].includes(resource)
        ? "OPERATOR"
        : resource === "accounts"
          ? "OWNER"
          : "ADMIN";
  const auth = await authenticate(req, write, required);
  const actor = auth.admin.id;
  const key = req.headers.get("idempotency-key") || randomUUID();
  if (resource === "data-management") {
    if (auth.admin.role !== "OWNER")
      throw new DomainError(
        "OWNER",
        "Only owners can preview or execute data cleanup.",
        403,
      );
    if (!write)
      return result(
        await db.maintenancePlan.findMany({
          where: { guildId },
          orderBy: { createdAt: "desc" },
          take: 20,
        }),
      );
    if (id === "preview")
      return result(await previewMaintenance(guildId, actor, await body(req)));
    if (id && action === "backup")
      return result(
        await backupMaintenance(guildId, actor, id, env().DATABASE_URL),
      );
    if (id && action === "execute")
      return result(
        await executeMaintenance(
          guildId,
          actor,
          id,
          z.object({ confirmation: z.string() }).parse(await body(req))
            .confirmation,
        ),
      );
    throw new DomainError("ACTION", "Unknown cleanup action.", 400);
  }
  if (resource === "me")
    return result({
      username: auth.admin.username,
      role: auth.admin.role,
      csrf: auth.csrf,
    });
  if (resource === "logout" && write) {
    await db.adminSession.delete({ where: { id: auth.id } });
    const r = result({ ok: true });
    r.headers.set("Set-Cookie", sessionCookie("", 0));
    return r;
  }
  if (resource === "events" && !write) {
    const supplied =
      req.headers.get("last-event-id") || req.nextUrl.searchParams.get("after");
    const after = Number(supplied || 0);
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | undefined;
    let busy = false;
    let last = Number.isSafeInteger(after) && after >= 0 ? after : 0;
    let initialized = false;
    let closed = false;
    const stop = () => {
      closed = true;
      if (timer) clearInterval(timer);
      req.signal.removeEventListener("abort", abort);
    };
    let streamController: ReadableStreamDefaultController | undefined;
    const abort = () => {
      stop();
      try {
        streamController?.close();
      } catch {}
    };
    const stream = new ReadableStream({
      start(controller) {
        streamController = controller;
        const poll = async () => {
          if (busy || closed) return;
          busy = true;
          try {
            const valid = await db.adminSession.findUnique({
              where: { id: auth.id },
              include: { admin: true },
            });
            if (
              !valid ||
              valid.expiresAt < new Date() ||
              valid.admin.disabled
            ) {
              stop();
              controller.close();
              return;
            }
            if (closed) return;
            if (!initialized) {
              initialized = true;
              if (!supplied)
                last =
                  (
                    await db.systemEvent.findFirst({
                      where: { guildId },
                      orderBy: { id: "desc" },
                      select: { id: true },
                    })
                  )?.id || 0;
              controller.enqueue(
                encoder.encode(
                  `id: ${last}\ndata: ${JSON.stringify({ last, count: 0, queries: supplied ? [] : consoleQueryKeys })}\n\n`,
                ),
              );
            }
            const events = await db.systemEvent.findMany({
              where: { guildId, id: { gt: last } },
              orderBy: { id: "asc" },
              take: 1000,
              select: { id: true, type: true },
            });
            if (closed) return;
            if (events.length) {
              last = events.at(-1)!.id;
              controller.enqueue(
                encoder.encode(
                  `id: ${last}\ndata: ${JSON.stringify({ last, count: events.length, queries: refreshForEvents(events.map((e) => e.type)).queries })}\n\n`,
                ),
              );
            } else controller.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch {
            stop();
            try {
              controller.close();
            } catch {}
          } finally {
            busy = false;
          }
        };
        timer = setInterval(poll, 2000);
        req.signal.addEventListener("abort", abort, { once: true });
        if (req.signal.aborted) abort();
        void poll();
      },
      cancel() {
        stop();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }
  if (resource === "performance" && !write)
    return result(performanceSnapshot());
  if (resource === "overview" && !write) return result(await snapshot(guildId));
  if (resource === "health" && !write) {
    let database = false,
      redis = false;
    try {
      await db.$queryRaw`SELECT 1`;
      database = true;
    } catch {}
    try {
      redis = (await connection.ping()) === "PONG";
    } catch {}
    const heartbeats = await db.serviceHeartbeat.findMany();
    return result({
      database,
      redis,
      website: true,
      services: heartbeats.map((h) => ({
        ...h,
        online: h.updatedAt.getTime() > Date.now() - 30000,
      })),
      pending:
        (await db.serviceOperation.count({
          where: { guildId, status: { in: ["PENDING", "RUNNING"] } },
        })) +
        (await db.inspectionCompletion.count({
          where: {
            ticket: { guildId },
            state: { in: ["PENDING", "DISCONNECTING"] },
          },
        })),
      failedMoves: await db.queueTicket.count({
        where: { guildId, status: { in: ["MOVE_FAILED", "NEEDS_REVIEW"] } },
      }),
    });
  }
  if (resource === "students") {
    if (write && id === "recover-mappings")
      return result(
        await locked(guildId, (tx) =>
          queueIdentityRecovery(tx, guildId, actor),
        ),
      );
    if (write && action === "approve")
      return result(
        await locked(guildId, async (tx) => {
          const student = await tx.student.findFirstOrThrow({
            where: { id, guildId, registration: "APPROVAL_PENDING" },
          });
          await tx.student.update({
            where: { id: student.id },
            data: { registration: "SYNC_PENDING" },
          });
          await event(
            tx,
            guildId,
            actor,
            "identity.approved",
            "Administrator approved student identity.",
            { studentId: student.id },
          );
          return tx.serviceOperation.create({
            data: {
              guildId,
              actorId: actor,
              action: "sync_identity",
              data: { studentId: student.id },
            },
          });
        }),
      );

    if (!write) {
      const rows = await db.student.findMany({
        where: { guildId },
        orderBy: { studentId: "asc" },
      });
      if (id === "export")
        return new Response(exportStudents(rows), {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="students.csv"',
          },
        });
      if (id === "template")
        return new Response("id,name,lastname\n001234,First,Last\n", {
          headers: {
            "Content-Type": "text/csv",
            "Content-Disposition":
              'attachment; filename="student-template.csv"',
          },
        });
      return result(rows);
    }
    if (id === "preview") {
      const input = z
        .object({
          csv: z.string().max(2 * 1024 * 1024),
          filename: z.string().regex(/\.csv$/i),
        })
        .parse(await body(req));
      const parsed = parseStudents(input.csv);
      const existing = await db.student.findMany({
        where: {
          guildId,
          studentId: { in: parsed.rows.map((r) => r.studentId) },
        },
        select: { studentId: true },
      });
      return result(
        await db.studentImport
          .create({
            data: {
              guildId,
              actorId: actor,
              rows: parsed.rows,
              errors: parsed.errors,
            },
          })
          .then((v) => ({
            ...v,
            duplicates: existing.map((s) => s.studentId),
          })),
      );
    }
    if (id === "commit") {
      const input = z
        .object({
          importId: z.string(),
          duplicates: z.enum(["skip", "update", "error"]),
        })
        .parse(await body(req));
      return result(
        await locked(guildId, async (tx) => {
          const imp = await tx.studentImport.findFirstOrThrow({
            where: { id: input.importId, guildId, actorId: actor },
          });
          if (imp.committedAt)
            throw new DomainError("IMPORT_DONE", "Import already committed.");
          if ((imp.errors as unknown[]).length)
            throw new DomainError(
              "CSV_ERRORS",
              "Fix malformed or duplicate CSV rows before import.",
              400,
            );
          const rows = z.array(studentSchema).parse(imp.rows);
          let created = 0,
            updated = 0,
            skipped = 0;
          for (const row of rows) {
            const old = await tx.student.findUnique({
              where: {
                guildId_studentId: { guildId, studentId: row.studentId },
              },
            });
            if (old) {
              if (input.duplicates === "error")
                throw new DomainError(
                  "DUPLICATE",
                  "Existing student IDs found. Select skip or update.",
                );
              if (input.duplicates === "update") {
                await tx.student.update({ where: { id: old.id }, data: row });
                updated++;
              } else skipped++;
            } else {
              await tx.student.create({ data: { guildId, ...row } });
              created++;
            }
          }
          await tx.studentImport.update({
            where: { id: imp.id },
            data: { committedAt: new Date() },
          });
          if (created || updated)
            await queueIdentityRecovery(tx, guildId, actor);
          await event(
            tx,
            guildId,
            actor,
            "students.imported",
            "Student CSV committed.",
            { created, updated, skipped },
          );
          return { created, updated, skipped };
        }),
      );
    }
    if (req.method === "DELETE")
      return result(
        await locked(guildId, async (tx) => {
          const s = await tx.student.findFirstOrThrow({
            where: { id, guildId },
          });
          if (await tx.queueTicket.count({ where: { studentId: s.id } }))
            throw new DomainError(
              "HISTORY",
              "Student has queue history. Unlink the Discord identity instead of deleting.",
            );
          await tx.student.delete({ where: { id: s.id } });
          await event(
            tx,
            guildId,
            actor,
            "student.deleted",
            "Student removed.",
            { studentId: s.studentId },
          );
          return { ok: true };
        }),
      );
    if (action === "mapping") {
      const input = z
        .object({ discordId: snowflake.nullable() })
        .parse(await body(req));
      return result(
        await locked(guildId, async (tx) => {
          const student = await tx.student.findFirstOrThrow({
            where: { id, guildId },
          });
          if (
            await tx.queueTicket.count({
              where: { studentId: id, status: { in: [...ACTIVE] } },
            })
          )
            throw new DomainError(
              "ACTIVE",
              "Resolve active tickets before identity remapping.",
            );
          const updated = await tx.student.update({
            where: { id: student.id },
            data: {
              discordId: input.discordId,
              registration: input.discordId ? "SYNC_PENDING" : "UNREGISTERED",
              syncError: null,
            },
          });
          if (input.discordId)
            await tx.serviceOperation.create({
              data: {
                guildId,
                actorId: actor,
                action: "sync_identity",
                data: { studentId: id },
              },
            });
          await event(
            tx,
            guildId,
            actor,
            "identity.remapped",
            "Student Discord mapping changed.",
            {
              studentId: id,
              previous: student.discordId,
              next: input.discordId,
            },
          );
          return updated;
        }),
      );
    }
    const input = studentSchema.parse(await body(req));
    return result(
      await locked(guildId, async (tx) => {
        if (id) await tx.student.findFirstOrThrow({ where: { id, guildId } });
        const student = id
          ? await tx.student.update({ where: { id }, data: input })
          : await tx.student.create({ data: { guildId, ...input } });
        if (!student.discordId && student.registration === "UNREGISTERED")
          await queueIdentityRecovery(tx, guildId, actor);
        await event(
          tx,
          guildId,
          actor,
          "student.saved",
          "Student record saved.",
          { studentId: student.id },
        );
        return student;
      }),
    );
  }
  if (resource === "coursework") {
    if (!write)
      return result(
        await db.coursework.findMany({
          where: { guildId },
          orderBy: { sortOrder: "asc" },
        }),
      );
    const input = courseworkSchema.parse(await body(req));
    if (input.startsAt && input.endsAt && input.startsAt >= input.endsAt)
      throw new DomainError(
        "DATES",
        "Availability end must be after start.",
        400,
      );
    return result(
      await locked(guildId, async (tx) => {
        if (id)
          await tx.coursework.findFirstOrThrow({ where: { id, guildId } });
        const c = id
          ? await tx.coursework.update({ where: { id }, data: input })
          : await tx.coursework.create({ data: { guildId, ...input } });
        await event(
          tx,
          guildId,
          actor,
          "coursework.saved",
          `${c.name} updated.`,
          { courseworkId: c.id },
        );
        return c;
      }),
    );
  }
  if (resource === "access") {
    const current = await db.guild.findUniqueOrThrow({
      where: { id: guildId },
    });
    const currentSettings = settingsSchema.parse(current.settings);
    const currentBindings = await db.channelBinding.findMany({
      where: { guildId },
    });
    const payload = write ? await body(req) : {};
    const proposed = settingsSchema.parse({
      ...currentSettings,
      ...(payload.settings
        ? accessSettings(
            settingsSchema.parse({ ...currentSettings, ...payload.settings }),
          )
        : {}),
    });
    const supplied = z
      .array(
        z.object({
          feature: z.enum(bindingFeatures),
          channelIds: z.array(snowflake).max(30),
        }),
      )
      .max(bindingFeatures.length)
      .parse(payload.bindings || currentBindings);
    if (new Set(supplied.map((b) => b.feature)).size !== supplied.length)
      throw new DomainError("BINDINGS", "Each feature must appear once.", 400);
    const selected = [
      ...currentBindings.filter(
        (b) => !supplied.some((s) => s.feature === b.feature),
      ),
      ...supplied,
    ];
    const plan = await prepareAccess(guildId, discord, proposed, selected);
    if (!write || id === "preview") return result(plan);
    if (payload.fingerprint !== plan.fingerprint)
      throw new DomainError(
        "PREVIEW_CHANGED",
        "Configuration or Discord permissions changed. Preview again before saving.",
      );
    return result(
      await locked(guildId, async (tx) => {
        const fresh = settingsSchema.parse(
          (await tx.guild.findUniqueOrThrow({ where: { id: guildId } }))
            .settings,
        );
        await tx.guild.update({
          where: { id: guildId },
          data: {
            settings: settingsSchema.parse({
              ...fresh,
              ...accessSettings(proposed),
            }) as unknown as Prisma.InputJsonValue,
          },
        });
        for (const b of selected)
          await tx.channelBinding.upsert({
            where: { guildId_feature: { guildId, feature: b.feature } },
            create: { guildId, ...b },
            update: { channelIds: b.channelIds },
          });
        const operation = await tx.serviceOperation.create({
          data: {
            guildId,
            actorId: actor,
            action: "sync_permissions",
            data: { changes: plan.changes } as unknown as Prisma.InputJsonValue,
          },
        });
        await event(
          tx,
          guildId,
          actor,
          "configuration.access_saved",
          "Roles, feature channels and approved access plan saved.",
          { operationId: operation.id },
        );
        return operation;
      }),
    );
  }
  if (resource === "room-panels") {
    if (!write)
      return result(
        await db.tARoomPanel.findMany({
          where: { guildId },
          include: { publishedPanel: true },
          orderBy: { voiceChannelId: "asc" },
        }),
      );
    if (id && action === "publish") {
      const room = await db.tARoomPanel.findFirstOrThrow({
        where: { id, guildId, enabled: true },
      });
      if (room.visibility === "FULL_INSPECTION_DETAILS") {
        z.object({ studentIdDisclosureAcknowledged: z.literal(true) }).parse(
          await body(req),
        );
        if (!room.studentIdDisclosureAcknowledged)
          throw new DomainError(
            "DISCLOSURE",
            "Confirm the disclosure policy in the room settings first.",
            400,
          );
      }
      return result(
        await mutate(guildId, actor, "room.publish", key, async (tx) => {
          const fresh = await tx.tARoomPanel.findFirstOrThrow({
            where: { id, guildId, enabled: true },
          });
          if (
            fresh.visibility !== room.visibility ||
            fresh.destinationChannelId !== room.destinationChannelId
          )
            throw new DomainError(
              "PREVIEW_CHANGED",
              "Room policy changed. Review it before republishing.",
            );
          const op = await tx.serviceOperation.create({
            data: { guildId, actorId: actor, action: "refresh_panels" },
          });
          await event(
            tx,
            guildId,
            actor,
            "panel.room_republish",
            "TA room panel republish requested.",
            {
              roomPanelId: id,
              visibility: room.visibility,
              destinationChannelId: room.destinationChannelId,
              studentIdDisclosureAcknowledged:
                room.studentIdDisclosureAcknowledged,
            },
          );
          return op;
        }),
      );
    }
    const payload = await body(req);
    const prepared = await prepareRoomPanel(guildId, payload, discord);
    if (id === "preview") {
      const state = await snapshot(guildId);
      const s = settingsSchema.parse(
        (await db.guild.findUniqueOrThrow({ where: { id: guildId } })).settings,
      );
      return result({
        ...prepared.plan,
        inspectionPreview: {
          visibility: prepared.data.visibility,
          fullStudentIds: prepared.data.visibility !== "PUBLIC",
          content: `📊・สถานะคิวปัจจุบัน\n🎟️ คิวว่าง: ${state.metrics.available} ที่\n👥 นักศึกษาที่รอคิว: ${state.metrics.waiting} คน\n🎓 ผู้ช่วยสอนที่เปิดรับคิว: ${state.metrics.activeTAs} คน\n\n🎓・กำลังตรวจงาน\n${roomCurrent(state.tickets, prepared.data.voiceChannelId, s, prepared.data.visibility !== "PUBLIC")}`,
        },
      });
    }
    if (payload.fingerprint !== prepared.plan.fingerprint)
      throw new DomainError(
        "PREVIEW_CHANGED",
        "Room configuration or permissions changed. Preview again.",
      );
    return result(
      await mutate(guildId, actor, "room.save", key, async (tx) => {
        const old = await tx.tARoomPanel.findUnique({
          where: {
            guildId_voiceChannelId: {
              guildId,
              voiceChannelId: prepared.data.voiceChannelId,
            },
          },
          include: { publishedPanel: true },
        });
        if (
          old?.publishedPanel &&
          (old.destinationChannelId !== prepared.data.destinationChannelId ||
            old.templateId !== prepared.data.templateId ||
            !prepared.data.enabled)
        ) {
          await tx.publishedPanel.update({
            where: { id: old.publishedPanel.id },
            data: { active: false },
          });
          await tx.serviceOperation.create({
            data: {
              guildId,
              actorId: actor,
              action: "retire_panel",
              data: { panelId: old.publishedPanel.id },
            },
          });
        }
        const panel = await tx.publishedPanel.upsert({
          where: {
            guildId_channelId_templateId: {
              guildId,
              channelId: prepared.data.destinationChannelId,
              templateId: prepared.data.templateId,
            },
          },
          create: {
            guildId,
            channelId: prepared.data.destinationChannelId,
            templateId: prepared.data.templateId,
            active: prepared.data.enabled,
          },
          update: { active: prepared.data.enabled },
        });
        const saved = await tx.tARoomPanel.upsert({
          where: {
            guildId_voiceChannelId: {
              guildId,
              voiceChannelId: prepared.data.voiceChannelId,
            },
          },
          create: { guildId, ...prepared.data, publishedPanelId: panel.id },
          update: { ...prepared.data, publishedPanelId: panel.id },
        });
        const fresh = settingsSchema.parse(
          (await tx.guild.findUniqueOrThrow({ where: { id: guildId } }))
            .settings,
        );
        if (
          JSON.stringify(fresh.channelVisibility) !==
          JSON.stringify(prepared.originalVisibility)
        )
          throw new DomainError(
            "PREVIEW_CHANGED",
            "Visibility settings changed during this save. Preview again.",
          );
        await tx.guild.update({
          where: { id: guildId },
          data: {
            settings: {
              ...fresh,
              channelVisibility: prepared.proposed.channelVisibility,
            } as unknown as Prisma.InputJsonValue,
          },
        });
        await tx.serviceOperation.create({
          data: {
            guildId,
            actorId: actor,
            action:
              prepared.data.visibility === "FULL_INSPECTION_DETAILS"
                ? "refresh_panels"
                : "sync_permissions",
            data: {
              changes: prepared.plan.changes,
            } as unknown as Prisma.InputJsonValue,
          },
        });
        await event(
          tx,
          guildId,
          actor,
          "configuration.room_panel",
          "TA room panel configuration saved.",
          {
            roomPanelId: saved.id,
            previousVisibility: old?.visibility || null,
            visibility: saved.visibility,
            destinationChannelId: saved.destinationChannelId,
            studentIdDisclosureAcknowledged:
              saved.studentIdDisclosureAcknowledged,
          },
        );
        return saved;
      }),
    );
  }
  if (resource === "waiting-alerts" && !write && id === "preview") {
    const state = await snapshot(guildId);
    const template = await db.embedTemplate.findFirst({
      where: { guildId, feature: "waiting_room_alert" },
      orderBy: { id: "asc" },
    });
    const document = waitingAlertTemplateSchema.parse(
      template?.document || defaults.waiting_room_alert,
    );
    const observations = await db.waitingPresence.findMany({
      where: { guildId, observedAt: { gt: new Date(Date.now() - 120000) } },
    });
    const unqueued = observations.filter(
      (p) => !state.tickets.some((t) => t.student.discordId === p.discordId),
    );
    const values = {
      "waiting.unqueued_count": unqueued.length,
      "waiting.status": "ตัวอย่างการแจ้งเตือน",
      "waiting.incident": "ตัวอย่าง",
      "voice.channel":
        [...new Set(unqueued.map((p) => `<#${p.voiceChannelId}>`))].join(
          " · ",
        ) || "ห้องรอที่กำหนด",
      "queue.active_tas": state.metrics.activeTAs,
      "queue.available_tas": state.metrics.availableTAs,
      "queue.available": state.metrics.available,
      "queue.capacity": state.metrics.capacity,
    };
    return result({
      title: resolve(document.title, values),
      description: resolve(document.description, values),
      fields: document.fields.map((f) => ({
        name: resolve(f.name, values),
        value: resolve(f.value, values),
      })),
      footer: resolve(document.footer, values),
      color: document.color,
    });
  }
  if (resource === "waiting-alerts" && !write) {
    const incidents = await db.waitingRoomAlert.findMany({
      where: { guildId },
      select: {
        startedAt: true,
        resolvedAt: true,
        notifiedAt: true,
        lastNotifiedAt: true,
        lastError: true,
      },
    });
    const operations = await db.serviceOperation.findMany({
      where: {
        guildId,
        action: { in: ["waiting_alert_check", "waiting_alert_test"] },
      },
      select: {
        id: true,
        action: true,
        status: true,
        error: true,
        createdAt: true,
        completedAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    return result({ incidents, operations });
  }
  if (resource === "waiting-alerts" && write) {
    if (!["validate", "check", "test"].includes(id))
      throw new DomainError("ACTION", "Choose validate, check or test.", 400);
    const current = settingsSchema.parse(
      (await db.guild.findUniqueOrThrow({ where: { id: guildId } })).settings,
    );
    return result(
      await mutate(
        guildId,
        actor,
        "waiting_alert_diagnostic",
        key,
        async (tx) => {
          await event(
            tx,
            guildId,
            actor,
            "waiting_alert.diagnostic_requested",
            `Waiting alert ${id} requested.`,
          );
          return tx.serviceOperation.create({
            data: {
              guildId,
              actorId: actor,
              action:
                id === "test" ? "waiting_alert_test" : "waiting_alert_check",
              data: { enabled: current.waitingRoomAlerts.enabled },
            },
          });
        },
      ),
    );
  }
  if (resource === "settings") {
    if (!write) {
      const g = await db.guild.findUniqueOrThrow({ where: { id: guildId } });
      return result(settingsSchema.parse(g.settings));
    }
    const input = settingsSchema.parse(await body(req));
    const previous = settingsSchema.parse(
      (await db.guild.findUniqueOrThrow({ where: { id: guildId } })).settings,
    );
    if (
      JSON.stringify([accessSettings(input), input.moderatorRoles]) !==
      JSON.stringify([accessSettings(previous), previous.moderatorRoles])
    )
      validateAccessRoles(
        guildId,
        input,
        (await discord(`guilds/${guildId}/roles`)) as AccessRole[],
      );
    if (
      JSON.stringify(input.waitingRoomAlerts) !==
      JSON.stringify(previous.waitingRoomAlerts)
    ) {
      const channels = (await discord(`guilds/${guildId}/channels`)) as {
        id: string;
        type: number;
      }[];
      const roles = (await discord(`guilds/${guildId}/roles`)) as {
        id: string;
      }[];
      const waiting = await db.channelBinding.findUnique({
        where: { guildId_feature: { guildId, feature: "waiting_voice" } },
      });
      if (
        input.waitingRoomAlerts.roleIds.some(
          (r) => r === guildId || !roles.some((x) => x.id === r),
        ) ||
        input.waitingRoomAlerts.waitingChannelIds.some(
          (id) =>
            !waiting?.channelIds.includes(id) ||
            !channels.some((c) => c.id === id && c.type === 2),
        ) ||
        (input.waitingRoomAlerts.channelId &&
          !channels.some(
            (c) =>
              c.id === input.waitingRoomAlerts.channelId &&
              [0, 2, 5].includes(c.type),
          ))
      )
        throw new DomainError(
          "CHANNEL",
          "Select existing guild roles, an alert channel and authorized Waiting Voice channels.",
          400,
        );
    }
    return result(
      await locked(guildId, async (tx) => {
        if (
          await tx.tASession.count({
            where: {
              guildId,
              status: { not: "COMPLETED" },
              capacity: { gt: input.maxCapacity },
            },
          })
        )
          throw new DomainError(
            "CAPACITY",
            "Maximum cannot be lower than an active session capacity.",
          );
        await tx.guild.update({
          where: { id: guildId },
          data: { settings: input as unknown as Prisma.InputJsonValue },
        });
        await event(
          tx,
          guildId,
          actor,
          "configuration.saved",
          "Guild configuration updated.",
        );
        return input;
      }),
    );
  }
  if (resource === "directory" && !write) {
    if (directoryCache && directoryCache.expires > Date.now())
      return result(directoryCache.value);
    directoryFlight ??= Promise.all([
      discord(`guilds/${guildId}/channels`),
      discord(`guilds/${guildId}/roles`),
      discord(`guilds/${guildId}/threads/active`),
    ])
      .then(([channels, roles, threads]) => {
        const value = {
          channels: [
            ...(channels as unknown[]),
            ...(threads as { threads: unknown[] }).threads,
          ],
          roles,
        };
        directoryCache = { expires: Date.now() + 30000, value };
        return value;
      })
      .finally(() => {
        directoryFlight = undefined;
      });
    return result(await directoryFlight);
  }

  if (resource === "bindings") {
    if (!write)
      return result(await db.channelBinding.findMany({ where: { guildId } }));
    const input = z
      .object({
        feature: z.enum(bindingFeatures),
        channelIds: z.array(snowflake).max(30),
      })
      .parse(await body(req));
    const channels = (
      input.channelIds.length ? await discord(`guilds/${guildId}/channels`) : []
    ) as {
      id: string;
      type: number;
    }[];
    const kinds =
      input.feature.includes("voice") || input.feature === "post_inspection"
        ? [2]
        : input.feature === "ticket_category"
          ? [4]
          : [0, 5];
    if (
      input.channelIds.some(
        (id) => !channels.some((c) => c.id === id && kinds.includes(c.type)),
      )
    )
      throw new DomainError(
        "CHANNEL",
        "Choose existing channels of the correct type.",
        400,
      );
    return result(
      await locked(guildId, async (tx) => {
        const b = await tx.channelBinding.upsert({
          where: { guildId_feature: { guildId, feature: input.feature } },
          create: { guildId, ...input },
          update: { channelIds: input.channelIds },
        });
        await event(
          tx,
          guildId,
          actor,
          "channel.bound",
          `${input.feature} channels updated.`,
          input,
        );
        await tx.serviceOperation.create({
          data: { guildId, actorId: actor, action: "validate_channels" },
        });
        return b;
      }),
    );
  }
  if (resource === "queue") {
    if (!write) return result((await snapshot(guildId)).tickets);
    if (!id) throw new DomainError("TICKET", "Choose a ticket.", 400);
    if (action === "cancel")
      return result(await cancelTicket(guildId, actor, key, id));
    if (action === "retry")
      return result(await retryMove(guildId, actor, key, id));
    if (action === "reassign")
      throw new DomainError(
        "GLOBAL_QUEUE",
        "Waiting tickets belong to the global queue. The inspecting TA is selected only by Call Next Student.",
      );
  }
  if (resource === "sessions") {
    if (!write) {
      if (id) {
        await db.tASession.findFirstOrThrow({ where: { id, guildId } });
        const before = z.coerce
          .number()
          .int()
          .positive()
          .optional()
          .parse(req.nextUrl.searchParams.get("before") || undefined);
        const tickets = await db.queueTicket.findMany({
          where: {
            guildId,
            sessionId: id,
            ...(before ? { sequence: { lt: before } } : {}),
          },
          select: {
            id: true,
            sequence: true,
            status: true,
            student: { select: { name: true, lastname: true } },
            inspection: {
              select: { completedAt: true, status: true, note: true },
            },
          },
          orderBy: { sequence: "desc" },
          take: 51,
        });
        const page = tickets.slice(0, 50);
        return result({
          tickets: page,
          next: tickets.length > 50 ? page.at(-1)!.sequence : null,
        });
      }
      const sessions = await db.tASession.findMany({
        where: { guildId },
        include: { _count: { select: { tickets: true, reservations: true } } },
        orderBy: { activatedAt: "desc" },
        take: 200,
      });
      const completed = await db.queueTicket.groupBy({
        by: ["sessionId"],
        where: {
          guildId,
          sessionId: { in: sessions.map((s) => s.id) },
          inspection: { status: "COMPLETED", completedAt: { not: null } },
        },
        _count: true,
      });
      return result(
        sessions.map((s) => ({
          ...s,
          completedCount:
            completed.find((c) => c.sessionId === s.id)?._count || 0,
        })),
      );
    }
    if (action === "settings") {
      const input = z
        .object({
          capacity: z.number().int(),
          weight: z.number().int().min(1).max(100),
          courseworkIds: z.array(z.string()).max(100),
          note: z.string().max(2000),
        })
        .parse(await body(req));
      return result(
        await mutate(guildId, actor, "session_settings", key, async (tx, s) => {
          const session = await tx.tASession.findFirstOrThrow({
            where: { id, guildId, status: { not: "COMPLETED" } },
          });
          if (input.capacity < s.minCapacity || input.capacity > s.maxCapacity)
            throw new DomainError(
              "CAPACITY",
              `Capacity must be ${s.minCapacity}–${s.maxCapacity}.`,
              400,
            );
          if (
            input.courseworkIds.length !==
            (await tx.coursework.count({
              where: {
                guildId,
                id: { in: input.courseworkIds },
                archived: false,
              },
            }))
          )
            throw new DomainError("COURSEWORK", "Choose existing coursework.");
          const saved = await tx.tASession.update({
            where: { id: session.id },
            data: input,
          });
          await event(
            tx,
            guildId,
            actor,
            "session.settings",
            "Session capacity, eligibility and weight updated.",
            { sessionId: id },
          );
          return saved;
        }),
      );
    }
    if (action === "stop")
      return result(await stopSession(guildId, actor, key, id));
    if (action === "pause" || action === "resume")
      return result(
        await locked(guildId, async (tx) => {
          const session = await tx.tASession.findFirstOrThrow({
            where: { id, guildId, status: { not: "COMPLETED" } },
          });
          const updated = await tx.tASession.update({
            where: { id: session.id },
            data: { paused: action === "pause" },
          });
          await event(
            tx,
            guildId,
            actor,
            `session.${action}`,
            `Administrator ${action}d session.`,
            { sessionId: id },
          );
          return updated;
        }),
      );
  }
  if (resource === "templates") {
    if (!write)
      return result(
        await db.embedTemplate.findMany({
          where: { guildId },
          include: { panels: true },
          orderBy: { name: "asc" },
        }),
      );
    const input = await body(req);
    if (action === "preview") {
      const t = templateSchema.parse(input.document);
      if (input.feature === "ta_room_queue_panel")
        roomPanelTemplateSchema.parse(t);
      return result(
        render(t, {
          "queue.waiting": 0,
          "queue.available": 0,
          "queue.top": "Preview uses no fabricated queue data.",
        }),
      );
    }
    if (action === "publish") {
      const requested = await db.embedTemplate.findFirstOrThrow({
        where: { id, guildId },
      });
      if (requested.feature === "ta_room_queue_panel")
        throw new DomainError(
          "ROOM_MAPPING",
          "Publish room panels from Discord Channels → TA Inspection Rooms.",
          400,
        );
      const source = await db.embedTemplate.findFirstOrThrow({
        where: { id, guildId },
      });
      if (
        ["arrival", "waiting_room_alert", "no_show_dm"].includes(source.feature)
      )
        throw new DomainError(
          "ARRIVAL",
          "Arrival notifications are sent only after a verified transfer. Save the template instead.",
          400,
        );
      const channelId = snowflake.parse(input.channelId);
      const channels = (await discord(`guilds/${guildId}/channels`)) as {
        id: string;
        type: number;
      }[];
      if (!channels.some((c) => c.id === channelId && [0, 5].includes(c.type)))
        throw new DomainError("CHANNEL", "Choose a server text channel.", 400);
      return result(
        await locked(guildId, async (tx) => {
          const t = await tx.embedTemplate.findFirstOrThrow({
            where: { id, guildId },
          });
          const panel = await tx.publishedPanel.upsert({
            where: {
              guildId_channelId_templateId: {
                guildId,
                channelId,
                templateId: t.id,
              },
            },
            create: {
              guildId,
              channelId,
              templateId: t.id,
              mode: templateSchema.parse(t.document).mode,
            },
            update: { fingerprint: null },
          });
          await tx.serviceOperation.create({
            data: { guildId, actorId: actor, action: "refresh_panels" },
          });
          await event(
            tx,
            guildId,
            actor,
            "panel.publish_requested",
            "Panel publication requested.",
            { panelId: panel.id },
          );
          return panel;
        }),
      );
    }
    if (input.document?.fallbackChannelId) {
      const fallback = snowflake.parse(input.document.fallbackChannelId);
      const channels = (await discord(`guilds/${guildId}/channels`)) as {
        id: string;
        type: number;
      }[];
      if (!channels.some((c) => c.id === fallback && [0, 5].includes(c.type)))
        throw new DomainError(
          "CHANNEL",
          "Choose an existing fallback text channel.",
          400,
        );
    }
    return result(
      await locked(guildId, async (tx) => {
        const old = id
          ? await tx.embedTemplate.findFirstOrThrow({ where: { id, guildId } })
          : null;
        if (action === "duplicate" && old) {
          const copy = await tx.embedTemplate.create({
            data: {
              guildId,
              feature: old.feature,
              name: `${old.name} copy`,
              document: old.document as Prisma.InputJsonValue,
            },
          });
          await event(
            tx,
            guildId,
            actor,
            "template.duplicated",
            "Template copied.",
            { templateId: copy.id },
          );
          return copy;
        }
        const feature = z
          .enum([
            "registration",
            "student_queue",
            "public_queue",
            "ta_dashboard",
            "support",
            "ranking",
            "summary",
            "student_ranking",
            "system_status",
            "arrival",
            "ta_room_queue_panel",
            "waiting_room_alert",
            "no_show_dm",
          ])
          .parse(input.feature || old?.feature);
        let doc = action === "reset" ? defaults[feature] : input.document;
        if (action === "restore" && old) {
          const versions = old.versions as {
            version: number;
            document: unknown;
          }[];
          doc = versions.find(
            (v) => v.version === Number(input.version),
          )?.document;
          if (!doc) throw new DomainError("VERSION", "Version not found.", 404);
        }
        const document = templateSchema.parse(normalizeActions(doc));
        if (
          feature === "no_show_dm" &&
          (document.buttons.length || document.courseworkSelect)
        )
          throw new DomainError(
            "TEMPLATE",
            "No Show DM cannot contain interactive controls.",
            400,
          );
        if (feature === "arrival") arrivalTemplateSchema.parse(document);
        if (feature === "waiting_room_alert")
          waitingAlertTemplateSchema.parse(document);
        if (feature === "ta_room_queue_panel")
          roomPanelTemplateSchema.parse(document);
        const allowed = panelActions(feature).map((b) => b.action);
        if (
          document.buttons.some((b) => !allowed.includes(b.action)) ||
          (document.courseworkSelect && feature !== "student_queue")
        )
          throw new DomainError(
            "ACTION",
            "Action is not supported for this panel.",
            400,
          );
        const history = old
          ? [
              ...(old.versions as Prisma.JsonArray),
              { version: old.version, document: old.document },
            ].slice(-30)
          : [];
        const saved = old
          ? await tx.embedTemplate.update({
              where: { id: old.id },
              data: {
                name: z
                  .string()
                  .min(1)
                  .max(100)
                  .parse(input.name || old.name),
                document: document as unknown as Prisma.InputJsonValue,
                version: { increment: 1 },
                versions: history as Prisma.InputJsonArray,
              },
            })
          : await tx.embedTemplate.create({
              data: {
                guildId,
                feature,
                name: document.title,
                document: document as unknown as Prisma.InputJsonValue,
              },
            });
        await event(
          tx,
          guildId,
          actor,
          "template.saved",
          "Panel template saved.",
          { templateId: saved.id, version: saved.version },
        );
        return saved;
      }),
    );
  }
  if (resource === "support") {
    if (!write)
      return result(
        await db.supportTicket.findMany({
          where: { guildId },
          include: { events: true },
          orderBy: { createdAt: "desc" },
          take: 200,
        }),
      );
    const input = z
      .object({
        action: z.enum([
          "claim",
          "close",
          "reopen",
          "escalate",
          "assign",
          "reply",
          "retry_cleanup",
        ]),
        assignedId: snowflake.optional(),
        note: z.string().max(2000).default(""),
      })
      .parse(await body(req));
    return result(
      await mutate(guildId, actor, "support_operation", key, async (tx) => {
        await tx.supportTicket.findFirstOrThrow({ where: { id, guildId } });
        return tx.serviceOperation.create({
          data: {
            guildId,
            actorId: actor,
            action: "support_action",
            data: { ticketId: id, ...input },
          },
        });
      }),
    );
  }
  if (resource === "inspections") {
    if (!write)
      return result(
        await db.inspection.findMany({
          where: { ticket: { guildId }, completedAt: { not: null } },
          include: {
            ticket: {
              include: { student: true, coursework: true, session: true },
            },
          },
          orderBy: { completedAt: "desc" },
          take: 200,
        }),
      );
    const input = z
      .object({
        completedAt: z.string().datetime(),
        note: z.string().trim().min(1).max(2000),
        voided: z.boolean(),
      })
      .parse(await body(req));
    return result(
      await locked(guildId, async (tx) => {
        const old = await tx.inspection.findFirstOrThrow({
          where: {
            id,
            ticket: { guildId, status: "COMPLETED" },
            completedAt: { not: null },
          },
        });
        const completedAt = new Date(input.completedAt);
        if (completedAt < old.startedAt || completedAt > new Date())
          throw new DomainError(
            "TIME",
            "Completion must be between inspection start and now.",
            400,
          );
        const updated = await tx.inspection.update({
          where: { id: old.id },
          data: {
            completedAt,
            durationSeconds: Math.floor(
              (completedAt.getTime() - old.startedAt.getTime()) / 1000,
            ),
            note: input.note,
            voided: input.voided,
            completionReason: "ADMIN_CORRECTION",
          },
        });
        await event(
          tx,
          guildId,
          actor,
          "inspection.corrected",
          "Administrator corrected an inspection record.",
          { inspectionId: id, before: old, after: updated },
        );
        return updated;
      }),
    );
  }
  if (resource === "analytics" && !write) {
    const from = req.nextUrl.searchParams.get("from");
    const to = req.nextUrl.searchParams.get("to");
    const reportingGuild = await db.guild.findUniqueOrThrow({
      where: { id: guildId },
    });
    const timezone = settingsSchema.parse(reportingGuild.settings).timezone;
    const range = analyticsWindow(from, to, timezone);
    if (
      reportingGuild.analyticsSince &&
      (!range.gte || range.gte < reportingGuild.analyticsSince)
    )
      range.gte = reportingGuild.analyticsSince;
    const rankingSince = [
      reportingGuild.analyticsSince,
      reportingGuild.rankingsSince,
      range.gte,
    ]
      .filter((v): v is Date => !!v)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    const rankingWithin = (time: Date) =>
      (!rankingSince || time >= rankingSince) && (!range.lt || time < range.lt);
    const within = (time: Date) =>
      (!range.gte || time >= range.gte) && (!range.lt || time < range.lt);
    const tickets = await db.queueTicket.findMany({
      where: {
        guildId,
        ...(range.gte || range.lt
          ? {
              OR: [
                { createdAt: range },
                { inspection: { completedAt: range } },
              ],
            }
          : {}),
      },
      select: {
        studentId: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        inspection: {
          select: {
            status: true,
            completedAt: true,
            startedAt: true,
            voided: true,
            taId: true,
            assisted: true,
          },
        },
        student: { select: { name: true, lastname: true } },
        session: { select: { taName: true } },
        coursework: { select: { name: true } },
      },
      orderBy: { sequence: "asc" },
    });
    const tas = new Map<
      string,
      {
        taId: string;
        name: string;
        completed: number;
        noShows: number;
        students: Set<string>;
        duration: number;
        assisted: number;
        courses: Set<string>;
      }
    >();
    const students = new Map<
      string,
      {
        id: string;
        name: string;
        tickets: number;
        completed: number;
        cancelled: number;
        noShows: number;
        lastInspection: string | null;
      }
    >();
    const courses: Record<string, number> = {};
    const days: Record<
      string,
      { date: string; admitted: number; completed: number }
    > = {};
    let wait = 0,
      completed = 0,
      admitted = 0;
    const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
    for (const t of tickets) {
      const admissionInRange = within(t.createdAt);
      if (admissionInRange) {
        admitted++;
        const day = formatter.format(t.createdAt);
        days[day] ??= { date: day, admitted: 0, completed: 0 };
        days[day].admitted++;
        courses[t.coursework.name] = (courses[t.coursework.name] || 0) + 1;
      }
      const st = students.get(t.studentId) || {
        id: t.studentId,
        name: `${t.student.name} ${t.student.lastname}`,
        tickets: 0,
        completed: 0,
        cancelled: 0,
        noShows: 0,
        lastInspection: null,
      };
      st.tickets += Number(rankingWithin(t.createdAt));
      st.cancelled += Number(
        rankingWithin(t.createdAt) && t.status === "CANCELLED",
      );
      const noShowAt = t.inspection?.completedAt || t.updatedAt;
      st.noShows += Number(
        rankingWithin(noShowAt) &&
          t.status === "NO_SHOW" &&
          !t.inspection?.voided,
      );
      if (
        t.inspection?.status === "NO_SHOW" &&
        !t.inspection.voided &&
        t.inspection.completedAt &&
        rankingWithin(noShowAt)
      ) {
        const ta = tas.get(t.inspection.taId) || {
          taId: t.inspection.taId,
          name: t.session?.taName || "TA",
          completed: 0,
          noShows: 0,
          students: new Set<string>(),
          duration: 0,
          assisted: 0,
          courses: new Set<string>(),
        };
        ta.noShows++;
        tas.set(ta.taId, ta);
      }
      if (
        t.inspection?.completedAt &&
        !t.inspection.voided &&
        t.inspection.status === "COMPLETED" &&
        within(t.inspection.completedAt)
      ) {
        const i = t.inspection;
        if (rankingWithin(i.completedAt!)) {
          const ta = tas.get(i.taId) || {
            taId: i.taId,
            name: t.session?.taName || "Unclaimed",
            completed: 0,
            noShows: 0,
            students: new Set<string>(),
            duration: 0,
            assisted: 0,
            courses: new Set<string>(),
          };
          ta.completed++;
          ta.students.add(t.studentId);
          ta.duration += i.completedAt!.getTime() - i.startedAt.getTime();
          ta.assisted += Number(i.assisted);
          ta.courses.add(t.coursework.name);
          tas.set(i.taId, ta);
          st.completed++;
          st.lastInspection = i.completedAt!.toISOString();
        }
        completed++;
        const completionDay = formatter.format(i.completedAt!);
        days[completionDay] ??= {
          date: completionDay,
          admitted: 0,
          completed: 0,
        };
        days[completionDay].completed++;
        wait += i.startedAt.getTime() - t.createdAt.getTime();
      }
      students.set(t.studentId, st);
    }
    const data = {
      totalTickets: admitted,
      completed,
      averageWaitSeconds: completed
        ? Math.round(wait / completed / 1000)
        : null,
      taRanking: [...tas.values()]
        .map((t) => ({
          ...t,
          students: t.students.size,
          courses: [...t.courses],
          durationSeconds: Math.round(t.duration / 1000),
          averageSeconds: t.completed
            ? Math.round(t.duration / 1000 / t.completed)
            : 0,
        }))
        .sort(
          (a, b) => b.completed - a.completed || a.taId.localeCompare(b.taId),
        ),
      studentRanking: [...students.values()]
        .filter((s) => s.tickets || s.completed)
        .sort((a, b) => b.completed - a.completed || a.id.localeCompare(b.id)),
      activity: Object.values(days).sort((a, b) =>
        a.date.localeCompare(b.date),
      ),
      courses: Object.entries(courses).map(([name, count]) => ({
        name,
        count,
      })),
    };
    if (id === "export") {
      const { stringify } = await import("csv-stringify/sync");
      const { safeCsvCell } =
        await import("../../../../../packages/shared/src/index");
      return new Response(
        stringify(
          data.taRanking.map((t) => ({
            name: safeCsvCell(t.name),
            completed: t.completed,
            noShows: t.noShows,
            uniqueStudents: t.students,
            durationSeconds: t.durationSeconds,
            assisted: t.assisted,
          })),
          { header: true },
        ),
        {
          headers: {
            "Content-Type": "text/csv",
            "Content-Disposition": 'attachment; filename="ta-rankings.csv"',
          },
        },
      );
    }
    return result(data);
  }
  if (resource === "logs" && id === "runtime" && !write) {
    if (!["OWNER", "ADMIN"].includes(auth.admin.role))
      throw new DomainError(
        "FORBIDDEN",
        "Only administrators can read detailed runtime logs.",
        403,
      );
    return result(await runtimeLogs());
  }
  if (resource === "logs" && !write)
    return result(
      await db.systemEvent.findMany({
        where: { guildId },
        orderBy: { id: "desc" },
        take: 500,
      }),
    );
  if (resource === "operations") {
    if (!write)
      return result(
        await db.serviceOperation.findMany({
          where: { guildId },
          orderBy: { createdAt: "desc" },
          take: 100,
        }),
      );
    if (id && action === "retry") {
      return result(
        await locked(guildId, async (tx) => {
          const old = await tx.serviceOperation.findFirstOrThrow({
            where: { id, guildId, status: "FAILED" },
          });
          if (
            ["restart_bot", "restart_worker", "backup"].includes(old.action) &&
            auth.admin.role !== "OWNER"
          )
            throw new DomainError(
              "OWNER",
              "Only owners can retry this operation.",
              403,
            );
          const next = await tx.serviceOperation.create({
            data: {
              guildId,
              actorId: actor,
              action: old.action,
              data: old.data as Prisma.InputJsonValue,
            },
          });
          await event(
            tx,
            guildId,
            actor,
            "operation.retried",
            "Failed operation queued for retry.",
            { previous: id, next: next.id },
          );
          return next;
        }),
      );
    }
    const input = z
      .object({ action: z.enum(operations) })
      .parse(await body(req));
    if (input.action === "integrity_check") {
      const report = await integrity(guildId);
      await locked(guildId, (tx) =>
        event(
          tx,
          guildId,
          actor,
          "queue.integrity",
          "Queue integrity checked.",
          report,
        ),
      );
      return result(report);
    }
    if (
      input.action === "backup" ||
      (input.action.startsWith("restart_") && input.action !== "restart_sync")
    ) {
      if (auth.admin.role !== "OWNER")
        throw new DomainError(
          "OWNER",
          "Only an owner can control services or create backups.",
          403,
        );
      if (env().SERVICE_CONTROL_ENABLED !== "true")
        throw new DomainError(
          "DISABLED",
          "Enable the restricted operations supervisor to restart processes or create backups.",
          409,
        );
    }
    return result(
      await mutate(guildId, actor, "operation", key, async (tx) => {
        const op = await tx.serviceOperation.create({
          data: { guildId, actorId: actor, action: input.action },
        });
        await event(
          tx,
          guildId,
          actor,
          "operation.requested",
          `Requested ${input.action}.`,
          { operationId: op.id },
        );
        return op;
      }),
    );
  }
  if (resource === "configuration" && !write) {
    const guild = await db.guild.findUniqueOrThrow({ where: { id: guildId } });
    return result({
      version: 1,
      settings: guild.settings,
      bindings: await db.channelBinding.findMany({ where: { guildId } }),
      templates: await db.embedTemplate.findMany({
        where: { guildId },
        select: { name: true, feature: true, document: true },
      }),
    });
  }
  if (resource === "configuration" && write) {
    const input = z
      .object({
        version: z.literal(1),
        settings: settingsSchema,
        templates: z
          .array(
            z.object({
              name: z.string().max(100),
              feature: z.enum([
                "registration",
                "student_queue",
                "public_queue",
                "ta_dashboard",
                "support",
                "ranking",
                "summary",
                "student_ranking",
                "system_status",
                "arrival",
                "ta_room_queue_panel",
              ]),
              document: templateSchema,
            }),
          )
          .max(100),
      })
      .parse(await body(req));
    for (const template of input.templates) {
      if (template.feature === "arrival")
        arrivalTemplateSchema.parse(template.document);
      if (template.feature === "ta_room_queue_panel")
        roomPanelTemplateSchema.parse(template.document);
    }
    return result(
      await locked(guildId, async (tx) => {
        await tx.guild.update({
          where: { id: guildId },
          data: {
            settings: input.settings as unknown as Prisma.InputJsonValue,
          },
        });
        for (const t of input.templates)
          await tx.embedTemplate.create({
            data: {
              guildId,
              ...t,
              document: t.document as unknown as Prisma.InputJsonValue,
            },
          });
        await event(
          tx,
          guildId,
          actor,
          "configuration.imported",
          "Settings and templates imported. Channel bindings require validation and are configured separately.",
        );
        return { ok: true };
      }),
    );
  }
  if (resource === "accounts") {
    if (auth.admin.role !== "OWNER")
      throw new DomainError("OWNER", "Only owners can manage accounts.", 403);
    if (!write)
      return result(
        await db.adminUser.findMany({
          select: {
            id: true,
            username: true,
            role: true,
            disabled: true,
            createdAt: true,
          },
        }),
      );
    const input = z
      .object({
        username: z.string().regex(/^[a-zA-Z0-9_.-]{3,64}$/),
        password: z.string().min(14).max(256).optional(),
        role: z.enum(["OWNER", "ADMIN", "OPERATOR", "VIEWER"]),
        disabled: z.boolean().default(false),
      })
      .parse(await body(req));
    return result(
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(1800541)::text`;
        if (id === actor && (input.disabled || input.role !== "OWNER"))
          throw new DomainError(
            "SELF",
            "You cannot disable or demote your own owner account.",
          );
        const hash = input.password
          ? await passwordHash(input.password)
          : undefined;
        if (!id && !hash)
          throw new DomainError(
            "PASSWORD",
            "Set a password for the new account.",
            400,
          );
        const user = id
          ? await tx.adminUser.update({
              where: { id },
              data: {
                username: input.username,
                role: input.role,
                disabled: input.disabled,
                ...(hash ? { passwordHash: hash } : {}),
              },
            })
          : await tx.adminUser.create({
              data: {
                username: input.username,
                role: input.role,
                passwordHash: hash!,
              },
            });
        if (id) await tx.adminSession.deleteMany({ where: { adminId: id } });
        await event(
          tx,
          guildId,
          actor,
          "account.saved",
          "Administrator account saved; existing sessions revoked.",
          { adminId: user.id },
        );
        return { id: user.id, username: user.username, role: user.role };
      }),
    );
  }
  throw new DomainError("NOT_FOUND", "Action or page not found.", 404);
}
async function handle(
  req: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  try {
    const path = (await context.params).path[0];
    const known = [
      "login",
      "me",
      "logout",
      "overview",
      "health",
      "students",
      "coursework",
      "settings",
      "bindings",
      "queue",
      "sessions",
      "templates",
      "support",
      "analytics",
      "logs",
      "operations",
      "events",
      "room-panels",
      "waiting-alerts",
      "performance",
    ];
    return await measure(`api.${known.includes(path) ? path : "other"}`, () =>
      route(req, context),
    );
  } catch (error) {
    if (error instanceof DomainError)
      return result({ error: error.message, code: error.code }, error.status);
    if (error instanceof z.ZodError)
      return result(
        {
          error: error.issues
            .map((e) => `${e.path.join(".")}: ${e.message}`)
            .join("; "),
          code: "VALIDATION",
        },
        400,
      );
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2025")
        return result(
          { error: "Record not found or no longer available." },
          404,
        );
      if (error.code === "P2002")
        return result(
          { error: "This record or identity already exists." },
          409,
        );
    }
    const correlationId = randomUUID();
    logger.error({ err: error, correlationId }, "Admin API failed");
    return result(
      {
        error: "Operation failed. Check service health and logs, then retry.",
        correlationId,
      },
      500,
    );
  }
}
export { handle as GET, handle as POST, handle as PUT, handle as DELETE };
