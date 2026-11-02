import { expect, test } from "@playwright/test";

import {
  createAnnouncer,
  checkAnnouncement,
  checkTimeText,
  nextCheckSuffix,
  partRows,
  systemHeadline,
  type SystemPart,
} from "../../../src/components/systems/manage/domain/health-rules";

// What System health says (docs/specs/system-health.md, S2-C6 and S2-C9):
// the R3 headline built from the four parts (D2.2), each part's word and cause
// line (D2.3), and the check line after Check again (D2.4).

type Status = SystemPart["status"];
function parts(
  data: Status,
  signingIn: Status,
  files: Status,
  email: Status,
): SystemPart[] {
  return [
    { key: "data", status: data },
    { key: "signing_in", status: signingIn },
    { key: "files", status: files },
    { key: "email", status: email },
  ];
}

const W = "working";
const X = "not_working";

for (const [name, input, headline] of [
  [
    "all parts work",
    parts(W, W, W, "set_up"),
    "Slate Operations is working normally.",
  ],
  [
    "Email is not set up",
    parts(W, W, W, "not_set_up"),
    "Email is not set up. Everything else works.",
  ],
  [
    "one part is down",
    parts(W, W, X, "set_up"),
    "Files and pictures are not working. Everything else works.",
  ],
  [
    "one part is down and Email is not set up",
    parts(W, X, W, "not_set_up"),
    "Signing in is not working. Email is not set up.",
  ],
  [
    "Email is down",
    parts(W, W, W, X),
    "Email is not working. Everything else works.",
  ],
  [
    "the data part is down",
    parts(X, W, W, "set_up"),
    "Saving and loading your data is not working. Everything else works.",
  ],
  [
    "two parts are down",
    parts(W, X, X, "set_up"),
    "Some parts are not working: Signing in, Files and pictures. Everything else works.",
  ],
  [
    "three parts are down",
    parts(X, X, X, "set_up"),
    "Some parts are not working: Saving and loading your data, Signing in, Files and pictures. Everything else works.",
  ],
  [
    "two parts are down and Email is not set up",
    parts(W, X, X, "not_set_up"),
    "Some parts are not working: Signing in, Files and pictures. Email is not set up.",
  ],
  [
    "all four parts are down",
    parts(X, X, X, X),
    "Slate Operations is not working right now. Wait a minute, then check again.",
  ],
  // D4 answer 8: the headline uses the same word as the row.
  [
    "a part other than Email is not set up",
    parts(W, W, "not_set_up", "set_up"),
    "Files and pictures are not set up. Everything else works.",
  ],
  [
    "one part is down and another is not set up",
    parts(W, X, "not_set_up", "set_up"),
    "Signing in is not working. Files and pictures are not set up.",
  ],
  [
    "two parts are not set up",
    parts(W, W, "not_set_up", "not_set_up"),
    "Some parts are not set up: Files and pictures, Email. Everything else works.",
  ],
  [
    "no part works or is set up",
    parts(X, X, X, "unknown"),
    "Some parts are not working: Saving and loading your data, Signing in, Files and pictures.",
  ],
  // A word the page does not know shows "—" and does not count.
  [
    "an unknown word does not count",
    parts(W, "unknown", W, "set_up"),
    "Slate Operations is working normally.",
  ],
] as const) {
  test(`the headline when ${name}`, () => {
    expect(systemHeadline(input).sentence).toBe(headline);
  });
}

test("the headline icon follows the worst part, by shape as well as color", () => {
  expect(systemHeadline(parts(W, W, W, "set_up")).tone).toBe("working");
  expect(systemHeadline(parts(W, W, W, "not_set_up")).tone).toBe("not_set_up");
  expect(systemHeadline(parts(W, X, W, "not_set_up")).tone).toBe("not_working");
  expect(systemHeadline(parts(W, W, "not_set_up", "set_up")).tone).toBe(
    "not_set_up",
  );
});

test("each part keeps its place, word and cause line whatever its status", () => {
  expect(
    partRows(parts(X, W, "unknown", "not_set_up")).map((row) => [
      row.name,
      row.word,
      row.cause,
    ]),
  ).toEqual([
    [
      "Saving and loading your data",
      "Not working",
      "Pages may not load, and changes you make may not save.",
    ],
    ["Signing in", "Working", null],
    ["Files and pictures", "—", null],
    [
      "Email",
      "Not set up",
      "Invitations and password emails cannot be sent until the person who runs your server sets up email.",
    ],
  ]);
  expect(
    partRows([
      { key: "email", status: "set_up" },
      { key: "files", status: X },
      { key: "signing_in", status: X },
    ]).map((row) => [row.name, row.word, row.cause]),
  ).toEqual([
    // A part missing from the response shows "—".
    ["Saving and loading your data", "—", null],
    [
      "Signing in",
      "Not working",
      "People who are signed out cannot sign in until it works again.",
    ],
    [
      "Files and pictures",
      "Not working",
      "Files and pictures cannot be uploaded or opened until it works again.",
    ],
    ["Email", "Set up", "Slate Operations cannot yet confirm delivery."],
  ]);
  // D4 answer 8: each part's Not set up line.
  expect(
    partRows(parts("not_set_up", "not_set_up", "not_set_up", W)).map(
      (row) => row.cause,
    ),
  ).toEqual([
    "Pages cannot load or save until the person who runs your server sets this up.",
    "People cannot sign in until the person who runs your server sets this up.",
    "Files and pictures cannot be uploaded or opened until the person who runs your server sets this up.",
    null,
  ]);
  expect(partRows(parts(W, W, W, X))[3].cause).toBe(
    "Messages that need email, such as invitations, wait until email works.",
  );
});

const region = { locale: "en-US", timezone: "America/New_York" };

test("the check time shows local time, and the date when it is not today", () => {
  const now = new Date("2026-11-02T15:00:00Z");
  expect(checkTimeText("2026-11-02T14:42:05.123456Z", now, region)).toBe(
    "Checked at 9:42 AM",
  );
  expect(checkTimeText("2026-11-02T04:58:00Z", now, region)).toBe(
    "Checked on Nov 1 at 11:58 PM",
  );
});

const first = {
  parts: parts(W, W, W, "set_up"),
  checked_at: "2026-11-02T14:42:05Z",
};
const sameCheck = { ...first };
const laterSame = { ...first, checked_at: "2026-11-02T14:43:10Z" };
const laterChanged = {
  parts: parts(W, W, W, X),
  checked_at: "2026-11-02T14:43:10Z",
};

test("Check again inside 30 seconds says it is the latest check, not a new one", () => {
  expect(
    nextCheckSuffix({
      previous: first,
      next: sameCheck,
      trigger: "person",
      suffix: null,
    }),
  ).toBe("latest");
  expect(
    checkAnnouncement({
      previous: first,
      next: sameCheck,
      trigger: "person",
      time: "9:42 AM",
    }),
  ).toBe(
    "This is the latest check, from 9:42 AM. Slate Operations is working normally.",
  );
});

test("Check again with a new check and the same result says no change", () => {
  expect(
    nextCheckSuffix({
      previous: first,
      next: laterSame,
      trigger: "person",
      suffix: null,
    }),
  ).toBe("no-change");
  expect(
    checkAnnouncement({
      previous: first,
      next: laterSame,
      trigger: "person",
      time: "9:43 AM",
    }),
  ).toBe(
    "No change. Slate Operations is working normally. Checked at 9:43 AM.",
  );
});

test("Check again with a changed result announces the new headline and time", () => {
  expect(
    nextCheckSuffix({
      previous: first,
      next: laterChanged,
      trigger: "person",
      suffix: "latest",
    }),
  ).toBeNull();
  expect(
    checkAnnouncement({
      previous: first,
      next: laterChanged,
      trigger: "person",
      time: "9:43 AM",
    }),
  ).toBe("Email is not working. Everything else works. Checked at 9:43 AM.");
});

test("a background refresh never adds a suffix and speaks only when the headline changes", () => {
  // The same check keeps the line, so its suffix stays.
  expect(
    nextCheckSuffix({
      previous: first,
      next: sameCheck,
      trigger: "background",
      suffix: "latest",
    }),
  ).toBe("latest");
  expect(
    nextCheckSuffix({
      previous: first,
      next: laterSame,
      trigger: "background",
      suffix: "latest",
    }),
  ).toBeNull();
  expect(
    checkAnnouncement({
      previous: first,
      next: laterSame,
      trigger: "background",
      time: "9:43 AM",
    }),
  ).toBe("");
  expect(
    checkAnnouncement({
      previous: first,
      next: laterChanged,
      trigger: "background",
      time: "9:43 AM",
    }),
  ).toBe("Email is not working. Everything else works.");
});

test("the first result announces nothing", () => {
  expect(
    checkAnnouncement({
      previous: null,
      next: first,
      trigger: "background",
      time: "9:42 AM",
    }),
  ).toBe("");
  expect(
    nextCheckSuffix({
      previous: null,
      next: first,
      trigger: "person",
      suffix: null,
    }),
  ).toBeNull();
});

test("each announcement empties the status first, so the same words are spoken twice", () => {
  // D4 answer 10: two presses inside 30 seconds each change the span.
  const written: string[] = [];
  const pending = new Map<number, () => void>();
  let next = 1;
  const timers = {
    set: (run: () => void, delay: number) => {
      expect(delay).toBe(150);
      pending.set(next, run);
      return next++;
    },
    clear: (id: number) => void pending.delete(id),
  };
  const flush = () => {
    for (const [id, run] of [...pending]) {
      pending.delete(id);
      run();
    }
  };
  const announcer = createAnnouncer((text) => written.push(text), timers);
  announcer.say("This is the latest check, from 9:42 AM.");
  flush();
  announcer.say("This is the latest check, from 9:42 AM.");
  flush();
  expect(written).toEqual([
    "",
    "This is the latest check, from 9:42 AM.",
    "",
    "This is the latest check, from 9:42 AM.",
  ]);
  // A new result cancels the text still waiting.
  written.length = 0;
  announcer.say("First");
  announcer.say("Second");
  expect(pending.size).toBe(1);
  // Unmount: the waiting text is never written.
  announcer.stop();
  flush();
  expect(written).toEqual(["", ""]);
});
