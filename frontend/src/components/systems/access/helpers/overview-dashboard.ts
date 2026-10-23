import type { AccessSecurityEvent } from "../adapters/security-events-api";
import type { AccessGroup, AccessLevel } from "../state/api-contracts";

// Pure rules for the Overview dashboard (docs/specs/access-ui-ux-pass.md,
// Phase 4). Every count comes from an existing read: the user summary for
// the activity windows, admin sessions for "now", the directory totals for
// active and invited people, security events for recent sign-ins, and the
// group list for access by department.

// Who's here

export type SignInSegmentId =
  "now" | "today" | "week" | "month" | "older" | "never" | "invited";

export type SignInSegment = { id: SignInSegmentId; count: number };

export type SignInBar = {
  segments: SignInSegment[];
  /** Signed in now, as the bar shows it. */
  now: number;
  /** Active within one day, "now" included. */
  today: number;
  /** Active within seven days, "today" included. */
  week: number;
  /** Active and invited people: the whole bar. */
  total: number;
  /** The bar as one sentence, for assistive technology. */
  label: string;
};

/**
 * The bar of all active and invited people by last sign-in. The summary
 * counts active people inactive for more than 1, 7, and 30 days, and active
 * people who never signed in; active within N days is what remains. Reads
 * taken a moment apart can disagree, so every window is clamped: a window
 * is never smaller than the one inside it, and no segment is negative.
 */
export function lastSignInSegments(input: {
  active: number;
  pending: number;
  signedInNow: number;
  inactive: Record<1 | 7 | 30, number>;
  neverSignedIn: number;
}): SignInBar {
  const active = Math.max(0, input.active);
  const pending = Math.max(0, input.pending);
  const never = Math.min(Math.max(0, input.neverSignedIn), active);
  const signedIn = active - never;
  const clamp = (value: number, low: number) =>
    Math.min(Math.max(value, low), signedIn);
  const day = clamp(active - input.inactive[1] - never, 0);
  const week = clamp(active - input.inactive[7] - never, day);
  const month = clamp(active - input.inactive[30] - never, week);
  const now = Math.min(Math.max(0, input.signedInNow), day);
  const segments: SignInSegment[] = [
    { id: "now", count: now },
    { id: "today", count: day - now },
    { id: "week", count: week - day },
    { id: "month", count: month - week },
    { id: "older", count: signedIn - month },
    { id: "never", count: never },
    { id: "invited", count: pending },
  ];
  const total = active + pending;
  const words: Record<SignInSegmentId, string> = {
    now: "now",
    today: "earlier in the last day",
    week: "earlier in the last 7 days",
    month: "earlier in the last 30 days",
    older: "older",
    never: "never signed in",
    invited: "invited",
  };
  return {
    segments,
    now,
    today: day,
    week,
    total,
    label: `${total} ${total === 1 ? "person" : "people"} by last sign-in: ${segments
      .map((segment) => `${segment.count} ${words[segment.id]}`)
      .join(", ")}`,
  };
}

/** Distinct people with an active session, in the order the read gave. */
export function signedInNow(
  sessions: readonly { user_id: string; person_name: string }[],
): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const session of sessions)
    if (!seen.has(session.user_id))
      seen.set(session.user_id, session.person_name);
  return [...seen].map(([id, name]) => ({ id, name }));
}

// Recent sign-ins

export type SignInResult = "signed-in" | "failed" | "locked";

export type SignInRow = {
  id: string;
  occurredAt: string;
  /** The person, when the event names one. Failed sign-ins usually do not. */
  personId: string | null;
  /** The address the attempt came from, when it was recorded. */
  address: string | null;
  result: SignInResult;
};

/** The sign-in results the feed shows, by event type and outcome. */
function resultOf(event: AccessSecurityEvent): SignInResult | null {
  if (event.event_type === "identity.sign_in")
    return event.outcome === "success" ? "signed-in" : null;
  if (event.event_type === "identity.sign_in_failure") return "failed";
  if (event.event_type === "identity.lockout") return "locked";
  return null;
}

/** Newest first: by time, then by id, so events at one instant keep one
 * order on every page. */
function newestFirst(
  left: Pick<SignInRow, "id" | "occurredAt">,
  right: Pick<SignInRow, "id" | "occurredAt">,
) {
  return (
    Date.parse(right.occurredAt) - Date.parse(left.occurredAt) ||
    (left.id < right.id ? 1 : left.id > right.id ? -1 : 0)
  );
}

/** Several event reads merged newest first, each event once. */
export function recentSignIns(
  reads: readonly (readonly AccessSecurityEvent[])[],
  limit: number,
): SignInRow[] {
  const rows = new Map<string, SignInRow>();
  for (const event of reads.flat()) {
    const result = resultOf(event);
    if (!result || rows.has(event.id)) continue;
    const address = event.metadata.ip_address;
    rows.set(event.id, {
      id: event.id,
      occurredAt: event.occurred_at,
      personId: event.actor_id ?? event.subject_id,
      address: typeof address === "string" && address ? address : null,
      result,
    });
  }
  return [...rows.values()].sort(newestFirst).slice(0, limit);
}

/**
 * Where a page of the sign-in feed starts: the newest events (null), or the
 * events older or newer than one shown event, the cursor.
 */
export type SignInCursor = {
  direction: "older" | "newer";
  /** The cursor event's time and id. */
  at: string;
  id: string;
} | null;

export type SignInPage = {
  /** Newest first. */
  rows: SignInRow[];
  hasOlder: boolean;
  hasNewer: boolean;
};

/**
 * One page of the feed from the reads of its cursor. The reads may hold
 * events on the cursor's side of it (its own instant is read on both sides,
 * so equal times are never skipped); only events past the cursor count.
 * Older takes the `size` events after the cursor; Newer takes the `size`
 * events nearest before it, so turning back returns the same rows.
 */
export function signInPage(
  reads: readonly (readonly AccessSecurityEvent[])[],
  cursor: SignInCursor,
  size: number,
): SignInPage {
  const all = recentSignIns(reads, Number.POSITIVE_INFINITY);
  if (!cursor)
    return {
      rows: all.slice(0, size),
      hasOlder: all.length > size,
      hasNewer: false,
    };
  const mark = { id: cursor.id, occurredAt: cursor.at };
  if (cursor.direction === "older") {
    const older = all.filter((row) => newestFirst(row, mark) > 0);
    return {
      rows: older.slice(0, size),
      hasOlder: older.length > size,
      hasNewer: true,
    };
  }
  const newer = all.filter((row) => newestFirst(row, mark) < 0);
  return {
    rows: newer.slice(Math.max(0, newer.length - size)),
    hasOlder: true,
    hasNewer: newer.length > size,
  };
}

// Needs attention

export type AttentionCounts = {
  /** Active administrators. One or none leaves nobody to step in. */
  administrators: number;
  adminsWithoutTwoStep: number;
  adminsTwoStepUnknown: number;
  /** Invitations sent and not accepted, not revoked. */
  pendingInvitations: number;
  /** Members and guests, not deleted, in no group: they have no access. */
  withoutGroup: number;
  groupsWithoutAccess: number;
  groupsWithoutMembers: number;
  /** Active or pending people whose access ends within 14 days. */
  guestsEndingSoon: number;
};

export type AttentionItem = {
  id: keyof AttentionCounts;
  count: number;
  /** The words after the count, matched to it ("1 person", "2 people"). */
  text: string;
  /** One more line, only for the last administrator. */
  detail?: string;
  verb: string;
  href: string;
  tone: "warn" | "info";
};

type AttentionRule = {
  id: keyof AttentionCounts;
  /** Above zero, this needs attention. Administrators: at most one. */
  needed: (count: number) => boolean;
  one: string;
  many: string;
  /** How the All clear line names it, or null when it never shows there. */
  clear: string | null;
  detail?: string;
  verb: string;
  href: string;
  tone: AttentionItem["tone"];
};

// In order of attention: administrators without two-step first.
const attentionRules: AttentionRule[] = [
  {
    id: "adminsWithoutTwoStep",
    needed: (count) => count > 0,
    one: "administrator without two-step",
    many: "administrators without two-step",
    clear: "administrators without two-step",
    verb: "Review",
    href: "/access?view=people&role=admin&mfa=without",
    tone: "warn",
  },
  {
    id: "administrators",
    needed: (count) => count <= 1,
    one: "active administrator",
    many: "active administrators",
    clear: null,
    detail: "Make a second person an administrator.",
    verb: "Show",
    href: "/access?view=people&role=admin&status=active",
    tone: "warn",
  },
  {
    id: "adminsTwoStepUnknown",
    needed: (count) => count > 0,
    one: "administrator, two-step unknown",
    many: "administrators, two-step unknown",
    clear: null,
    verb: "Review",
    href: "/access?view=people&role=admin&mfa=unknown",
    tone: "info",
  },
  {
    id: "pendingInvitations",
    needed: (count) => count > 0,
    one: "invitation not accepted",
    many: "invitations not accepted",
    clear: "invitations not accepted",
    verb: "Review",
    href: "/access?view=people&status=pending",
    tone: "info",
  },
  {
    id: "withoutGroup",
    needed: (count) => count > 0,
    one: "person in no group",
    many: "people in no group",
    clear: "people in no group",
    verb: "Add to groups",
    href: "/access?view=people&group=none",
    tone: "info",
  },
  {
    id: "groupsWithoutAccess",
    needed: (count) => count > 0,
    one: "group without access",
    many: "groups without access",
    clear: "groups without access",
    verb: "Review",
    href: "/access?view=groups&filter=no-access",
    tone: "info",
  },
  {
    id: "groupsWithoutMembers",
    needed: (count) => count > 0,
    one: "group without members",
    many: "groups without members",
    clear: "groups without members",
    verb: "Show",
    href: "/access?view=groups&filter=no-members",
    tone: "info",
  },
  {
    id: "guestsEndingSoon",
    needed: (count) => count > 0,
    one: "guest's access ends soon",
    many: "guests' access ends soon",
    clear: "guest access ending soon",
    verb: "Show",
    href: "/access?view=people&status=ending",
    tone: "info",
  },
];

/** The items that need attention, in order, and the names of the rest. */
export function attentionItems(counts: AttentionCounts): {
  items: AttentionItem[];
  clear: string[];
} {
  const items: AttentionItem[] = [];
  const clear: string[] = [];
  for (const rule of attentionRules) {
    const count = counts[rule.id];
    if (rule.needed(count))
      items.push({
        id: rule.id,
        count,
        text: count === 1 ? rule.one : rule.many,
        ...(rule.detail ? { detail: rule.detail } : {}),
        verb: rule.verb,
        href: rule.href,
        tone: rule.tone,
      });
    else if (rule.clear) clear.push(rule.clear);
  }
  return { items, clear };
}

// Access by department

export type DepartmentAccessRow = {
  id: string;
  name: string;
  /** Group members with any access in the department. */
  people: number;
  read: number;
  write: number;
  manage: number;
};

const rank: Record<AccessLevel, number> = { read: 1, write: 2, manage: 3 };

/**
 * People with access to each department, from the groups' access entries
 * and members. A person counts once, at their highest level from any group;
 * an entry on one module counts on its department, as the People
 * department filter does. A guest counts at Read whatever the group gives,
 * as the server caps guests. Administrators are not group members: they
 * manage every department and are counted apart.
 */
export function departmentAccess(
  departments: readonly { id: string; name: string }[],
  groups: readonly AccessGroup[],
  guests: ReadonlySet<string> = new Set(),
): DepartmentAccessRow[] {
  const levels = new Map<string, Map<string, AccessLevel>>();
  for (const group of groups) {
    if (group.is_deleted) continue;
    for (const entry of group.access) {
      let people = levels.get(entry.department_id);
      if (!people) {
        people = new Map();
        levels.set(entry.department_id, people);
      }
      for (const member of group.member_ids) {
        const level: AccessLevel = guests.has(member) ? "read" : entry.level;
        const current = people.get(member);
        if (!current || rank[level] > rank[current]) people.set(member, level);
      }
    }
  }
  return departments.map((department) => {
    const row: DepartmentAccessRow = {
      id: department.id,
      name: department.name,
      people: 0,
      read: 0,
      write: 0,
      manage: 0,
    };
    for (const level of levels.get(department.id)?.values() ?? []) {
      row.people += 1;
      row[level] += 1;
    }
    return row;
  });
}
