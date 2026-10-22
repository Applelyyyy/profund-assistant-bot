import { expect, test } from "vitest";
import type { APIMessage } from "discord.js";
import { matchesPanel } from "../apps/bot/src/panel-recovery";

const document = {
  embeds: [{ title: "Verification" }],
  components: [{ type: 1, components: [{ type: 2, custom_id: "ta:verify" }] }],
};
const message = {
  id: "old",
  author: { id: "our-bot" },
  flags: 0,
  embeds: [{ title: "Old custom verification title" }],
  components: [{ type: 1, components: [{ type: 2, custom_id: "ta:verify" }] }],
};

test("recognizes a renamed bot registration panel by its distinctive controls", () => {
  expect(
    matchesPanel(
      message as unknown as APIMessage,
      "our-bot",
      "registration",
      document,
    ),
  ).toBe(true);
});
test.each([
  { ...message, author: { id: "another-bot" } },
  { ...message, webhook_id: "webhook" },
  {
    ...message,
    components: [{ type: 1, components: [{ type: 2, custom_id: "ta:join" }] }],
  },
  { ...message, embeds: [], components: [] },
])(
  "does not adopt unrelated messages or messages outside our control",
  (candidate) => {
    expect(
      matchesPanel(
        candidate as unknown as APIMessage,
        "our-bot",
        "registration",
        document,
      ),
    ).toBe(false);
  },
);
test("room controls cannot be recovered from another room even when the title matches", () => {
  const expected = {
    embeds: [{ title: "Room queue" }],
    components: [{ type: 2, custom_id: "ta:CALL_NEXT_STUDENT:room-one" }],
  };
  const wrong = {
    ...message,
    embeds: [{ title: "Room queue" }],
    components: [{ type: 2, custom_id: "ta:CALL_NEXT_STUDENT:room-two" }],
  };
  expect(
    matchesPanel(
      wrong as unknown as APIMessage,
      "our-bot",
      "ta_room_queue_panel",
      expected,
      "room-one",
    ),
  ).toBe(false);
});
test("a shared refresh control cannot claim a different kind of panel", () => {
  const expected = {
    embeds: [{ title: "Public queue" }],
    components: [{ type: 2, custom_id: "ta:refresh" }],
  };
  const wrong = {
    ...message,
    embeds: [{ title: "Summary" }],
    components: [{ type: 2, custom_id: "ta:refresh" }],
  };
  expect(
    matchesPanel(
      wrong as unknown as APIMessage,
      "our-bot",
      "public_queue",
      expected,
    ),
  ).toBe(false);
});
test("recognizes nested V2 text panels without interactive controls", () => {
  const expected = {
    flags: 32768,
    components: [
      {
        type: 17,
        components: [{ type: 10, content: "## Custom rankings\nNew values" }],
      },
    ],
  };
  const old = {
    ...message,
    flags: 32768,
    embeds: [],
    components: [
      {
        type: 17,
        components: [{ type: 10, content: "## Custom rankings\nOld values" }],
      },
    ],
  };
  expect(
    matchesPanel(old as unknown as APIMessage, "our-bot", "ranking", expected),
  ).toBe(true);
});

test.each([
  [
    "student_queue",
    "🎟️ รับบัตรคิว",
    ["ta:coursework", "ta:join", "ta:cancel", "ta:status"],
  ],
  ["public_queue", "📋・LIVE QUEUE", []],
  ["ta_dashboard", "TA Dashboard", []],
] as const)(
  "recovers the legacy %s panel found in the configured Discord channel",
  (feature, title, actions) => {
    const old = {
      ...message,
      embeds: [{ title }],
      components: actions.length
        ? [
            {
              type: 1,
              components: [{ type: 3, custom_id: actions[0] }],
            },
            {
              type: 1,
              components: actions
                .slice(1)
                .map((custom_id) => ({ type: 2, custom_id })),
            },
          ]
        : [],
    };
    expect(
      matchesPanel(old as unknown as APIMessage, "our-bot", feature, {}),
    ).toBe(true);
  },
);
