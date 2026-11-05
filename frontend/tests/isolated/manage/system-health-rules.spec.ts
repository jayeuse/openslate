import { expect, test } from "@playwright/test";

import {
  backupsRow,
  createAnnouncer,
  checkAnnouncement,
  checkTimeText,
  failedJobsText,
  nextCheckSuffix,
  partRows,
  signInActivityText,
  healthPeriodKey,
  installationRows,
  mergePeriods,
  periodLength,
  periodRow,
  storageText,
  systemHeadline,
  timelineEmptyText,
  type HealthPeriod,
  type InstallationStatus,
  type OrganizationStatus,
  type StatusCheck,
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
    [
      "Email",
      "Set up",
      "No email was sent recently, so Slate Operations cannot confirm that it works.",
    ],
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
    "Invitations and password emails may not arrive until email works.",
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

// Block 3, Your organization (S3-C5, D8.3 to D8.6).

const organization: OrganizationStatus = {
  since: "2026-10-26T15:00:00Z",
  backups: {
    state: "on_time",
    last_success_at: "2026-11-02T07:00:00Z",
    last_result: "verified",
  },
  failed_jobs: 0,
  failed_sign_ins: 0,
  lockouts: 0,
  storage_used_bytes: 0,
};
const backupNow = new Date("2026-11-02T15:00:00Z");

test("S3-C5: the Backups row gives the state word, the last good backup and the latest run", () => {
  const row = (
    backups: OrganizationStatus["backups"],
    installationOwner = false,
  ) => backupsRow(backups, { now: backupNow, region, installationOwner });
  expect(row(organization.backups)).toEqual({
    state: "on_time",
    word: "On time",
    detail: ["Last good backup today at 2:00 AM", "Latest run: Verified"],
    followUp: null,
  });
  // Late: the last good backup is from another day, and the latest run failed.
  expect(
    row({
      state: "late",
      last_success_at: "2026-10-30T06:00:00Z",
      last_result: "failed",
    }),
  ).toEqual({
    state: "late",
    word: "Late",
    detail: ["Last good backup on Oct 30 at 2:00 AM", "Latest run: Failed"],
    followUp: "owner-manages",
  });
  // Each part is left out when it has no value; with neither, one sentence.
  expect(
    row({ state: "no_schedule", last_success_at: null, last_result: null }),
  ).toMatchObject({
    word: "No backup schedule",
    detail: ["No backup has run yet."],
    followUp: "owner-manages",
  });
  expect(
    row(
      {
        state: "never_backed_up",
        last_success_at: null,
        last_result: "interrupted",
      },
      true,
    ),
  ).toMatchObject({
    word: "No backup yet",
    detail: ["Latest run: Interrupted"],
    followUp: "open-backup",
  });
  // On time has no third line, for the owner too.
  expect(row(organization.backups, true).followUp).toBeNull();
});

test("S3-C5, D13 item 1: a backup state the server cannot read says so, with Late's third line", () => {
  const unknown = {
    state: "unknown",
    last_success_at: null,
    last_result: null,
  } as const;
  expect(
    backupsRow(unknown, { now: backupNow, region, installationOwner: false }),
  ).toEqual({
    state: "unknown",
    word: "Cannot be checked",
    detail: ["Slate Operations cannot read the backup state now."],
    followUp: "owner-manages",
  });
  expect(
    backupsRow(unknown, { now: backupNow, region, installationOwner: true })
      .followUp,
  ).toBe("open-backup");
});

test("S3-C5: failed jobs read as a count sentence in the workspace locale", () => {
  expect(failedJobsText(0, region)).toBe("No failed jobs in the last 7 days");
  expect(failedJobsText(1, region)).toBe("1 job failed in the last 7 days");
  expect(failedJobsText(12, region)).toBe("12 jobs failed in the last 7 days");
  expect(failedJobsText(1234, region)).toBe(
    "1,234 jobs failed in the last 7 days",
  );
  expect(failedJobsText(1234, { ...region, locale: "de-DE" })).toBe(
    "1.234 jobs failed in the last 7 days",
  );
  // D13 item 1: a count the server cannot read says so.
  expect(failedJobsText(null, region)).toBe(
    "The failed job count cannot be read now.",
  );
});

test("S3-C5: sign-in activity names each nonzero count, singular or plural", () => {
  for (const [failed, lockouts, sentence] of [
    [0, 0, "No failed sign-ins or lockouts in the last 7 days"],
    [3, 0, "3 failed sign-ins in the last 7 days"],
    [1, 0, "1 failed sign-in in the last 7 days"],
    [0, 1, "1 lockout in the last 7 days"],
    [0, 4, "4 lockouts in the last 7 days"],
    [1, 2, "1 failed sign-in and 2 lockouts in the last 7 days"],
  ] as const)
    expect(signInActivityText(failed, lockouts, region), sentence).toBe(
      sentence,
    );
});

test("S3-C5: a changed organization value is a changed result, never No change", () => {
  // D8.6: the same parts with a new failed-jobs count get no suffix, and a
  // press announces the headline and the time; block 3 never changes the
  // headline.
  const before = { ...laterSame, organization };
  const after = {
    ...laterSame,
    checked_at: "2026-11-02T14:44:10Z",
    organization: { ...organization, failed_jobs: 2 },
  };
  expect(
    nextCheckSuffix({
      previous: before,
      next: after,
      trigger: "person",
      suffix: null,
    }),
  ).toBeNull();
  expect(
    checkAnnouncement({
      previous: before,
      next: after,
      trigger: "person",
      time: "9:44 AM",
    }),
  ).toBe("Slate Operations is working normally. Checked at 9:44 AM.");
  // A background refresh that changes only block 3 says nothing.
  expect(
    checkAnnouncement({
      previous: before,
      next: after,
      trigger: "background",
      time: "9:44 AM",
    }),
  ).toBe("");
  // The same organization values keep No change, though `since` moves with
  // every request: it is not a block 3 value.
  const sameValues = {
    ...after,
    organization: { ...organization, since: "2026-10-26T15:01:05Z" },
  };
  expect(
    nextCheckSuffix({
      previous: before,
      next: sameValues,
      trigger: "person",
      suffix: null,
    }),
  ).toBe("no-change");
  expect(
    checkAnnouncement({
      previous: before,
      next: sameValues,
      trigger: "person",
      time: "9:44 AM",
    }),
  ).toBe(
    "No change. Slate Operations is working normally. Checked at 9:44 AM.",
  );
});

// S5: Slow (S5-C4, D14), Email from real sends (S5-C5, D16), the 30-day
// timeline (S5-C3, D15), file storage (S5-C7, D17) and the installation block
// (S5-C6, D18).

const S = "slow";

for (const [name, input, headline, tone] of [
  [
    "one part is slow",
    parts(W, S, W, "set_up"),
    "Signing in is slow. Everything else works.",
    "slow",
  ],
  [
    "Files and pictures are slow",
    parts(W, W, S, W),
    "Files and pictures are slow. Everything else works.",
    "slow",
  ],
  [
    "two parts are slow",
    parts(W, S, S, "set_up"),
    "Some parts are slow: Signing in, Files and pictures. Everything else works.",
    "slow",
  ],
  [
    "one part is down and another is slow",
    parts(W, W, S, X),
    "Email is not working. Files and pictures are slow.",
    "not_working",
  ],
  [
    "a part is down, another slow, and Email not set up",
    parts(W, S, X, "not_set_up"),
    "Files and pictures are not working. Signing in is slow. Email is not set up.",
    "not_working",
  ],
  [
    "a part is slow and Email is not set up",
    parts(S, W, W, "not_set_up"),
    "Saving and loading your data is slow. Email is not set up.",
    "slow",
  ],
  // A slow part does not count as working.
  [
    "every part that is not down is slow",
    parts(S, X, X, X),
    "Some parts are not working: Signing in, Files and pictures, Email. Saving and loading your data is slow.",
    "not_working",
  ],
  [
    "three parts are slow and Email is unknown",
    parts(S, S, S, "unknown"),
    "Some parts are slow: Saving and loading your data, Signing in, Files and pictures.",
    "slow",
  ],
  [
    "Email works after a real send",
    parts(W, W, W, W),
    "Slate Operations is working normally.",
    "working",
  ],
] as const) {
  test(`S5-C4: the headline when ${name}`, () => {
    expect(systemHeadline(input)).toEqual({ sentence: headline, tone });
  });
}

test("S5-C4, S5-C5: Slow and the Email words have their own cause lines", () => {
  expect(
    partRows(parts(S, S, S, S)).map((row) => [row.word, row.cause]),
  ).toEqual([
    ["Slow", "Pages may load and save more slowly than usual."],
    ["Slow", "Signing in may take longer than usual."],
    ["Slow", "Files and pictures may upload and open more slowly than usual."],
    ["Slow", "Email may take longer than usual."],
  ]);
  // D16: Working after a real send has no line.
  expect(partRows(parts(W, W, W, W))[3]).toMatchObject({
    word: "Working",
    cause: null,
  });
});

const ny = { locale: "en-US", timezone: "America/New_York" };
// Monday, Nov 2, 2026, 10:00 in New York.
const monday = new Date("2026-11-02T15:00:00Z");
const period = (
  part: HealthPeriod["part"],
  kind: HealthPeriod["kind"],
  started_at: string,
  ended_at: string | null,
): HealthPeriod => ({ part, kind, started_at, ended_at });

test("S5-C3: each period reads as one sentence with its day and length", () => {
  const rows = [
    period("email", "not_working", "2026-11-02T14:42:00Z", null),
    period("data", "slow", "2026-11-02T13:00:00Z", null),
    period("files", "not_working", "2026-11-01T12:00:00Z", null),
    period("files", "slow", "2026-11-02T14:00:00Z", null),
    period(
      "signing_in",
      "slow",
      "2026-11-01T15:00:00Z",
      "2026-11-01T15:04:00Z",
    ),
    period(
      "email",
      "not_working",
      "2026-10-27T15:00:00Z",
      "2026-10-27T15:12:00Z",
    ),
    period(
      "files",
      "not_working",
      "2026-10-26T13:00:00Z",
      "2026-10-26T14:30:00Z",
    ),
    period("files", "slow", "2026-10-31T15:00:00Z", "2026-10-31T15:03:00Z"),
    period(
      "data",
      "not_working",
      "2026-10-30T10:00:00Z",
      "2026-11-01T13:00:00Z",
    ),
  ].map((item) => periodRow(item, monday, ny).sentence);
  expect(rows).toEqual([
    "Email has not worked since 9:42 AM today.",
    "Saving and loading your data has been slow since 8:00 AM today.",
    "Files and pictures have not worked since 7:00 AM yesterday.",
    "Files and pictures have been slow since 9:00 AM today.",
    "Signing in was slow for 4 minutes yesterday.",
    "Email did not work for 12 minutes on Tuesday.",
    "Files and pictures did not work for 1 hour 30 minutes on Oct 26.",
    "Files and pictures were slow for 3 minutes on Saturday.",
    "Saving and loading your data did not work for 2 days 3 hours on Friday.",
  ]);
});

test("S5-C3: a period's meta line gives its times, or says it is still going", () => {
  expect(
    periodRow(
      period(
        "email",
        "not_working",
        "2026-11-02T14:42:00Z",
        "2026-11-02T14:54:00Z",
      ),
      monday,
      ny,
    ),
  ).toEqual({
    key: "email:not_working:2026-11-02T14:42:00Z",
    kind: "not_working",
    sentence: "Email did not work for 12 minutes today.",
    meta: { from: "9:42 AM", to: "9:54 AM" },
  });
  // Across midnight both ends carry their day.
  expect(
    periodRow(
      period("files", "slow", "2026-11-01T03:50:00Z", "2026-11-01T06:10:00Z"),
      monday,
      ny,
    ).meta,
  ).toEqual({ from: "Oct 31 at 11:50 PM", to: "Nov 1 at 1:10 AM" });
  expect(
    periodRow(period("data", "slow", "2026-11-02T13:00:00Z", null), monday, ny)
      .meta,
  ).toBeNull();
});

test("S5-C3: a length reads in minutes, hours and minutes, or days and hours", () => {
  for (const [minutes, words] of [
    [0, "1 minute"],
    [1, "1 minute"],
    [12, "12 minutes"],
    [60, "1 hour"],
    [90, "1 hour 30 minutes"],
    [301, "5 hours 1 minute"],
    [1440, "1 day"],
    [1441, "1 day"],
    [3060, "2 days 3 hours"],
  ] as const)
    expect(periodLength(minutes, ny), words).toBe(words);
});

test("S5-C3: with no period the timeline says how far back it looked", () => {
  // The oldest kept sample is about 30 days old (retention runs hourly).
  expect(timelineEmptyText("2026-10-03T16:00:00Z", monday, ny)).toBe(
    "No problems in the last 30 days.",
  );
  // D15.6: a younger history claims only the days it checked.
  expect(
    timelineEmptyText(
      "2026-11-03T04:00:00Z",
      new Date("2026-11-05T15:00:00Z"),
      ny,
    ),
  ).toBe("No problems since Nov 2.");
  expect(timelineEmptyText(null, monday, ny)).toBe(
    "No history is recorded yet.",
  );
});

test("S5-C3: older pages join the first without repeating a period, the fresh page winning", () => {
  const ongoing = period("email", "not_working", "2026-11-02T14:42:00Z", null);
  const ended = { ...ongoing, ended_at: "2026-11-02T14:50:00Z" };
  const older = period(
    "files",
    "slow",
    "2026-10-31T15:00:00Z",
    "2026-10-31T15:03:00Z",
  );
  // The ongoing period ended and moved; the fresh first page holds it once.
  expect(mergePeriods([ended], [ongoing, older])).toEqual([ended, older]);
  expect(healthPeriodKey(ongoing)).toBe(
    "email:not_working:2026-11-02T14:42:00Z",
  );
});

test("S5-C7: file storage reads in decimal units with no trailing zero", () => {
  for (const [bytes, words] of [
    [null, "File storage cannot be read now."],
    [0, "No files are stored yet"],
    [999, "Files use less than 1 KB"],
    [1000, "Files use 1 KB"],
    [1_234_000_000, "Files use 1.2 GB"],
    [12_400_000_000, "Files use 12 GB"],
    [340_000_000, "Files use 340 MB"],
    [9_960_000, "Files use 10 MB"],
    [999_600, "Files use 1 MB"],
    [3_000_000_000_000, "Files use 3 TB"],
  ] as const)
    expect(storageText(bytes, ny), String(bytes)).toBe(words);
  expect(storageText(1_234_000_000, { ...ny, locale: "de-DE" })).toBe(
    "Files use 1,2 GB",
  );
});

const installation: InstallationStatus = {
  database_bytes: 1_400_000_000,
  database_measured_at: "2026-11-02T14:59:00Z",
  workers: [
    {
      key: "backup_runner",
      state: "running",
      last_seen_at: "2026-11-02T14:58:00Z",
    },
    {
      key: "record_triggers",
      state: "running",
      last_seen_at: "2026-11-02T14:59:30Z",
    },
    {
      key: "report_scheduling",
      state: "not_seen",
      last_seen_at: "2026-11-02T14:42:00Z",
    },
    {
      key: "comms_jobs",
      state: "not_seen",
      last_seen_at: "2026-11-01T03:58:00Z",
    },
    { key: "provider_signout", state: "never_seen", last_seen_at: null },
  ],
};

test("S5-C6: block 4 gives the database size and each worker in a fixed order", () => {
  expect(installationRows(installation, monday, ny)).toEqual({
    database: "1.4 GB",
    workers: [
      {
        key: "record_triggers",
        label: "Record triggers",
        state: "running",
        word: "Running",
        detail: null,
      },
      {
        key: "report_scheduling",
        label: "Scheduled reports",
        state: "not_seen",
        word: "Not seen since 9:42 AM",
        detail: "Its work waits until it runs again.",
      },
      {
        key: "comms_jobs",
        label: "OpenComms jobs",
        state: "not_seen",
        word: "Not seen since Oct 31 at 11:58 PM",
        detail: "Its work waits until it runs again.",
      },
      {
        key: "provider_signout",
        label: "Sign-out cleanup",
        state: "never_seen",
        word: "Not seen yet",
        detail: "Check that it runs on your server.",
      },
      {
        key: "backup_runner",
        label: "Backup runner",
        state: "running",
        word: "Running",
        detail: null,
      },
    ],
  });
  expect(
    installationRows(
      { ...installation, database_bytes: null, workers: [] },
      monday,
      ny,
    ),
  ).toMatchObject({
    database: "Cannot be read now.",
    workers: [
      { key: "record_triggers", word: "—", detail: null },
      { key: "report_scheduling", word: "—" },
      { key: "comms_jobs", word: "—" },
      { key: "provider_signout", word: "—" },
      { key: "backup_runner", word: "—" },
    ],
  });
});

test("S5-C6, S5-C7: No change ignores the database size and a running worker's last-seen time", () => {
  const admin = { ...organization, storage_used_bytes: 1000 };
  const before = { ...laterSame, organization: admin, installation };
  const next = (changes: object) => ({
    ...before,
    checked_at: "2026-11-02T14:44:10Z",
    ...changes,
  });
  const suffix = (after: StatusCheck) =>
    nextCheckSuffix({
      previous: before,
      next: after,
      trigger: "person",
      suffix: null,
    });
  // Values that move every minute are not a change.
  expect(
    suffix(
      next({
        installation: {
          ...installation,
          database_bytes: 1_400_100_000,
          database_measured_at: "2026-11-02T15:00:00Z",
          workers: installation.workers.map((worker) =>
            worker.state === "running"
              ? { ...worker, last_seen_at: "2026-11-02T15:00:00Z" }
              : worker,
          ),
        },
      }),
    ),
  ).toBe("no-change");
  // Storage, a worker's state and a stopped worker's time are.
  expect(
    suffix(next({ organization: { ...admin, storage_used_bytes: 2000 } })),
  ).toBeNull();
  expect(
    suffix(
      next({
        installation: {
          ...installation,
          workers: installation.workers.map((worker) =>
            worker.key === "provider_signout"
              ? {
                  ...worker,
                  state: "running",
                  last_seen_at: "2026-11-02T15:00:00Z",
                }
              : worker,
          ),
        },
      }),
    ),
  ).toBeNull();
  expect(
    suffix(
      next({
        installation: {
          ...installation,
          workers: installation.workers.map((worker) =>
            worker.key === "comms_jobs"
              ? { ...worker, last_seen_at: "2026-11-02T14:43:00Z" }
              : worker,
          ),
        },
      }),
    ),
  ).toBeNull();
});
