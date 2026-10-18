import { z } from "zod";
import { th, thaiPanels } from "../../shared/src/discord-locale";
export {
  th,
  discordText,
  discordStatus,
  discordError,
  thaiDateTime,
} from "../../shared/src/discord-locale";
import {
  actionSchema,
  DomainError,
  snowflake,
  taRoomActions,
} from "../../shared/src/index";
export const roomCurrentFields = [
  "student_id",
  "student_name",
  "coursework",
  "ticket",
  "ta",
  "status",
] as const;
const media = z.union([z.literal(""), z.string().url().startsWith("https://")]);
export const placeholders = [
  "queue.total",
  "queue.waiting",
  "queue.available",
  "queue.capacity",
  "queue.draining",
  "queue.active_tas",
  "queue.in_progress",
  "queue.top",
  "queue.overview",
  "room.current",
  ...roomCurrentFields.map((field) => `room.current.${field}` as const),
  "room.status",
  "queue.available_tas",
  "queue.current",
  "queue.warnings",
  "waiting.unqueued_count",
  "waiting.status",
  "waiting.incident",
  "ta.table",
  "ta.name",
  "ta.capacity",
  "ta.current_student",
  "student.name",
  "student.position",
  "coursework.name",
  "ticket.id",
  "queue.number",
  "student.id",
  "student.mention",
  "ta.mention",
  "voice.channel",
  "ranking.ta",
  "ranking.student",
  "support.open",
  "support.closing",
  "support.closed",
  "system.bot",
  "system.worker",
] as const;
export const templateSchema = z
  .object({
    mode: z.enum(["EMBED", "V2"]).default("EMBED"),
    title: z.string().max(256),
    description: z.string().max(4000),
    color: z
      .string()
      .regex(/^#[a-fA-F0-9]{6}$/)
      .default("#7879F1"),
    footer: z.string().max(2048).default(th.footer),
    author: z.string().max(256).default(""),
    thumbnail: media.default(""),
    image: media.default(""),
    fields: z
      .array(
        z.object({
          name: z.string().min(1).max(256),
          value: z.string().min(1).max(1024),
          inline: z.boolean().default(false),
        }),
      )
      .max(25)
      .default([]),
    buttons: z
      .array(
        z.object({
          action: actionSchema,
          label: z.string().min(1).max(80),
          style: z
            .enum(["Primary", "Secondary", "Success", "Danger"])
            .default("Secondary"),
          emoji: z.string().max(50).default(""),
          disabled: z.boolean().default(false),
          visible: z.boolean().default(true),
        }),
      )
      .max(20)
      .default([]),
    courseworkSelect: z.boolean().default(false),
    notificationEnabled: z.boolean().default(true),
    fallbackChannelId: z.union([snowflake, z.literal("")]).default(""),
    includeStudentId: z.boolean().default(false),
    roomLayout: z
      .object({
        overview: z.boolean().default(true),
        waiting: z.boolean().default(true),
        current: z.boolean().default(true),
        coursework: z.boolean().default(true),
        number: z.boolean().default(true),
        ta: z.boolean().default(true),
        status: z.boolean().default(true),
      })
      .optional(),
  })
  .superRefine((v, ctx) => {
    const texts = [
      v.title,
      v.description,
      v.footer,
      v.author,
      ...v.fields.flatMap((f) => [f.name, f.value]),
    ];
    if (texts.join("").length > 6000)
      ctx.addIssue({
        code: "custom",
        message: "Combined embed text exceeds 6,000 characters.",
      });
    if (
      v.mode === "V2" &&
      v.title.length +
        v.description.length +
        v.footer.length +
        4 +
        (v.footer ? 3 : 0) +
        v.fields.reduce((n, f) => n + f.name.length + f.value.length + 5, 0) >
        4000
    )
      ctx.addIssue({
        code: "custom",
        message: "Components V2 text exceeds 4,000 characters.",
      });
    for (const text of texts)
      for (const p of text.matchAll(/\{([^{}]+)\}/g))
        if (!placeholders.includes(p[1] as (typeof placeholders)[number]))
          ctx.addIssue({
            code: "custom",
            message: `Unknown placeholder: {${p[1]}}`,
          });
    if (
      v.mode === "V2" &&
      1 +
        v.fields.length +
        (v.footer ? 1 : 0) +
        (v.image || v.thumbnail ? 1 : 0) >
        10
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Components V2 container exceeds ten content components. Remove fields or media.",
      });
    const buttons = v.buttons.filter((b) => b.visible);
    if (new Set(buttons.map((b) => b.action)).size !== buttons.length)
      ctx.addIssue({
        code: "custom",
        message: "Visible buttons must use distinct actions.",
      });
    if (Math.ceil(buttons.length / 5) + (v.courseworkSelect ? 1 : 0) > 5)
      ctx.addIssue({
        code: "custom",
        message: "Message exceeds five action rows.",
      });
  });
export type Template = z.infer<typeof templateSchema>;
export const arrivalTemplateSchema = templateSchema.refine(
  (t) =>
    !t.buttons.length &&
    !t.courseworkSelect &&
    [t.title, t.description, ...t.fields.map((f) => f.value)]
      .join(" ")
      .includes("{coursework.name}"),
  "Arrival notification must include {coursework.name} and cannot contain interactive controls.",
);
export function resolve(text: string, values: Record<string, string | number>) {
  return text.replace(/\{([^{}]+)\}/g, (_, p: string) => {
    if (!placeholders.includes(p as (typeof placeholders)[number]))
      throw new DomainError("PLACEHOLDER", `Unknown placeholder: ${p}`, 400);
    return String(values[p] ?? "—");
  });
}
export function render(
  document: unknown,
  values: Record<string, string | number>,
  courses: { id: string; name: string }[] = [],
) {
  const t = templateSchema.parse(normalizeActions(document));
  values = { ...values };
  if (t.roomLayout) {
    if (!t.roomLayout.overview) values["queue.overview"] = "";
    if (!t.roomLayout.waiting) values["queue.top"] = "";
    if (!t.roomLayout.current) {
      values["room.current"] = "";
      for (const field of roomCurrentFields)
        values[`room.current.${field}`] = "";
    }
  }
  const components: Record<string, unknown>[] = [];
  if (t.courseworkSelect)
    components.push({
      type: 1,
      components: [
        {
          type: 3,
          custom_id: "ta:coursework",
          placeholder: th.selectCoursework,
          disabled: !courses.length,
          options: (courses.length
            ? courses.slice(0, 25)
            : [{ id: "none", name: th.noCoursework }]
          ).map((c) => ({ label: c.name.slice(0, 100), value: c.id })),
        },
      ],
    });
  const buttons = t.buttons.filter((b) => b.visible);
  for (let i = 0; i < buttons.length; i += 5)
    components.push({
      type: 1,
      components: buttons.slice(i, i + 5).map((b) => ({
        type: 2,
        custom_id: `ta:${b.action}`,
        label: b.label,
        style: { Primary: 1, Secondary: 2, Success: 3, Danger: 4 }[b.style],
        disabled: b.disabled,
        ...(b.emoji ? { emoji: { name: b.emoji } } : {}),
      })),
    });
  const description = resolve(t.description, values).slice(0, 4096);
  const title = resolve(t.title, values).slice(0, 256);
  const fields = t.fields
    .map((f) => ({
      ...f,
      name: resolve(f.name, values).slice(0, 256),
      value: resolve(f.value, values).slice(0, 1024),
    }))
    .filter((f) => f.value.trim());
  const footer = resolve(t.footer, values).slice(0, 2048);
  if (t.mode === "V2") {
    const texts = [
      { type: 10, content: `## ${title}\n${description}` },
      ...fields.map((f) => ({
        type: 10,
        content: `**${f.name}**\n${f.value}`,
      })),
      ...(footer ? [{ type: 10, content: `-# ${footer}` }] : []),
    ];
    const mediaItems = [t.thumbnail, t.image]
      .filter(Boolean)
      .map((url) => ({ media: { url } }));
    if (texts.reduce((n, text) => n + text.content.length, 0) > 4000)
      throw new DomainError(
        "V2_SIZE",
        "Components V2 text exceeds 4,000 characters. Shorten the template.",
        400,
      );
    return {
      flags: 32768,
      allowed_mentions: { parse: [] },
      components: [
        {
          type: 17,
          accent_color: parseInt(t.color.slice(1), 16),
          components: [
            ...texts,
            ...(mediaItems.length ? [{ type: 12, items: mediaItems }] : []),
          ],
        },
        ...components,
      ],
    };
  }
  const embed = {
    title,
    description,
    color: parseInt(t.color.slice(1), 16),
    fields,
    ...(footer ? { footer: { text: footer } } : {}),
    ...(t.author
      ? { author: { name: resolve(t.author, values).slice(0, 256) } }
      : {}),
    ...(t.thumbnail ? { thumbnail: { url: t.thumbnail } } : {}),
    ...(t.image ? { image: { url: t.image } } : {}),
  };
  const count =
    title.length +
    description.length +
    footer.length +
    t.author.length +
    fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  if (count > 6000)
    throw new DomainError(
      "EMBED_SIZE",
      "Rendered message exceeds Discord limits. Shorten the template.",
      400,
    );
  return { embeds: [embed], components, allowed_mentions: { parse: [] } };
}
export function normalizeActions(document: unknown): unknown {
  if (
    !document ||
    typeof document !== "object" ||
    !("buttons" in document) ||
    !Array.isArray(document.buttons) ||
    document.buttons.some(
      (b) => !b || typeof b !== "object" || typeof b.action !== "string",
    )
  )
    return document;
  const sourceButtons = document.buttons;
  const seen = new Set<string>();
  const buttons = document.buttons
    .filter(
      (b) =>
        !(
          b.action === "help" &&
          sourceButtons.some((x: { action: string }) =>
            ["next", "CALL_NEXT_STUDENT"].includes(x.action),
          )
        ),
    )
    .map((b) =>
      b.action === "no_show"
        ? {
            ...b,
            action: "MARK_STUDENT_NO_SHOW",
            label:
              b.label === "นักศึกษาไม่อยู่" ||
              b.label === "บันทึกว่าไม่มาตามเรียก"
                ? "นักศึกษาไม่ตอบกลับ"
                : b.label,
          }
        : ["next", "help"].includes(b.action)
          ? {
              ...b,
              action: "CALL_NEXT_STUDENT",
              ...(b.action === "help" ? { label: "เรียกคิวถัดไป" } : {}),
            }
          : b,
    )
    .filter((b) => {
      if (b.action === "CALL_NEXT_STUDENT" && seen.has(b.action)) return false;
      seen.add(b.action);
      return true;
    });
  return { ...document, buttons };
}
export const defaults: Record<string, Template> = Object.fromEntries(
  Object.entries(thaiPanels).map(([feature, source]) => {
    const buttons =
      "buttons" in source
        ? source.buttons.map(([action, label, style]) => ({
            action,
            label,
            style: style || "Secondary",
          }))
        : [];
    return [
      feature,
      (feature === "arrival" ? arrivalTemplateSchema : templateSchema).parse({
        ...source,
        footer:
          feature === "waiting_room_alert"
            ? `${th.footer} · อ้างอิง {waiting.incident}`
            : th.footer,
        buttons,
      }),
    ];
  }),
);

export const roomPanelTemplateSchema = templateSchema.refine(
  (t) =>
    !t.courseworkSelect &&
    t.buttons.every((b) =>
      (taRoomActions as readonly string[]).includes(b.action),
    ) &&
    [
      t.title,
      t.description,
      t.footer,
      t.author,
      ...t.fields.flatMap((f) => [f.name, f.value]),
    ].every((text) =>
      [...text.matchAll(/\{([^{}]+)\}/g)].every(
        (m) =>
          (m[1].startsWith("queue.") && m[1] !== "queue.number") ||
          ["room.current", "room.status"].includes(m[1]) ||
          m[1].startsWith("room.current."),
      ),
    ),
  "Room panels support privacy-aware queue and room placeholders and registered TA room controls.",
);
export function scopeRoomActions(value: unknown, roomId: string): unknown {
  if (Array.isArray(value))
    return value.map((v) => scopeRoomActions(v, roomId));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      key,
      key === "custom_id" &&
      taRoomActions.some((action) => v === `ta:${action}`)
        ? `${v}:${roomId}`
        : scopeRoomActions(v, roomId),
    ]),
  );
}

export function panelActions(feature: string): Template["buttons"] {
  if (["ta_dashboard", "ta_room_queue_panel"].includes(feature))
    return defaults.ta_room_queue_panel.buttons.concat(
      defaults.ta_dashboard.buttons.filter(
        (b) =>
          !defaults.ta_room_queue_panel.buttons.some(
            (x) => x.action === b.action,
          ),
      ),
    );
  return defaults[feature]?.buttons || [];
}
export const waitingAlertTemplateSchema = templateSchema.refine(
  (t) =>
    !t.buttons.length &&
    !t.courseworkSelect &&
    [
      t.title,
      t.description,
      t.footer,
      t.author,
      ...t.fields.flatMap((f) => [f.name, f.value]),
    ].every((text) =>
      [...text.matchAll(/\{([^{}]+)\}/g)].every((m) =>
        [
          "voice.channel",
          "waiting.unqueued_count",
          "waiting.status",
          "waiting.incident",
          "queue.active_tas",
          "queue.available_tas",
          "queue.available",
          "queue.capacity",
        ].includes(m[1]),
      ),
    ),
  "Waiting alerts support aggregate waiting and availability placeholders without interactive controls.",
);

export function renderWaitingAlert(
  document: unknown,
  values: Record<string, string | number>,
) {
  const template = waitingAlertTemplateSchema.parse(document);
  return render(
    {
      ...template,
      footer: template.footer.includes("{waiting.incident}")
        ? template.footer
        : `${template.footer.slice(0, 1950)} · อ้างอิง {waiting.incident}`,
    },
    values,
  );
}
