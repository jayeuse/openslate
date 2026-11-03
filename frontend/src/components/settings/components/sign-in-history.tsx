"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Lock,
  LogIn,
  LogOut,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type Ref } from "react";

import { Button } from "@/components/ui/button";
import { ErrorReference } from "@/components/ui/error-reference";
import { LoadingRegion } from "@/components/ui/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import {
  extendsRead,
  readStamp,
} from "@/components/systems/openview/adapters/openview-queries";
import {
  listOwnSignInEvents,
  type SignInEvent,
} from "@/components/systems/platform/adapters/account-api";
import { signInHistoryOptions } from "@/components/systems/platform/adapters/platform-queries";
import { apiErrorReference } from "@/lib/api-errors";
import { cn } from "@/lib/utils";

import { signInEventWords, type SignInEventWords } from "../domain/sessions";
import type { SettingsRegion } from "../hooks/use-settings-region";

/** The older pages after the first: "none" when no older event exists. */
export type OlderEvents =
  "none" | "idle" | "loading" | { failed: string | undefined };

export type SignInHistoryState =
  /** The identity read failed; the sessions block shows that error. */
  | { kind: "waiting" }
  | { kind: "loading" }
  | { kind: "error"; reference: string | undefined }
  | { kind: "rows"; rows: SignInEventWords[]; older: OlderEvents };

const ICONS: Readonly<Record<SignInEvent["kind"], LucideIcon>> = {
  signed_in: LogIn,
  sign_in_failed: ShieldAlert,
  locked_out: Lock,
  session_ended: LogOut,
};

const TONES: Readonly<Record<SignInEventWords["tone"], string>> = {
  muted: "text-muted-foreground",
  danger: "text-danger-text",
  warn: "text-warn-text",
};

const errorBlockClassName =
  "flex flex-wrap items-center gap-3 rounded-[var(--radius)] border p-3";

/**
 * Your sign-in history (S4-C2, docs/specs/system-health.md D9): the first
 * ten events from the cached read, then ten more for each "Show older". The
 * history reads when Settings opens and again after a session ends
 * (`useAccountSecurity`); it has no poll and no focus refresh.
 */
export function SignInHistory({
  accountId,
  identityFailed,
  region,
}: {
  accountId: string;
  /** No account id because the identity read failed (D13 item 4). */
  identityFailed: boolean;
  region: SettingsRegion;
}) {
  const query = useQuery(signInHistoryOptions(accountId));
  // Pages after the first belong to the read that gave the first page.
  const [older, setOlder] = useState<{
    readAt: number;
    events: SignInEvent[];
    hasMore: boolean;
    status: Exclude<OlderEvents, "none">;
  } | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const extension = older && extendsRead(older.readAt, query) ? older : null;
  const first = query.data;

  let state: SignInHistoryState;
  if (first) {
    const events = [...first.items, ...(extension?.events ?? [])];
    const hasMore = extension ? extension.hasMore : first.pagination.has_more;
    const status = extension?.status ?? "idle";
    state = {
      kind: "rows",
      rows: events.map((event) => signInEventWords(event, region.display)),
      older: typeof status === "object" ? status : hasMore ? status : "none",
    };
  } else if (!accountId && identityFailed) state = { kind: "waiting" };
  else if (query.isError)
    state = { kind: "error", reference: apiErrorReference(query.error) };
  else state = { kind: "loading" };

  async function showOlder() {
    if (!first || extension?.status === "loading") return;
    const readAt = readStamp(query);
    const loaded = extension?.events ?? [];
    const base = {
      readAt,
      events: loaded,
      hasMore: extension?.hasMore ?? first.pagination.has_more,
    };
    setOlder({ ...base, status: "loading" });
    try {
      const page = await listOwnSignInEvents(
        first.items.length + loaded.length,
      );
      setOlder({
        readAt,
        events: [...loaded, ...page.items],
        hasMore: page.pagination.has_more,
        status: "idle",
      });
      const next = page.items[0];
      if (next) setFocusKey(`${next.kind}:${next.id}`);
    } catch (error) {
      setOlder({ ...base, status: { failed: apiErrorReference(error) } });
    }
  }

  return (
    <SignInHistoryView
      state={state}
      timeState={region.state}
      focusKey={focusKey}
      onRetry={() => void query.refetch()}
      onShowOlder={() => void showOlder()}
    />
  );
}

/** The history for one state, below the active sessions (D9.1 to D9.5). */
export function SignInHistoryView({
  state,
  timeState,
  focusKey,
  onRetry,
  onShowOlder,
}: {
  state: SignInHistoryState;
  timeState: SettingsRegion["state"];
  /** The first row of the page that loaded last; it takes focus. */
  focusKey: string | null;
  onRetry: () => void;
  onShowOlder: () => void;
}) {
  const target = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (focusKey) target.current?.focus();
  }, [focusKey]);
  const older = state.kind === "rows" ? state.older : "none";
  return (
    <div className="mt-2 grid min-w-0 gap-2">
      <div>
        <h3
          id="sign-in-history-heading"
          className="text-foreground text-sm font-semibold"
        >
          Your sign-in history
        </h3>
        <p className="text-muted-foreground text-sm">
          Sign-ins, failed attempts and ended sessions on your account, newest
          first. If you do not recognize one, change your password.
        </p>
      </div>
      <LoadingRegion
        loading={state.kind === "loading"}
        label="Loading sign-in history…"
        skeleton={
          <div aria-hidden="true" className="grid gap-1">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        }
      >
        {state.kind === "waiting" ? (
          // One cause, one error, one retry: the sessions block above
          // shows the failure and its retry reads the identity again.
          <span className="text-muted-foreground flex min-h-11 items-center text-sm">
            Your sign-in history shows when your sessions load.
          </span>
        ) : state.kind === "error" ? (
          <div className={errorBlockClassName}>
            <p role="alert" className="text-destructive mr-auto text-sm">
              Sign-in history could not be loaded. Try again.
            </p>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 xl:min-h-8"
              onClick={onRetry}
            >
              Retry sign-in history
            </Button>
            <ErrorReference id={state.reference} className="basis-full" />
          </div>
        ) : state.kind === "rows" && state.rows.length === 0 ? (
          <span className="text-muted-foreground flex min-h-11 items-center text-sm">
            No sign-in events are recorded yet.
          </span>
        ) : state.kind === "rows" ? (
          <ol
            aria-label="Your sign-in history"
            className="border-border @container min-w-0 rounded-[var(--radius)] border"
          >
            {state.rows.map((row) => (
              <HistoryRow
                key={row.key}
                row={row}
                timeState={timeState}
                rowRef={row.key === focusKey ? target : undefined}
              />
            ))}
          </ol>
        ) : null}
      </LoadingRegion>
      {typeof older === "object" ? (
        <div className={errorBlockClassName}>
          <p role="alert" className="text-destructive mr-auto text-sm">
            Older sign-in events could not be loaded.
          </p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 xl:min-h-8"
            onClick={onShowOlder}
          >
            Retry
          </Button>
          <ErrorReference id={older.failed} className="basis-full" />
        </div>
      ) : older === "idle" || older === "loading" ? (
        <div>
          {/* A focused button that turns disabled loses focus, so a running
              page uses aria-disabled and ignores presses (D9.3). */}
          <Button
            type="button"
            variant="outline"
            className="min-h-11 xl:min-h-8"
            aria-disabled={older === "loading" || undefined}
            aria-busy={older === "loading" || undefined}
            onClick={() => {
              if (older !== "loading") onShowOlder();
            }}
          >
            Show older
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function HistoryRow({
  row,
  timeState,
  rowRef,
}: {
  row: SignInEventWords;
  timeState: SettingsRegion["state"];
  rowRef: Ref<HTMLLIElement> | undefined;
}) {
  const Icon = ICONS[row.kind];
  const time =
    timeState === "loading" ? "Loading organization date settings…" : row.time;
  return (
    <li
      ref={rowRef}
      tabIndex={-1}
      className="border-border focus:ring-ring flex min-h-14 min-w-0 items-start gap-2.5 border-b px-3 py-2 outline-none last:border-b-0 focus:ring-2 focus:ring-inset md:min-h-10 md:items-center md:py-1.5"
    >
      <Icon
        aria-hidden="true"
        className={cn("mt-0.5 size-4 shrink-0 md:mt-0", TONES[row.tone])}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 md:flex-row md:items-center md:gap-2.5">
        <span className="font-medium md:shrink-0">{row.sentence}</span>
        <span className="text-muted-foreground flex min-w-0 flex-wrap gap-x-1 text-[0.8125rem] tabular-nums md:ml-auto md:justify-end">
          <span className="whitespace-nowrap">
            <span title={row.userAgent ?? undefined}>{row.device}</span>
            <span aria-hidden="true"> ·</span>
          </span>
          <span className="break-all">
            {row.address}
            <span aria-hidden="true"> ·</span>
          </span>
          <span className="whitespace-nowrap">{time}</span>
        </span>
      </span>
    </li>
  );
}
