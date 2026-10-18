import { expect, test } from "vitest";
import { settingsSchema } from "../packages/shared/src/index";
import {
  queueIdentity,
  queueTop,
  roomCurrent,
  roomCurrentValues,
} from "../packages/discord-ui/src/queue-display";
import {
  defaults,
  render,
  templateSchema,
  roomPanelTemplateSchema,
  thaiDateTime,
  discordText,
} from "../packages/discord-ui/src/index";
const settings = settingsSchema.parse({});
const student = {
  studentId: "065010001",
  name: "สมชาย",
  lastname: "ใจดี",
  registration: "REGISTERED",
  discordId: "100000000000000020",
};
const ticket = {
  sequence: 8,
  student,
  coursework: { name: "TEST" },
  status: "CLAIMED",
  session: { voiceChannelId: "room-a", taName: "TA A" },
};

test("queue identity preserves leading zeros, masks public IDs, escapes mentions and never shows internal account IDs", () => {
  expect(queueIdentity(student, settings, true)).toBe("065010001 สมชาย ใจดี");
  expect(queueIdentity(student, settings, false)).toBe("นักศึกษา");
  expect(
    queueIdentity(
      student,
      { ...settings, publicStudentNames: true, publicStudentIds: "MASKED" },
      false,
    ),
  ).toBe("•••••0001 สมชาย ใจดี");
  expect(
    queueIdentity(
      {
        ...student,
        name: "@everyone",
        studentId: "discord-123",
        registration: "ROLE_ONLY",
      },
      settings,
      true,
    ),
  ).not.toContain("discord-123");
  expect(queueIdentity({}, settings, true)).toBe("นักศึกษา");
  const text = queueTop([{ ...ticket, sequence: 9 }, ticket], settings, true);
  expect(text.split("\n")[0]).toBe("1. 065010001 สมชาย ใจดี — TEST");
  expect(text).not.toContain("TA A");
  expect(
    queueTop([ticket], { ...settings, queueShowCoursework: false }, true),
  ).not.toContain("TEST");
});

test("room display isolates concurrent inspectors and clears terminal students", () => {
  const tickets = [
    ticket,
    {
      ...ticket,
      sequence: 9,
      status: "IN_PROGRESS",
      session: { voiceChannelId: "room-b", taName: "TA B" },
    },
  ];
  expect(roomCurrent(tickets, "room-a", settings, true)).toContain(
    "กำลังเรียกนักศึกษา",
  );
  expect(roomCurrent(tickets, "room-a", settings, true)).not.toContain("TA B");
  expect(roomCurrent(tickets, "room-b", settings, true)).toContain(
    "กำลังตรวจงาน",
  );
  expect(
    roomCurrent([{ ...ticket, status: "COMPLETED" }], "room-a", settings, true),
  ).toBe("ขณะนี้ไม่มีนักศึกษากำลังตรวจงาน");
  expect(roomCurrent(tickets, "room-a", settings, false)).not.toContain(
    student.studentId,
  );
  const layout = {
    overview: true,
    waiting: true,
    current: true,
    coursework: false,
    number: false,
    ta: false,
    status: false,
  };
  const text = roomCurrent(tickets, "room-a", settings, true, layout);
  expect(text).not.toMatch(/TEST|#8|TA A|สถานะ/);
});

test("new room sections can be hidden in EMBED and V2 without replacing a custom template", () => {
  const layout = {
    overview: false,
    waiting: false,
    current: true,
    coursework: true,
    number: true,
    ta: true,
    status: true,
  };
  for (const mode of ["EMBED", "V2"] as const) {
    const rendered = JSON.stringify(
      render(
        { ...defaults.ta_room_queue_panel, mode, roomLayout: layout },
        {
          "queue.overview": "PRIVATE OVERVIEW",
          "queue.top": "PRIVATE WAITING",
          "room.current": "นักศึกษากำลังตรวจงาน",
        },
      ),
    );
    expect(rendered).not.toMatch(/PRIVATE OVERVIEW|PRIVATE WAITING/);
    expect(rendered).toContain("นักศึกษากำลังตรวจงาน");
  }
  const custom = {
    ...defaults.ta_room_queue_panel,
    title: "Custom",
    fields: [],
    description: "Custom text",
  };
  expect(templateSchema.parse(custom).roomLayout).toBeUndefined();
  expect(render(custom, {}).embeds?.[0].description).toBe("Custom text");
});

test("ticket response uses Thai Buddhist date and Bangkok time without internal FIFO notes", () => {
  expect(thaiDateTime("2026-10-14T11:28:00Z")).toBe(
    "14 ต.ค. 2569 เวลา 18:28 น.",
  );
  expect(thaiDateTime("2026-10-14T18:30:00Z")).toBe(
    "15 ต.ค. 2569 เวลา 01:30 น.",
  );
  const response = discordText("admitted", {
    number: 12,
    name: "สมชาย ใจดี",
    course: "TEST",
    position: 1,
    created: thaiDateTime("2026-10-14T11:28:00Z"),
    status: "กำลังรอเรียก",
  });
  expect(response).toContain("รับบัตรคิวสำเร็จ");
  expect(response).not.toMatch(/<t:|October|คิวกลาง|ผู้ตรวจจะถูกกำหนด/);
});

test("current inspection separates verified Student ID from name and ticket; missing identities never generate an ID", () => {
  const active = { ...ticket, status: "IN_PROGRESS" };
  expect(roomCurrent([active], "room-a", settings, true)).toBe(
    "🪪 รหัสนักศึกษา: 065010001\n👤 ชื่อ–นามสกุล: สมชาย ใจดี\n📚 งานที่ตรวจ: TEST\n🎫 หมายเลขคิว: #8\n👨‍🏫 ผู้ตรวจ: TA A\n🟢 สถานะ: กำลังตรวจงาน",
  );
  expect(roomCurrentValues([active], "room-a", settings, true)).toMatchObject({
    "room.current.student_id": "065010001",
    "room.current.ticket": "#8",
    "room.current.student_name": "สมชาย ใจดี",
  });
  for (const missing of [
    { studentId: "" },
    { discordId: null },
    { registration: "UNREGISTERED" },
    { registration: "ROLE_ONLY", studentId: "discord-123" },
  ]) {
    expect(
      roomCurrentValues(
        [{ ...active, student: { ...student, ...missing } }],
        "room-a",
        settings,
        true,
      )["room.current.student_id"],
    ).toBe("ไม่พบรหัสนักศึกษา");
  }
  expect(
    roomCurrentValues([active], "other-room", settings, true)[
      "room.current.student_id"
    ],
  ).toBe("—");
  expect(
    roomCurrentValues(
      [{ ...active, inspection: { voiceChannelId: "actual-room" } }],
      "room-a",
      settings,
      true,
    )["room.current.student_id"],
  ).toBe("—");
});

test("individual room placeholders work in existing embeds and V2 and never disclose full IDs publicly", () => {
  const active = { ...ticket, status: "IN_PROGRESS" };
  for (const mode of ["EMBED", "V2"] as const) {
    const custom = {
      ...defaults.ta_room_queue_panel,
      mode,
      fields: [
        {
          name: "Current",
          value:
            "{room.current.student_id} | {room.current.student_name} | {room.current.coursework} | {room.current.ticket} | {room.current.ta} | {room.current.status}",
        },
      ],
    };
    expect(() => roomPanelTemplateSchema.parse(custom)).not.toThrow();
    expect(() =>
      roomPanelTemplateSchema.parse({
        ...custom,
        description: "{room.current.unknown}",
      }),
    ).toThrow();
    const values = roomCurrentValues([active], "room-a", settings, true);
    expect(JSON.stringify(render(custom, values))).toContain(
      "065010001 | สมชาย ใจดี | TEST | #8 | TA A | กำลังตรวจงาน",
    );
    expect(
      JSON.stringify(
        render(
          {
            ...custom,
            roomLayout: {
              ...defaults.ta_room_queue_panel.roomLayout!,
              current: false,
            },
          },
          values,
        ),
      ),
    ).not.toContain("065010001");
    for (const publicStudentIds of ["HIDDEN", "MASKED", "FULL"] as const) {
      const config = { ...settings, publicStudentIds };
      expect(
        JSON.stringify(
          render(custom, roomCurrentValues([active], "room-a", config, false)),
        ),
      ).not.toContain("065010001");
      expect(roomCurrent([active], "room-a", config, false)).not.toContain(
        "065010001",
      );
    }
  }
});

test("masked public queue entries never reveal short registered IDs in full", () => {
  for (const studentId of ["1", "01", "001", "0001", "00001"]) {
    const masked = queueIdentity(
      { ...student, studentId },
      { ...settings, publicStudentIds: "MASKED" },
      false,
    );
    expect(masked).not.toContain(studentId);
    expect(masked).toContain("•");
  }
});
