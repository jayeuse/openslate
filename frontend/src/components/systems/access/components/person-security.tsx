"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { GuardedWorkspaceLink } from "@/components/workspace-navigation-guard";
import {
  useVerifiedWorkspaceUserId,
  useWorkspaceInteractionSuspended,
  useWorkspaceSignOut,
} from "@/components/systems/shared/runtime/workspace-identity";
import { ApiError } from "@/lib/api";
import { requestSessionRecheck } from "@/lib/auth-api";
import {
  afterPersonSecurityChange,
  personSecurityOptions,
} from "../adapters/access-queries";
import {
  recoverPerson,
  resetPersonMfa,
  personSecurityPartial,
} from "../adapters/security-api";
import {
  personSecurityFailure,
  personSecurityPartialOutcome,
  personSecuritySuccess,
  sessionsNotReloaded,
  withSessionsReloadFailure,
  type PersonSecurityAction,
} from "../helpers/person-security-outcome";
import { useAccessDraftRegistration } from "../state/draft-navigation";
import type { AccessUser } from "../state/api";

type Action = PersonSecurityAction;
const copies = {
  email: {
    title: "Send recovery email?",
    confirm: "Send email",
    description:
      "A recovery link goes to their sign-in email. We cannot confirm the email arrived. They stay signed in on their devices.",
  },
  revoke: {
    title: "Send recovery and sign out everywhere?",
    confirm: "Send and sign out",
    description:
      "This signs them out on every device, then sends a recovery link to their sign-in email. If the email does not send, they stay signed out. They can sign in again.",
  },
  reset: {
    title: "Reset two-step verification?",
    confirm: "Reset two-step verification",
    description:
      "This removes their authenticator app and signs them out everywhere. They can set up two-step verification again after they sign in.",
  },
} as const;

/** Live observations and explicitly confirmed commands belong to this actor/person. */
export function PersonSecurity({ person }: { person: AccessUser }) {
  const actorId = useVerifiedWorkspaceUserId();
  const suspended = useWorkspaceInteractionSuspended();
  const completeSignOut = useWorkspaceSignOut();
  const client = useQueryClient();
  const query = useQuery({
    ...personSecurityOptions(person.id, actorId),
    enabled: false,
  });
  const [readAccepted, setReadAccepted] = useState(false);
  const [pending, setPending] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const alive = useRef(false);
  const epoch = useRef(0);
  const operation = useRef<AbortController | null>(null);
  const curtain = useRef(suspended);
  const self = actorId === person.id;
  useAccessDraftRegistration(`person-security-${person.id}`, {
    dirty: false,
    discard: () => !operation.current,
    pending,
  });
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      epoch.current += 1;
      operation.current?.abort();
      operation.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    curtain.current = suspended;
    if (!suspended) return;
    epoch.current += 1;
    operation.current?.abort();
    operation.current = null;
    setPending(false);
    setAction(null);
    setReadAccepted(false);
    void client.cancelQueries({
      queryKey: personSecurityOptions(person.id, actorId).queryKey,
      exact: true,
    });
  }, [suspended, client, person.id, actorId]);

  const refresh = useCallback(async () => {
    if (!alive.current || curtain.current) return;
    const generation = epoch.current;
    setReadAccepted(false);
    const options = personSecurityOptions(person.id, actorId);
    try {
      await client.cancelQueries({ queryKey: options.queryKey, exact: true });
      if (!alive.current || curtain.current || generation !== epoch.current)
        return;
      await client.fetchQuery({ ...options, staleTime: 0 });
      if (alive.current && !curtain.current && generation === epoch.current)
        setReadAccepted(true);
    } catch {
      /* The query owns the unavailable state; stale facts never admit actions. */
    }
  }, [actorId, client, person.id]);
  useEffect(() => {
    if (!suspended) void refresh();
  }, [refresh, suspended]);

  // The last loaded facts stay visible while a background read runs; only a
  // fresh, accepted read admits another action.
  const data = suspended ? null : (query.data ?? null);
  const ready =
    readAccepted && Boolean(data?.status.target_eligible) && !pending;
  function current(controller: AbortController, generation: number) {
    return (
      alive.current &&
      !curtain.current &&
      epoch.current === generation &&
      operation.current === controller
    );
  }
  async function confirm() {
    if (!action || !ready || operation.current) return;
    if (action !== "reset" && !data?.status.smtp_configured) return;
    if (action === "reset" && data?.assurance !== "aal2") return;
    const selected = action;
    const controller = new AbortController();
    const generation = epoch.current;
    operation.current = controller;
    setPending(true);
    setAction(null);
    setError("");
    setNotice("");
    try {
      if (selected === "reset")
        await resetPersonMfa(person.id, controller.signal);
      else
        await recoverPerson(
          person.id,
          selected === "revoke",
          controller.signal,
        );
      if (!current(controller, generation)) return;
      setNotice(personSecuritySuccess(selected, person.email));
      if (self && selected !== "email") {
        await completeSignOut();
        return;
      }
      try {
        await afterPersonSecurityChange(client, person.id);
      } catch {
        if (current(controller, generation)) {
          setReadAccepted(false);
          setError(sessionsNotReloaded);
        }
        return;
      }
      if (current(controller, generation)) await refresh();
    } catch (caught) {
      if (!current(controller, generation)) return;
      const partial = personSecurityPartial(caught);
      setReadAccepted(false);
      if (partial) {
        const outcome = personSecurityPartialOutcome(
          selected,
          partial,
          person.email,
        );
        const sent = outcome.sent;
        if (outcome.sent) setNotice(outcome.notice);
        else setError(outcome.error);
        if (self && partial.local_revocation === "committed") {
          await completeSignOut();
          return;
        }
        try {
          await afterPersonSecurityChange(client, person.id);
          if (sent && current(controller, generation)) void refresh();
        } catch {
          if (current(controller, generation))
            setError(withSessionsReloadFailure);
        }
        if (
          self &&
          partial.local_revocation === "unconfirmed" &&
          current(controller, generation)
        )
          requestSessionRecheck();
      } else {
        setError(personSecurityFailure(caught));
        if (caught instanceof ApiError && caught.status === 401)
          requestSessionRecheck();
        else if (!(caught instanceof ApiError && caught.status === 403)) {
          try {
            await afterPersonSecurityChange(client, person.id);
          } catch {
            /* The authored outcome stays unavailable; explicit Reload remains. */
          }
          if (self && current(controller, generation)) requestSessionRecheck();
        }
      }
    } finally {
      if (current(controller, generation)) {
        operation.current = null;
        setPending(false);
      }
    }
  }

  return (
    <section aria-labelledby="person-security-title" className="space-y-5">
      <div className="flex items-start gap-3">
        <ShieldCheck
          className="text-muted-foreground mt-0.5 size-5 shrink-0"
          aria-hidden="true"
        />
        <div>
          <h3 id="person-security-title" className="font-semibold">
            Sign-in security
          </h3>
          <p className="text-muted-foreground text-sm">
            Review this person&apos;s two-step verification and recovery
            options.
          </p>
        </div>
      </div>
      {query.isError ? (
        <Alert variant="destructive">
          <p>
            {data
              ? "Security could not be reloaded. The details below may be out of date."
              : "Security could not be loaded."}
          </p>
          <Button
            className="mt-3 min-h-11 w-fit"
            variant="outline"
            onClick={() => void refresh()}
          >
            Retry security
          </Button>
        </Alert>
      ) : null}
      {!data ? (
        query.isError ? null : (
          <div aria-busy="true" aria-label="Loading person security">
            <Skeleton className="h-24 w-full" />
            {!query.isFetching && !error ? (
              <Button
                variant="outline"
                className="mt-3 min-h-11"
                onClick={() => void refresh()}
              >
                Reload security
              </Button>
            ) : null}
          </div>
        )
      ) : (
        <>
          <Badge variant="secondary">
            {data.status.verified_factor_count === 0
              ? "Two-step verification not set up"
              : "Two-step verification is set up"}
          </Badge>
          {!data.status.target_eligible ? (
            <Alert variant="warning">
              This person is not eligible for security actions. Pending
              invitations use the invitation actions in Details.
            </Alert>
          ) : null}
          <div className="border-t pt-4">
            <h4 className="font-medium">Recovery email</h4>
            <p className="text-muted-foreground mt-1 text-sm">
              Sends a recovery link to their sign-in email. We cannot confirm
              the email arrived.
            </p>
            {!data.status.smtp_configured ? (
              <p className="mt-3 text-sm">
                Recovery email is not turned on. Ask the person who set up
                OpenSlate to turn on email. You can still end sessions in
                Sessions.
              </p>
            ) : null}
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <Button
                className="min-h-11"
                variant="outline"
                disabled={!ready || !data.status.smtp_configured}
                onClick={() => setAction("email")}
              >
                Send recovery email
              </Button>
              <Button
                className="min-h-11"
                variant="outline"
                disabled={!ready || !data.status.smtp_configured}
                onClick={() => setAction("revoke")}
              >
                Send recovery and sign out
              </Button>
            </div>
          </div>
          <div className="border-t pt-4">
            <h4 className="font-medium">Two-step verification</h4>
            <p className="text-muted-foreground mt-1 text-sm">
              Reset only after you confirm the person needs recovery. This
              removes their authenticator app and signs them out everywhere.
            </p>
            {data.assurance !== "aal2" ? (
              <p className="mt-3 text-sm">
                Complete your own two-step verification in{" "}
                <GuardedWorkspaceLink
                  href="/access?view=security"
                  className="text-action-text underline underline-offset-4"
                >
                  Security
                </GuardedWorkspaceLink>{" "}
                before you reset it for someone else.
              </p>
            ) : null}
            <Button
              className="mt-3 min-h-11 w-full sm:w-auto"
              variant="outline"
              disabled={!ready || data.assurance !== "aal2"}
              onClick={() => setAction("reset")}
            >
              Reset two-step verification
            </Button>
          </div>
        </>
      )}
      {pending ? (
        <Alert role="status">Waiting for the security action to finish…</Alert>
      ) : null}
      {notice ? (
        <Alert role="status" variant="success">
          {notice}
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <p>{error}</p>
          <Button
            variant="outline"
            className="mt-3 flex min-h-11 w-fit"
            disabled={pending}
            onClick={() => void refresh()}
          >
            Reload security
          </Button>
        </Alert>
      ) : null}
      <AlertDialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setAction(null);
        }}
      >
        <AlertDialogContent className="access-ui">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {action ? copies[action].title : "Confirm security action"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {action ? copies[action].description : ""}
              {self && action !== "email"
                ? " This includes your current session. You will be signed out."
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setAction(null)}
            >
              Cancel
            </Button>
            <Button
              variant={action === "email" ? "default" : "destructive"}
              className="min-h-11"
              disabled={!ready}
              onClick={() => void confirm()}
            >
              {action ? copies[action].confirm : "Confirm"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
