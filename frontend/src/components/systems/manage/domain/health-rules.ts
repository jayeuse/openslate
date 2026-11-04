import { formatWorkspaceDateTime, type WorkspaceRegion } from "@/lib/date-time";

/**
 * What System health says (docs/specs/system-health.md, R1 to R3 and D2):
 * the four parts by what a person does, their status words and cause lines,
 * the one headline sentence, and the check line after "Check again".
 */

export type PartKey = "data" | "signing_in" | "files" | "email";
/** The contract's words, plus `unknown` for a word this page does not know. */
export type PartStatus =
  "working" | "not_working" | "not_set_up" | "set_up" | "slow" | "unknown";
export type SystemPart = { key: PartKey; status: PartStatus };
export type HeadlineTone = "working" | "not_set_up" | "slow" | "not_working";

/** R1 order. A status change never reorders the rows. */
export const PART_ORDER: readonly PartKey[] = [
  "data",
  "signing_in",
  "files",
  "email",
];

export const PART_NAMES: Readonly<Record<PartKey, string>> = {
  data: "Saving and loading your data",
  signing_in: "Signing in",
  files: "Files and pictures",
  email: "Email",
};

// Each part's fixed subject and verb in the headline.
const SUBJECTS: Readonly<Record<PartKey, string>> = {
  data: "Saving and loading your data is",
  signing_in: "Signing in is",
  files: "Files and pictures are",
  email: "Email is",
};

const WORDS: Readonly<Record<PartStatus, string>> = {
  working: "Working",
  not_working: "Not working",
  not_set_up: "Not set up",
  set_up: "Set up",
  slow: "Slow",
  unknown: "—",
};

const NOT_WORKING_CAUSES: Readonly<Record<PartKey, string>> = {
  data: "Pages may not load, and changes you make may not save.",
  signing_in: "People who are signed out cannot sign in until it works again.",
  files:
    "Files and pictures cannot be uploaded or opened until it works again.",
  // D16: the page does not know that a failed send is retried, so the line
  // promises no wait and no retry.
  email: "Invitations and password emails may not arrive until email works.",
};

// D14.1. Email's word comes from real sends and the contract never sends it
// as Slow; if it does, it reads as the other parts do.
const SLOW_CAUSES: Readonly<Record<PartKey, string>> = {
  data: "Pages may load and save more slowly than usual.",
  signing_in: "Signing in may take longer than usual.",
  files: "Files and pictures may upload and open more slowly than usual.",
  email: "Email may take longer than usual.",
};

const NOT_SET_UP_CAUSES: Readonly<Record<PartKey, string>> = {
  data: "Pages cannot load or save until the person who runs your server sets this up.",
  signing_in:
    "People cannot sign in until the person who runs your server sets this up.",
  files:
    "Files and pictures cannot be uploaded or opened until the person who runs your server sets this up.",
  email:
    "Invitations and password emails cannot be sent until the person who runs your server sets up email.",
};

function causeLine(key: PartKey, status: PartStatus): string | null {
  if (status === "not_working") return NOT_WORKING_CAUSES[key];
  if (status === "not_set_up") return NOT_SET_UP_CAUSES[key];
  if (status === "slow") return SLOW_CAUSES[key];
  // D16: Set up now means "no recent send to judge by".
  if (key === "email" && status === "set_up")
    return "No email was sent recently, so Slate Operations cannot confirm that it works.";
  return null;
}

/** The status of each part in R1 order; a part the response lacks is unknown. */
function statusesInOrder(parts: readonly SystemPart[]) {
  return PART_ORDER.map((key) => ({
    key,
    status: parts.find((part) => part.key === key)?.status ?? "unknown",
  }));
}

export type PartRow = {
  key: PartKey;
  name: string;
  status: PartStatus;
  word: string;
  cause: string | null;
};

export function partRows(parts: readonly SystemPart[]): PartRow[] {
  return statusesInOrder(parts).map(({ key, status }) => ({
    key,
    name: PART_NAMES[key],
    status,
    word: WORDS[status],
    cause: causeLine(key, status),
  }));
}

/**
 * One headline sentence for the parts with one word (D2.2, D4 answer 8);
 * `word` is "not working", "slow" or "not set up" (D14.2).
 */
function partsSentence(keys: readonly PartKey[], word: string): string {
  if (keys.length === 1) return `${SUBJECTS[keys[0]]} ${word}.`;
  // Some names contain "and", so the list uses commas only.
  const names = keys.map((key) => PART_NAMES[key]).join(", ");
  return `Some parts are ${word}: ${names}.`;
}

/**
 * The R3 headline (D2.2, D4 answer 8, D14.2): up to three sentences, the
 * parts that are Not working, then Slow, then Not set up, with the same word
 * as their rows. "Everything else works." follows when only one sentence
 * shows and a part works or is set up; a Slow part does not count as working.
 * An unknown word does not count.
 */
export function systemHeadline(parts: readonly SystemPart[]): {
  sentence: string;
  tone: HeadlineTone;
} {
  const statuses = statusesInOrder(parts);
  const keysWith = (status: PartStatus) =>
    statuses.filter((part) => part.status === status).map(({ key }) => key);
  const down = keysWith("not_working");
  const slow = keysWith("slow");
  const notSetUp = keysWith("not_set_up");
  const tone: HeadlineTone =
    down.length > 0
      ? "not_working"
      : slow.length > 0
        ? "slow"
        : notSetUp.length > 0
          ? "not_set_up"
          : "working";
  if (down.length === PART_ORDER.length)
    return {
      sentence:
        "Slate Operations is not working right now. Wait a minute, then check again.",
      tone,
    };
  const sentences = [
    ...(down.length ? [partsSentence(down, "not working")] : []),
    ...(slow.length ? [partsSentence(slow, "slow")] : []),
    ...(notSetUp.length ? [partsSentence(notSetUp, "not set up")] : []),
  ];
  if (sentences.length === 0)
    return { sentence: "Slate Operations is working normally.", tone };
  const anyWorks = statuses.some(
    ({ status }) => status === "working" || status === "set_up",
  );
  if (sentences.length === 1 && anyWorks)
    sentences.push("Everything else works.");
  return { sentence: sentences.join(" "), tone };
}

function formatter(
  region: WorkspaceRegion | undefined,
  options: Intl.DateTimeFormatOptions,
): (value: string) => string {
  return region
    ? (value) => formatWorkspaceDateTime(value, region, options)
    : (value) =>
        new Intl.DateTimeFormat(undefined, options).format(new Date(value));
}

/** The check time in local time with no seconds (D2.2). */
export function checkTime(value: string, region?: WorkspaceRegion): string {
  return formatter(region, { timeStyle: "short" })(value);
}

/** The time alone when `value` is from today, else its date and time. */
function dayAndTime(
  value: string,
  now: Date,
  region: WorkspaceRegion | undefined,
): { today: boolean; date: string; time: string } {
  const day = formatter(region, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return {
    today: day(value) === day(now.toISOString()),
    date: formatter(region, { month: "short", day: "numeric" })(value),
    time: checkTime(value, region),
  };
}

/** "Checked at 10:42", or "Checked on Nov 1 at 23:58" when not from today. */
export function checkTimeText(
  value: string,
  now: Date,
  region?: WorkspaceRegion,
): string {
  const { today, date, time } = dayAndTime(value, now, region);
  return today ? `Checked at ${time}` : `Checked on ${date} at ${time}`;
}

/** A person's "Check again", or the 60-second and focus refresh. */
export type CheckTrigger = "person" | "background";
/** What follows the check time: "This is the latest check" or "No change". */
export type CheckSuffix = "latest" | "no-change" | null;
export type StatusCheck = {
  parts: readonly SystemPart[];
  checked_at: string;
  /** Block 3's values; part of "the same result" (D8.6). */
  organization?: OrganizationStatus | null;
  /** Block 4's values; part of "the same result" (D20 item 8). */
  installation?: InstallationStatus | null;
};

/** Block 3's shown values; `since` moves with every request and is not one. */
function organizationValues(check: StatusCheck): string {
  const organization = check.organization;
  if (!organization) return "null";
  const {
    backups,
    failed_jobs,
    failed_sign_ins,
    lockouts,
    storage_used_bytes,
  } = organization;
  return JSON.stringify([
    backups,
    failed_jobs,
    failed_sign_ins,
    lockouts,
    storage_used_bytes,
  ]);
}

/**
 * Block 4's values that make a change (API contract S5, D20 item 8): each
 * worker's state, and the time of a worker that is not running. The database
 * size, its measuring time and a running worker's time move every minute, so
 * the owner would never see "No change"; they are left out.
 */
function installationValues(check: StatusCheck): string {
  const installation = check.installation;
  if (!installation) return "null";
  return JSON.stringify(
    installation.workers.map((worker) => [
      worker.key,
      worker.state,
      worker.state === "running" ? null : worker.last_seen_at,
    ]),
  );
}

/** The same parts and, for an admin or the owner, the same block values. */
function sameParts(left: StatusCheck, right: StatusCheck): boolean {
  const a = statusesInOrder(left.parts);
  const b = statusesInOrder(right.parts);
  return (
    a.every((part, index) => part.status === b[index].status) &&
    organizationValues(left) === organizationValues(right) &&
    installationValues(left) === installationValues(right)
  );
}

/**
 * The suffix after a result (D2.4). Inside the server's 30-second cache a
 * check returns the same check time, so the page must not suggest a new
 * check. A background refresh never adds a suffix; the suffix stays until the
 * next result changes the line.
 */
export function nextCheckSuffix({
  previous,
  next,
  trigger,
  suffix,
}: {
  previous: StatusCheck | null;
  next: StatusCheck;
  trigger: CheckTrigger;
  suffix: CheckSuffix;
}): CheckSuffix {
  if (!previous) return null;
  const sameTime = previous.checked_at === next.checked_at;
  if (trigger === "background") return sameTime ? suffix : null;
  if (sameTime) return "latest";
  return sameParts(previous, next) ? "no-change" : null;
}

/** What the page's status region announces after a result (D2.4). */
export function checkAnnouncement({
  previous,
  next,
  trigger,
  time,
}: {
  previous: StatusCheck | null;
  next: StatusCheck;
  trigger: CheckTrigger;
  time: string;
}): string {
  if (!previous) return "";
  const headline = systemHeadline(next.parts).sentence;
  if (trigger === "background")
    return headline === systemHeadline(previous.parts).sentence ? "" : headline;
  if (previous.checked_at === next.checked_at)
    return `This is the latest check, from ${time}. ${headline}`;
  if (sameParts(previous, next))
    return `No change. ${headline} Checked at ${time}.`;
  return `${headline} Checked at ${time}.`;
}

type AnnouncerTimers = {
  set: (run: () => void, delay: number) => number;
  clear: (id: number) => void;
};

// The pause between emptying the status span and writing the text.
const ANNOUNCE_DELAY_MS = 150;

/**
 * Speaks each result through one status span (D4 answer 10). A live region
 * speaks only when its text changes, so each `say` empties the span first and
 * writes the text 150 ms later. One timer: a new `say` or `stop` (unmount)
 * cancels the text still waiting. No hidden characters, no remount.
 */
export function createAnnouncer(
  write: (text: string) => void,
  timers: AnnouncerTimers,
) {
  let timer: number | null = null;
  const stop = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
  return {
    say(text: string) {
      stop();
      write("");
      if (!text) return;
      timer = timers.set(() => {
        timer = null;
        write(text);
      }, ANNOUNCE_DELAY_MS);
    },
    stop,
  };
}

// Block 3, Your organization (S3, D8).

export type BackupState =
  "on_time" | "late" | "no_schedule" | "never_backed_up" | "unknown";
export type BackupResult = "verified" | "failed" | "interrupted";
/** The admin-only `organization` part of the status (API contract S3). */
export type OrganizationStatus = {
  since: string;
  backups: {
    state: BackupState;
    last_success_at: string | null;
    last_result: BackupResult | null;
  };
  failed_jobs: number | null;
  failed_sign_ins: number;
  lockouts: number;
  /** S5-C7: bytes of the organization's files; null when unreadable. */
  storage_used_bytes: number | null;
};

const BACKUP_WORDS: Readonly<Record<BackupState, string>> = {
  on_time: "On time",
  late: "Late",
  no_schedule: "No backup schedule",
  never_backed_up: "No backup yet",
  // D13 item 1: the server could not read the installation.
  unknown: "Cannot be checked",
};

// The Backup page's run words (`backupRunStatus`) for the results the
// contract sends.
const RESULT_WORDS: Readonly<Record<BackupResult, string>> = {
  verified: "Verified",
  failed: "Failed",
  interrupted: "Interrupted",
};

export type BackupsRow = {
  state: BackupState;
  word: string;
  /** Line 2 in its parts, joined by " · "; each part stays whole. */
  detail: string[];
  /** Line 3: the owner's "Open Backup", or the note that someone else
   * manages backups. For every state but On time (D8.3, D13 item 1). */
  followUp: "open-backup" | "owner-manages" | null;
};

/** The Backups row (D8.3). */
export function backupsRow(
  backups: OrganizationStatus["backups"],
  {
    now,
    region,
    installationOwner,
  }: {
    now: Date;
    region: WorkspaceRegion | undefined;
    installationOwner: boolean;
  },
): BackupsRow {
  const { state } = backups;
  const followUp =
    state === "on_time"
      ? null
      : installationOwner
        ? ("open-backup" as const)
        : ("owner-manages" as const);
  if (state === "unknown")
    return {
      state,
      word: BACKUP_WORDS[state],
      detail: ["Slate Operations cannot read the backup state now."],
      followUp,
    };
  const parts: string[] = [];
  if (backups.last_success_at) {
    const { today, date, time } = dayAndTime(
      backups.last_success_at,
      now,
      region,
    );
    parts.push(
      today
        ? `Last good backup today at ${time}`
        : `Last good backup on ${date} at ${time}`,
    );
  }
  if (backups.last_result)
    parts.push(`Latest run: ${RESULT_WORDS[backups.last_result]}`);
  return {
    state,
    word: BACKUP_WORDS[state],
    detail: parts.length ? parts : ["No backup has run yet."],
    followUp,
  };
}

function count(value: number, region: WorkspaceRegion | undefined): string {
  return new Intl.NumberFormat(region?.locale).format(value);
}

/** The Failed jobs line (D8.4, D13 item 1 for a count it cannot read). */
export function failedJobsText(
  failed: number | null,
  region: WorkspaceRegion | undefined,
): string {
  if (failed === null) return "The failed job count cannot be read now.";
  if (failed === 0) return "No failed jobs in the last 7 days";
  return failed === 1
    ? "1 job failed in the last 7 days"
    : `${count(failed, region)} jobs failed in the last 7 days`;
}

/** The Sign-in activity line (D8.5): each nonzero count, joined by "and". */
export function signInActivityText(
  failedSignIns: number,
  lockouts: number,
  region: WorkspaceRegion | undefined,
): string {
  const named = [
    ...(failedSignIns
      ? [
          `${count(failedSignIns, region)} failed sign-in${failedSignIns === 1 ? "" : "s"}`,
        ]
      : []),
    ...(lockouts
      ? [`${count(lockouts, region)} lockout${lockouts === 1 ? "" : "s"}`]
      : []),
  ];
  if (!named.length) return "No failed sign-ins or lockouts in the last 7 days";
  return `${named.join(" and ")} in the last 7 days`;
}

// The 30-day timeline (S5-C3, D15).

export type HealthPeriod = {
  part: PartKey;
  kind: "not_working" | "slow";
  started_at: string;
  /** Null while the period is still going. */
  ended_at: string | null;
};

/** The contract's identity of a period: an ongoing one keeps it when it ends. */
export function healthPeriodKey(period: HealthPeriod): string {
  return `${period.part}:${period.kind}:${period.started_at}`;
}

/**
 * The rows the person opened: the fresh first page, then the older pages
 * without the periods the first page already holds (an ongoing period that
 * ended moves pages). Server order is kept.
 */
export function mergePeriods(
  first: readonly HealthPeriod[],
  older: readonly HealthPeriod[],
): HealthPeriod[] {
  const seen = new Set(first.map(healthPeriodKey));
  const rows = [...first];
  for (const period of older) {
    const key = healthPeriodKey(period);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(period);
  }
  return rows;
}

// Plural subjects take plural verbs ("Files and pictures were slow").
const PLURAL_PARTS: ReadonlySet<PartKey> = new Set(["files"]);

/** D15.3: minutes, hours and minutes, or days and hours; at least 1 minute. */
export function periodLength(
  minutes: number,
  region: WorkspaceRegion | undefined,
): string {
  const total = Math.max(1, Math.round(minutes));
  const unit = (value: number, name: string) =>
    `${count(value, region)} ${name}${value === 1 ? "" : "s"}`;
  const join = (
    major: number,
    majorName: string,
    minor: number,
    minorName: string,
  ) =>
    minor
      ? `${unit(major, majorName)} ${unit(minor, minorName)}`
      : unit(major, majorName);
  if (total < 60) return unit(total, "minute");
  if (total < 1440)
    return join(Math.floor(total / 60), "hour", total % 60, "minute");
  return join(
    Math.floor(total / 1440),
    "day",
    Math.floor((total % 1440) / 60),
    "hour",
  );
}

/**
 * D15.4: the day of `value` in a sentence, in the organization's zone, with
 * the steps of the sign-in feed: "today", "yesterday", "on Tuesday" for the
 * rest of the week, else "on Nov 1".
 */
function sentenceDay(
  value: string,
  now: Date,
  region: WorkspaceRegion | undefined,
): string {
  const dayOf = formatter(region, { dateStyle: "short" });
  const date = dayOf(value);
  const back = [0, 1, 2, 3, 4, 5, 6].find(
    (days) =>
      dayOf(new Date(now.getTime() - days * 86_400_000).toISOString()) === date,
  );
  if (back === 0) return "today";
  if (back === 1) return "yesterday";
  if (back !== undefined)
    return `on ${formatter(region, { weekday: "long" })(value)}`;
  return `on ${formatter(region, { month: "short", day: "numeric" })(value)}`;
}

export type PeriodRow = {
  key: string;
  kind: HealthPeriod["kind"];
  sentence: string;
  /** The start and end times; null while the period is still going. */
  meta: { from: string; to: string } | null;
};

/** One period as the timeline reads it (D15.2 to D15.4). */
export function periodRow(
  period: HealthPeriod,
  now: Date,
  region: WorkspaceRegion | undefined,
): PeriodRow {
  const name = PART_NAMES[period.part];
  const plural = PLURAL_PARTS.has(period.part);
  const day = sentenceDay(period.started_at, now, region);
  const key = healthPeriodKey(period);
  if (period.ended_at === null) {
    const time = checkTime(period.started_at, region);
    const verb =
      period.kind === "slow"
        ? plural
          ? "have been slow"
          : "has been slow"
        : plural
          ? "have not worked"
          : "has not worked";
    return {
      key,
      kind: period.kind,
      sentence: `${name} ${verb} since ${time} ${day}.`,
      meta: null,
    };
  }
  const minutes =
    (Date.parse(period.ended_at) - Date.parse(period.started_at)) / 60_000;
  const verb =
    period.kind === "slow"
      ? plural
        ? "were slow"
        : "was slow"
      : "did not work";
  const start = dayAndTime(period.started_at, now, region);
  const end = dayAndTime(period.ended_at, now, region);
  const dayOf = formatter(region, { dateStyle: "short" });
  const sameDay = dayOf(period.started_at) === dayOf(period.ended_at);
  return {
    key,
    kind: period.kind,
    sentence: `${name} ${verb} for ${periodLength(minutes, region)} ${day}.`,
    meta: sameDay
      ? { from: start.time, to: end.time }
      : {
          from: `${start.date} at ${start.time}`,
          to: `${end.date} at ${end.time}`,
        },
  };
}

// Samples are kept 30 days and deleted hourly, so a full history's oldest
// sample is a little under 30 days old. A history at least 29 days deep
// counts as the whole 30 days.
const FULL_HISTORY_MS = 29 * 86_400_000;

/** The timeline with no period (S5-C3, D15.6). */
export function timelineEmptyText(
  oldestSampleAt: string | null,
  now: Date,
  region: WorkspaceRegion | undefined,
): string {
  if (oldestSampleAt === null) return "No history is recorded yet.";
  if (now.getTime() - Date.parse(oldestSampleAt) >= FULL_HISTORY_MS)
    return "No problems in the last 30 days.";
  const date = formatter(region, { month: "short", day: "numeric" })(
    oldestSampleAt,
  );
  return `No problems since ${date}.`;
}

// Sizes (D17, D18): decimal units with exact names.

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/**
 * D17: the largest unit with a value of 1 or more; one decimal under 10,
 * whole numbers from 10, no trailing ".0". The number follows the workspace
 * locale; the unit names stay B, KB, MB, GB and TB.
 */
export function sizeText(
  bytes: number,
  region: WorkspaceRegion | undefined,
): string {
  let unit = 0;
  let value = bytes;
  while (value >= 1000 && unit < SIZE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  let rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  if (rounded >= 1000 && unit < SIZE_UNITS.length - 1) {
    unit += 1;
    rounded = Math.round((rounded / 1000) * 10) / 10;
  }
  const number = new Intl.NumberFormat(region?.locale, {
    maximumFractionDigits: rounded < 10 ? 1 : 0,
  }).format(rounded);
  return `${number} ${SIZE_UNITS[unit]}`;
}

/** Block 3's File storage line (S5-C7, D17). */
export function storageText(
  bytes: number | null,
  region: WorkspaceRegion | undefined,
): string {
  if (bytes === null) return "File storage cannot be read now.";
  if (bytes === 0) return "No files are stored yet";
  if (bytes < 1000) return "Files use less than 1 KB";
  return `Files use ${sizeText(bytes, region)}`;
}

// Block 4, Installation (S5-C6, D18).

export type WorkerKey =
  | "record_triggers"
  | "report_scheduling"
  | "comms_jobs"
  | "provider_signout"
  | "backup_runner";
export type WorkerState = "running" | "not_seen" | "never_seen";
/** The installation owner's part of the status (API contract S5). */
export type InstallationStatus = {
  database_bytes: number | null;
  database_measured_at: string | null;
  workers: {
    key: WorkerKey;
    state: WorkerState;
    last_seen_at: string | null;
  }[];
};

/** D18.2: always this order, each named by what it does. */
export const WORKER_LABELS: readonly [WorkerKey, string][] = [
  ["record_triggers", "Record triggers"],
  ["report_scheduling", "Scheduled reports"],
  ["comms_jobs", "OpenComms jobs"],
  ["provider_signout", "Sign-out cleanup"],
  ["backup_runner", "Backup runner"],
];

export type WorkerRow = {
  key: WorkerKey;
  label: string;
  /** Null when the response does not name the worker ("—"). */
  state: WorkerState | null;
  word: string;
  detail: string | null;
};

export type InstallationRows = { database: string; workers: WorkerRow[] };

/** Block 4's values (D18.3); the server decides each worker's state. */
export function installationRows(
  installation: InstallationStatus,
  now: Date,
  region: WorkspaceRegion | undefined,
): InstallationRows {
  return {
    database:
      installation.database_bytes === null
        ? "Cannot be read now."
        : sizeText(installation.database_bytes, region),
    workers: WORKER_LABELS.map(([key, label]) => {
      const worker = installation.workers.find((item) => item.key === key);
      if (!worker) return { key, label, state: null, word: "—", detail: null };
      if (worker.state === "running")
        return { key, label, state: "running", word: "Running", detail: null };
      if (worker.state === "not_seen" && worker.last_seen_at) {
        const { today, date, time } = dayAndTime(
          worker.last_seen_at,
          now,
          region,
        );
        return {
          key,
          label,
          state: "not_seen",
          word: today
            ? `Not seen since ${time}`
            : `Not seen since ${date} at ${time}`,
          detail: "Its work waits until it runs again.",
        };
      }
      // Never seen; also a not-seen worker the server gives no time for.
      return {
        key,
        label,
        state: "never_seen",
        word: "Not seen yet",
        detail: "Check that it runs on your server.",
      };
    }),
  };
}
