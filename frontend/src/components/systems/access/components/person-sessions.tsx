"use client";

import { useEffect, useState } from "react";
import { useWorkspaceDisplayRegion } from "@/components/use-display-region";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut } from "lucide-react";

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
import { LoadingRegion } from "@/components/ui/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { TablePagination } from "@/components/ui/table-pagination";

import { accessKeys, userSessionsOptions } from "../adapters/access-queries";
import { formatDateTime, peopleErrorMessage } from "../helpers/people";
import {
  revokeAccessUserSession,
  revokeAccessUserSessions,
  type AccessSession,
  type AccessUser,
} from "../state/api";
import { ActionError } from "./editor-conflicts";
import { ReadError } from "./read-error";

type Revoke = { kind: "one"; session: AccessSession } | { kind: "all" };

function deviceLabel(session: AccessSession): string {
  return session.user_agent?.trim() || "Unknown device";
}

export function PersonSessions({
  person,
  self,
}: {
  person: AccessUser;
  /** The signed-in administrator is looking at their own sessions. */
  self: boolean;
}) {
  const client = useQueryClient();
  const region = useWorkspaceDisplayRegion();
  const [pageIndex, setPageIndex] = useState(0);
  const sessions = useQuery(
    userSessionsOptions(person.id, { limit: 10, offset: pageIndex * 10 }),
  );
  const [revoke, setRevoke] = useState<Revoke | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const items = sessions.data?.items ?? [];
  const total = sessions.data?.pagination.total ?? 0;
  useEffect(() => {
    if (sessions.data)
      setPageIndex((current) =>
        Math.min(
          current,
          Math.max(0, Math.ceil(sessions.data.pagination.total / 10) - 1),
        ),
      );
  }, [sessions.data]);

  async function confirm() {
    if (!revoke || pending) return;
    setPending(true);
    setError("");
    try {
      if (revoke.kind === "one")
        await revokeAccessUserSession(person.id, revoke.session.id);
      else await revokeAccessUserSessions(person.id);
      toast.add({
        title: revoke.kind === "one" ? "Session ended" : "Sessions ended",
        type: "success",
      });
      setRevoke(null);
      void client.invalidateQueries({
        queryKey: accessKeys.userSessions(person.id),
      });
      void client.invalidateQueries({ queryKey: accessKeys.directory() });
    } catch (caught) {
      setError(
        peopleErrorMessage(
          caught,
          "The session could not be ended. Try again.",
        ),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="person-sessions-title" className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 id="person-sessions-title" className="font-semibold">
            Sessions
          </h3>
          {/* With no sessions the empty state below says it once. */}
          {sessions.data && total === 0 ? null : (
            <p className="text-muted-foreground text-sm tabular-nums">
              {sessions.data
                ? `${total} active ${total === 1 ? "session" : "sessions"}`
                : "Devices where this person is signed in."}
            </p>
          )}
        </div>
        {(
          self
            ? total > (items.some((session) => session.current) ? 1 : 0)
            : total > 0
        ) ? (
          <Button
            variant="outline"
            className="min-h-11 w-full sm:w-auto"
            onClick={() => {
              setError("");
              setRevoke({ kind: "all" });
            }}
          >
            <LogOut aria-hidden="true" />
            {self ? "Sign out other sessions" : "Sign out everywhere"}
          </Button>
        ) : null}
      </div>
      {sessions.isError ? (
        <ReadError
          message="Sessions could not be loaded."
          retry={() => void sessions.refetch()}
        />
      ) : (
        <LoadingRegion
          loading={sessions.isPending}
          label="Loading sessions…"
          skeleton={<Skeleton className="h-20 w-full" />}
        >
          {items.length === 0 ? (
            <p className="text-muted-foreground rounded-lg border p-4 text-sm">
              No active sessions.
            </p>
          ) : (
            <ul
              aria-label="Sessions"
              className="divide-border divide-y rounded-lg border px-4"
            >
              {items.map((session) => (
                <li
                  key={session.id}
                  className="flex min-w-0 flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      <span className="min-w-0 break-words">
                        {deviceLabel(session)}
                      </span>
                      {session.current ? (
                        <Badge variant="secondary">This session</Badge>
                      ) : null}
                    </p>
                    <p className="text-muted-foreground text-sm break-all">
                      Sign-in address: {session.ip_address ?? "Unknown"}
                    </p>
                    <p className="text-muted-foreground text-sm">
                      Last active {formatDateTime(session.refreshed_at, region)}{" "}
                      · Signed in {formatDateTime(session.created_at, region)}
                    </p>
                  </div>
                  {session.current ? null : (
                    <Button
                      variant="ghost"
                      className="min-h-11 w-full shrink-0 sm:w-auto"
                      aria-label={`Sign out ${deviceLabel(session)}, last active ${formatDateTime(session.refreshed_at, region)}`}
                      onClick={() => {
                        setError("");
                        setRevoke({ kind: "one", session });
                      }}
                    >
                      Sign out
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {total > 10 ? (
            <TablePagination
              ariaLabel="Session pages"
              total={total}
              offset={sessions.data?.pagination.offset ?? pageIndex * 10}
              rowCount={items.length}
              pageSize={10}
              onPageIndexChange={setPageIndex}
              disabled={sessions.isFetching}
            />
          ) : null}
        </LoadingRegion>
      )}

      <AlertDialog
        open={revoke !== null}
        onOpenChange={(open) => !open && !pending && setRevoke(null)}
      >
        <AlertDialogContent className="access-ui slim-ui">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {revoke?.kind === "one"
                ? "Sign out this session?"
                : self
                  ? "Sign out your other sessions?"
                  : "Sign out everywhere?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {revoke?.kind === "one"
                ? `${deviceLabel(revoke.session)} will need to sign in again.`
                : self
                  ? "Your other devices will need to sign in again. This session stays signed in."
                  : "Every device will need to sign in again."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ActionError message={error} />
          <AlertDialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={pending}
              onClick={() => setRevoke(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="min-h-11"
              pending={pending}
              pendingLabel="Signing out…"
              onClick={() => void confirm()}
            >
              Sign out
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
