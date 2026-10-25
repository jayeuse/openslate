"use client";

import { useRef } from "react";
import { Ellipsis, Laptop, LogOut, Smartphone } from "lucide-react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/disabled-reason";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LoadingRegion } from "@/components/ui/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import {
  sessionLoadErrorMessage,
  type AccountSecurity,
} from "../hooks/use-account-security";
import { endSessionTitle, sessionRowWords } from "../domain/sessions";
import type { SettingsRegion } from "../hooks/use-settings-region";

/**
 * Device sessions (PD11): 40px one-line rows with the device, the address,
 * "This device", the last activity, and a ⋯ menu whose End session is named
 * for the device; below them a quiet "Sign out other sessions". Both keep the
 * existing confirmation.
 */
export function Sessions({
  security,
  region,
}: {
  security: AccountSecurity;
  region: SettingsRegion;
}) {
  const { sessions } = security;
  const othersTrigger = useRef<HTMLButtonElement | null>(null);
  return (
    <div className="grid min-w-0 gap-2">
      <LoadingRegion
        loading={sessions.loading}
        label="Loading active sessions…"
        skeleton={
          <div aria-hidden="true" className="grid gap-1">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        }
      >
        {sessions.error ? (
          <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius)] border p-3">
            <p role="alert" className="text-destructive mr-auto text-sm">
              {sessionLoadErrorMessage(sessions.error)}
            </p>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 xl:min-h-8"
              onClick={sessions.retry}
            >
              Retry sessions
            </Button>
          </div>
        ) : sessions.list.length === 0 ? (
          <span className="text-muted-foreground flex min-h-11 items-center text-sm xl:min-h-8">
            No active sessions.
          </span>
        ) : (
          <ul
            aria-label="Active sessions"
            className="border-border @container min-w-0 rounded-[var(--radius)] border"
          >
            {sessions.list.map((session) => (
              <SessionRow
                key={session.id}
                words={sessionRowWords(session, region.display)}
                userAgent={session.user_agent}
                disabled={security.busy}
                timeState={region.state}
                onEnd={(trigger) => security.askEndSession(session, trigger)}
              />
            ))}
          </ul>
        )}
      </LoadingRegion>
      {region.state === "failed" ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-[var(--radius)] border p-3"
        >
          <span className="text-destructive mr-auto text-sm">
            {region.display
              ? "Organization date settings could not be refreshed. Session times use the last loaded settings."
              : "Organization date settings could not be loaded. Retry to format session times."}
          </span>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 xl:min-h-8"
            onClick={region.retry}
          >
            Retry date settings
          </Button>
        </div>
      ) : null}
      {sessions.actionError && (
        <p role="alert" className="text-destructive text-sm">
          {sessions.actionError}
        </p>
      )}
      {sessions.actionFeedback && (
        <p role="status" className="text-sm">
          {sessions.actionFeedback}
        </p>
      )}
      <div>
        {/* With the list loaded and no other device, the button says why it
            waits (PD60); while anything loads or runs it waits in silence. */}
        <DisabledReason
          reason={
            security.accountId &&
            !sessions.loading &&
            !sessions.error &&
            !security.busy &&
            sessions.othersCount === 0
              ? "No other sessions."
              : null
          }
        >
          <Button
            ref={othersTrigger}
            type="button"
            variant="outline"
            className="min-h-11 xl:min-h-8"
            disabled={
              !security.accountId ||
              sessions.loading ||
              Boolean(sessions.error) ||
              sessions.othersCount === 0 ||
              security.busy
            }
            onClick={() => security.askEndOthers(othersTrigger.current)}
          >
            Sign out other sessions
          </Button>
        </DisabledReason>
      </div>
      <SessionConfirmation security={security} />
    </div>
  );
}

function SessionRow({
  words,
  userAgent,
  disabled,
  timeState,
  onEnd,
}: {
  words: ReturnType<typeof sessionRowWords>;
  /** The full user agent, as the device name's tooltip. */
  userAgent: string | null;
  disabled: boolean;
  timeState: SettingsRegion["state"];
  onEnd: (trigger: HTMLElement | null) => void;
}) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const Icon = /\b(?:iOS|Android)$/.test(words.device) ? Smartphone : Laptop;
  const time =
    timeState === "loading"
      ? "Loading organization date settings…"
      : words.active;
  return (
    <li className="border-border flex min-h-14 min-w-0 items-center gap-2.5 border-b py-1.5 pr-1.5 pl-3 last:border-b-0 md:min-h-10 md:py-0">
      <Icon
        aria-hidden="true"
        className="text-muted-foreground size-4 shrink-0"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 md:flex-row md:items-center md:gap-2.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium" title={userAgent ?? undefined}>
            {words.device}
          </span>
          {words.here ? (
            // The comp's action tint marks this browser's session (PD63).
            <Badge className="bg-action-tint text-action-text shrink-0 font-medium">
              This device
            </Badge>
          ) : null}
        </span>
        <span className="text-muted-foreground min-w-0 text-[0.8125rem] whitespace-nowrap tabular-nums md:ml-auto">
          {words.address ?? "Unknown address"}
          <span aria-hidden="true"> · </span>
          <span className="@max-lg:sr-only">Last active </span>
          {time}
        </span>
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              ref={trigger}
              type="button"
              variant="ghost"
              size="icon"
              aria-label={words.actionsLabel}
              disabled={disabled}
              className="text-muted-foreground size-11 shrink-0 xl:size-7"
            />
          }
        >
          <Ellipsis aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="slim-ui">
          <DropdownMenuItem
            variant="destructive"
            aria-label={words.endLabel}
            className="min-h-11 xl:min-h-8"
            onClick={() => onEnd(trigger.current)}
          >
            <LogOut aria-hidden="true" />
            End session
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

/** The existing plain confirmation for ending one session or all others. */
function SessionConfirmation({ security }: { security: AccountSecurity }) {
  const cancel = useRef<HTMLButtonElement | null>(null);
  const { confirmation, busy } = security;
  return (
    <AlertDialog
      open={confirmation !== null}
      dismissible={!busy}
      onOpenChange={(open) => {
        if (!open && !busy) security.cancelConfirmation();
      }}
    >
      <AlertDialogContent
        initialFocus={() => cancel.current}
        finalFocus={() =>
          security.actionTrigger.current?.isConnected
            ? security.actionTrigger.current
            : false
        }
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {confirmation?.type === "other-sessions"
              ? "Sign out other sessions?"
              : endSessionTitle(confirmation?.session.user_agent ?? null)}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {confirmation?.type === "other-sessions"
              ? "Every other device signs out. This device stays signed in."
              : confirmation?.session.current
                ? "You sign out on this device."
                : "That device signs out."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button
            ref={cancel}
            variant="outline"
            className="min-h-11"
            onClick={security.cancelConfirmation}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            className="min-h-11"
            disabled={busy}
            onClick={security.confirm}
          >
            {security.ending
              ? "Ending…"
              : confirmation?.type === "other-sessions"
                ? "Sign out other sessions"
                : confirmation?.session.current
                  ? "End session and sign out"
                  : "End session"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
