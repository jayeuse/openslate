import { formatWorkspaceDateTime, type WorkspaceRegion } from "@/lib/date-time";

/**
 * What System health says (docs/specs/system-health.md, R1 to R3 and D2):
 * the four parts by what a person does, their status words and cause lines,
 * the one headline sentence, and the check line after "Check again".
 */

export type PartKey = "data" | "signing_in" | "files" | "email";
/** The contract's words, plus `unknown` for a word this page does not know. */
export type PartStatus =
  "working" | "not_working" | "not_set_up" | "set_up" | "unknown";
export type SystemPart = { key: PartKey; status: PartStatus };
export type HeadlineTone = "working" | "not_set_up" | "not_working";

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
  unknown: "—",
};

const NOT_WORKING_CAUSES: Readonly<Record<PartKey, string>> = {
  data: "Pages may not load, and changes you make may not save.",
  signing_in: "People who are signed out cannot sign in until it works again.",
  files:
    "Files and pictures cannot be uploaded or opened until it works again.",
  email:
    "Messages that need email, such as invitations, wait until email works.",
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
  if (key === "email" && status === "set_up")
    return "Slate Operations cannot yet confirm delivery.";
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

/** One headline sentence for the parts with one word (D2.2, D4 answer 8). */
function partsSentence(keys: readonly PartKey[], word: string): string {
  if (keys.length === 1) return `${SUBJECTS[keys[0]]} not ${word}.`;
  // Some names contain "and", so the list uses commas only.
  const names = keys.map((key) => PART_NAMES[key]).join(", ");
  return `Some parts are not ${word}: ${names}.`;
}

/**
 * The R3 headline (D2.2, D4 answer 8): up to two sentences, the parts that are
 * Not working, then the parts that are Not set up, with the same word as their
 * rows. "Everything else works." follows when only one sentence shows and a
 * part works or is set up. An unknown word does not count.
 */
export function systemHeadline(parts: readonly SystemPart[]): {
  sentence: string;
  tone: HeadlineTone;
} {
  const statuses = statusesInOrder(parts);
  const keysWith = (status: PartStatus) =>
    statuses.filter((part) => part.status === status).map(({ key }) => key);
  const down = keysWith("not_working");
  const notSetUp = keysWith("not_set_up");
  const tone: HeadlineTone =
    down.length > 0
      ? "not_working"
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
    ...(down.length ? [partsSentence(down, "working")] : []),
    ...(notSetUp.length ? [partsSentence(notSetUp, "set up")] : []),
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

/** "Checked at 10:42", or "Checked on Nov 1 at 23:58" when not from today. */
export function checkTimeText(
  value: string,
  now: Date,
  region?: WorkspaceRegion,
): string {
  const day = formatter(region, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const time = checkTime(value, region);
  if (day(value) === day(now.toISOString())) return `Checked at ${time}`;
  const date = formatter(region, { month: "short", day: "numeric" })(value);
  return `Checked on ${date} at ${time}`;
}

/** A person's "Check again", or the 60-second and focus refresh. */
export type CheckTrigger = "person" | "background";
/** What follows the check time: "This is the latest check" or "No change". */
export type CheckSuffix = "latest" | "no-change" | null;
export type StatusCheck = {
  parts: readonly SystemPart[];
  checked_at: string;
};

function sameParts(left: StatusCheck, right: StatusCheck): boolean {
  const a = statusesInOrder(left.parts);
  const b = statusesInOrder(right.parts);
  return a.every((part, index) => part.status === b[index].status);
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
