"use client";

import type { CSSProperties, ReactNode } from "react";
import type { Route } from "next";
import {
  ArrowRight,
  Check,
  Clock3,
  KeyRound,
  Mail,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  UserRound,
  UserRoundX,
  UsersRound,
} from "lucide-react";

import { PersonAvatar } from "@/components/person-avatar";
import { DepartmentMark } from "@/components/sandbox/department-mark";
import { Button } from "@/components/ui/button";
import { LoadingRegion } from "@/components/ui/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import { GuardedWorkspaceLink } from "@/components/workspace-navigation-guard";
import { cn } from "@/lib/utils";

import { ReadError } from "./read-error";

import type {
  AttentionItem,
  DepartmentAccessRow,
  SignInBar,
  SignInResult,
  SignInSegmentId,
} from "../helpers/overview-dashboard";

// The four Overview blocks (docs/specs/access-ui-ux-pass.md, Phase 4). Each
// draws its frame at once and holds its own loading, error, and empty
// states, so one failed read never hides the others.

/** A block's state: its reads are loading, one failed, or it is ready. */
export type BlockState<Data> =
  | { status: "loading" }
  | { status: "error"; retry: () => void }
  | { status: "ready"; data: Data };

function BlockError({
  message,
  retry,
}: {
  message: string;
  retry: () => void;
}) {
  return <ReadError className="m-3" message={message} retry={retry} />;
}

/** A bordered panel: a fixed head, a body that scrolls on desktop, a foot. */
function Panel({
  id,
  title,
  end,
  foot,
  area,
  children,
}: {
  id: string;
  title: string;
  end?: ReactNode;
  foot?: ReactNode;
  area: "signins" | "attention" | "departments";
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      data-overview-area={area}
      className="bg-card flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border"
    >
      <div className="flex min-h-11 shrink-0 items-center gap-3 border-b px-4 py-1.5">
        <h2 id={id} className="text-[0.9375rem] leading-tight font-semibold">
          {title}
        </h2>
        {end ? (
          <div className="text-muted-foreground ml-auto flex items-center text-sm">
            {end}
          </div>
        ) : null}
      </div>
      <div
        data-overview-body
        className="relative min-h-0 flex-1 overscroll-contain"
      >
        {children}
      </div>
      {foot ? (
        <div className="text-muted-foreground flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2 text-xs">
          {foot}
        </div>
      ) : null}
    </section>
  );
}

function RowsSkeleton({ rows, height }: { rows: number; height: string }) {
  return (
    <div className="divide-y">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className={cn("flex items-center px-4", height)}>
          <Skeleton className="h-4 w-full" />
        </div>
      ))}
    </div>
  );
}

// Who's here

const segmentWords: Record<SignInSegmentId, string> = {
  now: "Now",
  today: "Last day",
  week: "Last 7 days",
  month: "Last 30 days",
  older: "Older",
  never: "Never signed in",
  invited: "Invited",
};
/** Each legend item opens the People list with its filter, where one exists. */
const segmentLinks: Partial<Record<SignInSegmentId, string>> = {
  now: "/access?view=security",
  older: "/access?view=people&history=inactive&inactive_days=30",
  never: "/access?view=people&history=no-recorded-sign-in",
  invited: "/access?view=people&status=pending",
};

/** The segment's swatch: a recency ramp, Older solid, Never hatched, Invited outlined. */
function Swatch({
  id,
  className,
  style,
}: {
  id: SignInSegmentId;
  className: string;
  /** The segment's share of the bar. */
  style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden="true"
      data-segment={id}
      className={cn("access-segment inline-block shrink-0", className)}
      style={style}
    />
  );
}

export type Presence = {
  bar: SignInBar;
  /** Signed in now, newest first; avatars once the names read lands. */
  roster: {
    id: string;
    /** "You" for the viewer, else the name. */
    label: string;
    name: string;
    avatarUrl: string | null;
  }[];
  /** True when more sessions exist than one read returns. */
  partial: boolean;
};

const ROSTER_SHOWN = 3;
/** Below 640px two chips fit beside "Now". */
const ROSTER_SHOWN_PHONE = 2;

export function WhoIsHere({
  state,
  asOf,
}: {
  state: BlockState<Presence>;
  /** "As of …", once the summary is read. */
  asOf: ReactNode;
}) {
  return (
    <section
      aria-labelledby="overview-who"
      data-overview-area="who"
      className="flex min-w-0 flex-col gap-1.5"
    >
      <div className="flex flex-wrap items-baseline gap-x-2.5">
        <h2
          id="overview-who"
          className="text-[0.9375rem] leading-tight font-semibold"
        >
          Who&apos;s here
        </h2>
        {asOf}
      </div>
      {state.status === "error" ? (
        <ReadError
          message="Who's here could not be loaded."
          retry={state.retry}
        />
      ) : (
        <LoadingRegion
          loading={state.status === "loading"}
          label="Loading who's here…"
          skeleton={
            <div className="flex flex-col gap-2.5">
              <Skeleton className="h-6 w-full max-w-md xl:h-[33px]" />
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="-mt-1 h-11 w-full xl:h-7" />
            </div>
          }
        >
          {state.status === "ready" ? <Presence data={state.data} /> : null}
        </LoadingRegion>
      )}
    </section>
  );
}

function Presence({ data }: { data: Presence }) {
  const { bar, roster, partial } = data;
  const more = roster.length - ROSTER_SHOWN;
  const visible = bar.segments.filter((segment) => segment.count > 0);
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between xl:gap-8">
        <p className="text-muted-foreground [&_b]:text-foreground text-[0.9375rem] [&_b]:font-semibold [&_b]:tabular-nums">
          <b>
            {bar.now}
            {partial ? "+" : ""}
          </b>{" "}
          signed in now · <b>{bar.today}</b> in the last day · <b>{bar.week}</b>{" "}
          in the last 7 days, of <b>{bar.total}</b>{" "}
          {bar.total === 1 ? "person" : "people"}
        </p>
        {roster.length ? (
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-muted-foreground shrink-0 text-sm">Now</span>
            <ul
              aria-label="Signed in now"
              className="flex min-w-0 items-center gap-1.5"
            >
              {roster.slice(0, ROSTER_SHOWN).map((person, index) => (
                <li
                  key={person.id}
                  className={cn(
                    "shrink-0",
                    index >= ROSTER_SHOWN_PHONE && "hidden sm:block",
                  )}
                >
                  <GuardedWorkspaceLink
                    href={`/access?view=people&user=${person.id}` as Route}
                    className="hover:bg-muted flex h-11 items-center gap-2 rounded-full border pr-3 pl-1 text-sm whitespace-nowrap xl:h-8"
                  >
                    <OnlineAvatar name={person.name} url={person.avatarUrl} />
                    <span className="max-w-32 truncate">{person.label}</span>
                  </GuardedWorkspaceLink>
                </li>
              ))}
              {[
                {
                  count: roster.length - ROSTER_SHOWN_PHONE,
                  only: "sm:hidden",
                },
                { count: more, only: "hidden sm:block" },
              ].map(({ count, only }) =>
                count > 0 ? (
                  <li key={only} className={cn("shrink-0", only)}>
                    <GuardedWorkspaceLink
                      href="/access?view=security"
                      aria-label={`${count} more signed in: open Security`}
                      className="flex min-h-11 items-center rounded-sm px-1.5 text-sm text-[var(--action-text)] tabular-nums hover:underline xl:min-h-8"
                    >
                      +{count}
                    </GuardedWorkspaceLink>
                  </li>
                ) : null,
              )}
            </ul>
          </div>
        ) : null}
      </div>
      <div
        role="img"
        aria-label={bar.label}
        className="bg-muted flex h-3.5 gap-0.5 overflow-hidden rounded-sm"
      >
        {visible.map((segment) => (
          <Swatch
            key={segment.id}
            id={segment.id}
            className="h-full"
            style={{ flexGrow: segment.count, flexBasis: 0 }}
          />
        ))}
      </div>
      <ul
        aria-label="Last sign-in"
        className="-mt-1 -ml-2 grid grid-cols-2 gap-x-1 sm:flex sm:flex-wrap"
      >
        {bar.segments.map((segment) => {
          const href = segmentLinks[segment.id];
          // A link's word is in the action color; text items stay in ink.
          const content = (
            <>
              <Swatch id={segment.id} className="size-2.5 rounded-[2px]" />
              <span className={href ? "text-[var(--action-text)]" : undefined}>
                {segmentWords[segment.id]}
              </span>{" "}
              <b className="font-semibold tabular-nums">{segment.count}</b>
            </>
          );
          const item =
            "flex min-h-11 items-center gap-2 rounded-sm px-2 text-sm xl:min-h-7";
          return (
            <li key={segment.id}>
              {href ? (
                <GuardedWorkspaceLink
                  href={href as Route}
                  className={cn(item, "hover:bg-muted hover:underline")}
                >
                  {content}
                </GuardedWorkspaceLink>
              ) : (
                <span className={item}>{content}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A 24px avatar with the presence dot. */
function OnlineAvatar({ name, url }: { name: string; url: string | null }) {
  return (
    <span className="relative inline-flex shrink-0">
      <PersonAvatar name={name} avatarUrl={url} size="sm" />
      <span
        aria-hidden="true"
        className="ring-card absolute -right-px -bottom-px size-2 rounded-full bg-[var(--flow)] ring-2"
      />
    </span>
  );
}

// Recent sign-ins

export type FeedRow = {
  id: string;
  when: string;
  dateTime: string;
  /** "You", the person's name, or why there is none. */
  label: string;
  /** The person's own name, for the avatar. */
  name: string;
  /** A known person: their avatar and whether they are signed in now. */
  person: { avatarUrl: string | null; online: boolean } | null;
  address: string | null;
  result: SignInResult;
};

const resultWords: Record<SignInResult, string> = {
  "signed-in": "Signed in",
  failed: "Failed",
  locked: "Locked",
};
const resultTone: Record<SignInResult, { dot: string; text: string }> = {
  "signed-in": { dot: "bg-[var(--flow)]", text: "text-[var(--flow-text)]" },
  failed: { dot: "bg-[var(--danger)]", text: "text-[var(--danger-text)]" },
  locked: { dot: "bg-[var(--warn)]", text: "text-[var(--warn-text)]" },
};

export function RecentSignIns({ state }: { state: BlockState<FeedRow[]> }) {
  return (
    <Panel
      id="overview-signins"
      area="signins"
      title="Recent sign-ins"
      end={
        <GuardedWorkspaceLink
          href="/manage?view=audit&audit=security-events"
          className="flex min-h-11 items-center gap-1.5 font-medium text-[var(--action-text)] hover:underline xl:min-h-8"
        >
          All security events
          <ArrowRight aria-hidden="true" className="size-4" />
        </GuardedWorkspaceLink>
      }
    >
      {state.status === "error" ? (
        <BlockError
          message="Sign-ins could not be loaded."
          retry={state.retry}
        />
      ) : (
        <LoadingRegion
          loading={state.status === "loading"}
          label="Loading recent sign-ins…"
          skeleton={<RowsSkeleton rows={8} height="h-13 xl:h-10" />}
        >
          {state.status === "ready" ? (
            state.data.length ? (
              <ul aria-label="Sign-ins" className="divide-y">
                {state.data.map((row) => (
                  <SignInLine key={row.id} row={row} />
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground p-4 text-sm">
                No sign-ins yet
              </p>
            )
          ) : null}
        </LoadingRegion>
      )}
    </Panel>
  );
}

function SignInLine({ row }: { row: FeedRow }) {
  const tone = resultTone[row.result];
  return (
    <li className="grid min-h-13 grid-cols-[4.5rem_minmax(0,1fr)_6rem] items-center gap-3 px-4 text-sm sm:grid-cols-[4.5rem_minmax(0,1.3fr)_minmax(0,1fr)_6rem] xl:min-h-10">
      <time
        dateTime={row.dateTime}
        className="text-muted-foreground tabular-nums"
      >
        {row.when}
      </time>
      <span className="flex min-w-0 items-center gap-2.5">
        {row.person ? (
          row.person.online ? (
            <OnlineAvatar name={row.name} url={row.person.avatarUrl} />
          ) : (
            <PersonAvatar name={row.name} avatarUrl={row.person.avatarUrl} />
          )
        ) : (
          <span
            aria-hidden="true"
            className="bg-muted text-muted-foreground inline-grid size-6 shrink-0 place-items-center rounded-full"
          >
            <UserRound className="size-3.5" />
          </span>
        )}
        <span className="truncate font-medium">{row.label}</span>
      </span>
      <span className="text-muted-foreground hidden truncate sm:block">
        {row.address ?? "Address not recorded"}
      </span>
      <span
        className={cn(
          "inline-flex items-center gap-1.5 whitespace-nowrap",
          tone.text,
        )}
      >
        <span
          aria-hidden="true"
          className={cn("size-2 shrink-0 rounded-full", tone.dot)}
        />
        {resultWords[row.result]}
      </span>
    </li>
  );
}

// Needs attention

const attentionIcons: Record<AttentionItem["id"], ReactNode> = {
  adminsWithoutTwoStep: <ShieldAlert />,
  administrators: <ShieldCheck />,
  adminsTwoStepUnknown: <ShieldQuestion />,
  pendingInvitations: <Mail />,
  withoutGroup: <UsersRound />,
  groupsWithoutAccess: <KeyRound />,
  groupsWithoutMembers: <UserRoundX />,
  guestsEndingSoon: <Clock3 />,
};

export function NeedsAttention({
  state,
}: {
  state: BlockState<{ items: AttentionItem[]; clear: string[] }>;
}) {
  return (
    <Panel
      id="overview-attention"
      area="attention"
      title="Needs attention"
      end={
        state.status === "ready" && state.data.items.length ? (
          <span className="tabular-nums">{state.data.items.length}</span>
        ) : null
      }
    >
      {state.status === "error" ? (
        <BlockError
          message="Needs attention could not be loaded."
          retry={state.retry}
        />
      ) : (
        <LoadingRegion
          loading={state.status === "loading"}
          label="Loading what needs attention…"
          skeleton={
            <>
              <RowsSkeleton rows={4} height="h-14 xl:h-10" />
              <div className="flex h-8 items-center border-t px-4">
                <Skeleton className="h-4 w-2/3" />
              </div>
            </>
          }
        >
          {state.status === "ready" ? (
            <>
              {state.data.items.length ? (
                <ul aria-label="Items" className="divide-y">
                  {state.data.items.map((item) => (
                    <AttentionLine key={item.id} item={item} />
                  ))}
                </ul>
              ) : null}
              <p
                className={cn(
                  "text-muted-foreground flex items-start gap-2.5 px-4 py-1.5 text-sm",
                  state.data.items.length && "border-t",
                )}
              >
                <Check
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-[var(--flow-text)]"
                />
                <span>
                  All clear
                  {state.data.clear.length
                    ? `: ${state.data.clear.join(", ")}.`
                    : "."}
                </span>
              </p>
            </>
          ) : null}
        </LoadingRegion>
      )}
    </Panel>
  );
}

function AttentionLine({ item }: { item: AttentionItem }) {
  return (
    <li
      data-tone={item.tone}
      className="grid min-h-14 grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-3 px-4 py-1 text-sm xl:min-h-10"
    >
      <span
        aria-hidden="true"
        className={cn(
          "grid size-7 place-items-center rounded-sm [&_svg]:size-4",
          item.tone === "warn"
            ? "bg-[var(--warn-tint)] text-[var(--warn-text)]"
            : "bg-muted text-muted-foreground",
        )}
      >
        {attentionIcons[item.id]}
      </span>
      <span className="min-w-0">
        <span className="block">
          <b className="font-semibold tabular-nums">{item.count}</b> {item.text}
        </span>
        {item.detail ? (
          <span className="text-muted-foreground block text-xs">
            {item.detail}
          </span>
        ) : null}
      </span>
      <Button
        asChild
        variant="ghost"
        className="min-h-11 px-3 xl:h-8 xl:min-h-8 xl:px-2.5"
      >
        <GuardedWorkspaceLink
          href={item.href as Route}
          aria-label={`${item.verb}: ${item.count} ${item.text}`}
        >
          {item.verb}
        </GuardedWorkspaceLink>
      </Button>
    </li>
  );
}

// Access by department

export type DepartmentAccess = {
  rows: (DepartmentAccessRow & { index: number })[];
  administrators: number | null;
  /** "Counts from the first 100 of 121 groups.", when the read is partial. */
  partial: string | null;
};

export function AccessByDepartment({
  state,
}: {
  state: BlockState<DepartmentAccess>;
}) {
  const ready = state.status === "ready" ? state.data : null;
  return (
    <Panel
      id="overview-departments"
      area="departments"
      title="Access by department"
      end="People with access"
      foot={
        <>
          <span className="flex items-center gap-3">
            {(["read", "write", "manage"] as const).map((level) => (
              <span key={level} className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  data-level={level}
                  className="access-level inline-block h-2 w-2.5 rounded-[2px]"
                />
                {level === "read"
                  ? "Read"
                  : level === "write"
                    ? "Write"
                    : "Manage"}
              </span>
            ))}
          </span>
          {ready?.administrators ? (
            <span>
              {ready.administrators}{" "}
              {ready.administrators === 1
                ? "administrator manages"
                : "administrators manage"}{" "}
              all.
            </span>
          ) : null}
          {ready?.partial ? <span>{ready.partial}</span> : null}
        </>
      }
    >
      {state.status === "error" ? (
        <BlockError
          message="Access by department could not be loaded."
          retry={state.retry}
        />
      ) : (
        <LoadingRegion
          loading={state.status === "loading"}
          label="Loading access by department…"
          skeleton={<RowsSkeleton rows={4} height="h-12 xl:h-9" />}
        >
          {ready ? (
            ready.rows.length ? (
              <ul aria-label="Departments" className="divide-y">
                {ready.rows.map((row) => (
                  <li key={row.id}>
                    <DepartmentLine row={row} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground p-4 text-sm">
                No departments yet
              </p>
            )
          ) : null}
        </LoadingRegion>
      )}
    </Panel>
  );
}

function DepartmentLine({
  row,
}: {
  row: DepartmentAccessRow & { index: number };
}) {
  const people = `${row.people} ${row.people === 1 ? "person" : "people"}`;
  return (
    <GuardedWorkspaceLink
      href={`/access?view=people&department=${row.id}` as Route}
      aria-label={`${row.name}, ${people} with access: ${row.read} Read, ${row.write} Write, ${row.manage} Manage`}
      className="access-department-row grid min-h-12 grid-cols-[minmax(0,1fr)_3rem_7rem] items-center gap-3 px-4 text-sm outline-offset-[-2px] hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)] focus-visible:outline-2 focus-visible:outline-[var(--ring)] sm:grid-cols-[minmax(0,1fr)_4rem_7.5rem] xl:min-h-9"
    >
      <span className="flex min-w-0 items-center gap-2.5 font-medium">
        <DepartmentMark departmentIndex={row.index} />
        <span className="truncate">{row.name}</span>
      </span>
      <span className="tabular-nums">{row.people}</span>
      {/* The bar by default; the counts under the pointer, on focus, and on
          touch screens, so the levels never rest on the bar alone. */}
      <span aria-hidden="true" className="relative flex h-5 items-center">
        <span className="access-level-bar bg-muted flex h-2 w-full gap-0.5 overflow-hidden rounded-[2px]">
          {(["read", "write", "manage"] as const).map((level) =>
            row[level] ? (
              <span
                key={level}
                data-level={level}
                className="access-level h-full"
                style={{ flexGrow: row[level], flexBasis: 0 }}
              />
            ) : null,
          )}
        </span>
        <span className="access-level-counts text-muted-foreground absolute inset-0 hidden items-center justify-end text-xs whitespace-nowrap tabular-nums">
          R {row.read} · W {row.write} · M {row.manage}
        </span>
      </span>
    </GuardedWorkspaceLink>
  );
}
