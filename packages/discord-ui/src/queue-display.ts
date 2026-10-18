import { escapeMarkdown } from "discord.js";
import { Settings } from "../../shared/src/index";
import { th, discordStatus } from "../../shared/src/discord-locale";
import { roomCurrentFields, type Template } from "./index";

type Student = {
  studentId?: string | null;
  name?: string | null;
  lastname?: string | null;
  registration?: string;
  discordId?: string | null;
};
type Ticket = {
  sequence: number;
  status: string;
  student: Student;
  coursework: { name: string };
  session: { voiceChannelId: string; taName: string } | null;
  inspection?: { voiceChannelId?: string | null } | null;
};
const safe = (text: string) => escapeMarkdown(text).replaceAll("@", "＠");

export function queueIdentity(
  student: Student,
  settings: Settings,
  authorized: boolean,
) {
  const name =
    authorized || settings.publicStudentNames
      ? [
          student.name,
          student.registration === "ROLE_ONLY" ? "" : student.lastname,
        ]
          .filter(Boolean)
          .join(" ")
          .trim()
      : "";
  const id =
    student.registration === "ROLE_ONLY" ||
    student.studentId?.startsWith("discord-")
      ? ""
      : student.studentId || "";
  const visibleId =
    authorized || settings.publicStudentIds === "FULL"
      ? id
      : settings.publicStudentIds === "MASKED" && id
        ? `${"•".repeat(Math.max(1, id.length - 4))}${id.length > 4 ? id.slice(-4) : ""}`
        : "";
  return safe([visibleId, name].filter(Boolean).join(" ") || th.student);
}

export function queueTop(
  tickets: Ticket[],
  settings: Settings,
  authorized: boolean,
) {
  return (
    [...tickets]
      .sort((a, b) => a.sequence - b.sequence)
      .slice(0, 10)
      .map(
        (t, i) =>
          `${i + 1}. ${queueIdentity(t.student, settings, authorized)}${settings.queueShowCoursework ? ` — ${safe(t.coursework.name)}` : ""}`,
      )
      .join("\n") || th.noWaiting
  );
}

function currentTickets(tickets: Ticket[], voiceChannelId: string) {
  return tickets
    .filter(
      (t) =>
        (t.inspection?.voiceChannelId || t.session?.voiceChannelId) ===
          voiceChannelId &&
        [
          "CLAIMED",
          "MOVING",
          "IN_PROGRESS",
          "MOVE_FAILED",
          "NEEDS_REVIEW",
        ].includes(t.status),
    )
    .sort((a, b) => a.sequence - b.sequence);
}

function currentFields(
  ticket: Ticket,
  settings: Settings,
  authorized: boolean,
  layout?: Template["roomLayout"],
) {
  const student = ticket.student;
  const id =
    student.registration === "REGISTERED" &&
    student.discordId &&
    student.studentId?.trim() &&
    !student.studentId.startsWith("discord-")
      ? student.studentId
      : "";
  return {
    student_id: !id
      ? "ไม่พบรหัสนักศึกษา"
      : authorized
        ? safe(id)
        : settings.publicStudentIds === "MASKED"
          ? safe(
              `${"•".repeat(Math.max(1, id.length - 4))}${id.length > 4 ? id.slice(-4) : ""}`,
            )
          : "ซ่อนรหัสในช่องสาธารณะ",
    student_name: queueIdentity(
      { ...student, studentId: null },
      settings,
      authorized,
    ),
    coursework:
      layout?.coursework !== false ? safe(ticket.coursework.name) : "",
    ticket: layout?.number !== false ? `#${ticket.sequence}` : "",
    ta: layout?.ta !== false ? safe(ticket.session?.taName || "—") : "",
    status: layout?.status !== false ? discordStatus(ticket.status) : "",
  };
}

export function roomCurrentValues(
  tickets: Ticket[],
  voiceChannelId: string,
  settings: Settings,
  authorized: boolean,
  layout?: Template["roomLayout"],
) {
  const current = currentTickets(tickets, voiceChannelId).map((t) =>
    currentFields(t, settings, authorized, layout),
  );
  return Object.fromEntries(
    roomCurrentFields.map((field) => [
      `room.current.${field}`,
      layout?.current === false
        ? ""
        : current.length
          ? current.map((t) => t[field]).join("\n")
          : "—",
    ]),
  );
}

export function roomCurrent(
  tickets: Ticket[],
  voiceChannelId: string,
  settings: Settings,
  authorized: boolean,
  layout?: Template["roomLayout"],
) {
  return (
    currentTickets(tickets, voiceChannelId)
      .map((t) => {
        const fields = currentFields(t, settings, authorized, layout);
        return [
          `🪪 รหัสนักศึกษา: ${fields.student_id}`,
          `👤 ชื่อ–นามสกุล: ${fields.student_name}`,
          fields.coursework ? `📚 งานที่ตรวจ: ${fields.coursework}` : "",
          fields.ticket ? `🎫 หมายเลขคิว: ${fields.ticket}` : "",
          fields.ta ? `👨‍🏫 ผู้ตรวจ: ${fields.ta}` : "",
          fields.status
            ? `${t.status === "IN_PROGRESS" ? "🟢" : "🟡"} สถานะ: ${fields.status}`
            : "",
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n\n") || "ขณะนี้ไม่มีนักศึกษากำลังตรวจงาน"
  );
}
