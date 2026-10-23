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
import { AdvancedSection } from "@/components/ui/advanced-section";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/disabled-reason";
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
    pending: "Sending…",
    description:
      "A recovery link goes to their sign-in email. We cannot confirm the email arrived. They stay signed in on their devices.",
  },
  revoke: {
    title: "Send recovery and sign out everywhere?",
    confirm: "Send and sign out",
    pending: "Sending…",
    description:
      "This signs them out on every device, then sends a recovery link to their sign-in email. If the email does not send, they stay signed out. They can sign in again.",
  },
  reset: {
    title: "Reset two-step verification?",
    confirm: "Reset two-step verification",
    pending: "Resetting…",
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
  // The action whose result and errors show beside its own buttons.
  const [ran, setRan] = useState<Action | null>(null);
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
    setRan(selected);
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
      // The dialog keeps its pending label until the request answers.
      setAction(null);
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
      setAction(null);
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

  /**
   * Why an action cannot run, or null. Only lasting states lock a button: a
   * running action or a fresh read is shown in the dialog instead, so the
   * button never changes under the focus it gets back.
   */
  function reasonFor(kind: Action): string | null {
    if (!data?.status.target_eligible)
      return "This person is not eligible for security actions.";
    if (kind !== "reset" && !data.status.smtp_configured)
      return "Recovery email is not turned on.";
    if (kind === "reset" && data.assurance !== "aal2")
      return "Complete your own two-step verification first.";
    return null;
  }

  // Two-step as recorded by the last read: Off has nothing to reset.
  const resettable = (data?.status.verified_factor_count ?? 0) > 0;
  const outcome = (
    <>
      {notice ? (
        <Alert role="status" variant="success" className="mt-3">
          {notice}
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive" className="mt-3">
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
    </>
  );

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
              ? "Two-step verification: Off"
              : "Two-step verification: On"}
          </Badge>
          {!data.status.target_eligible ? (
            <Alert variant="warning">
              This person is not eligible for security actions. Invited people
              use the invitation actions in Details.
            </Alert>
          ) : null}
          <section
            aria-labelledby={`${person.id}-recovery-title`}
            className="border-t pt-4"
          >
            <h4 id={`${person.id}-recovery-title`} className="font-medium">
              Recovery email
            </h4>
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
            <div className="mt-3">
              <DisabledReason reason={reasonFor("email")}>
                <Button
                  className="min-h-11 w-full sm:w-auto"
                  variant="outline"
                  onClick={() => setAction("email")}
                >
                  Send recovery email
                </Button>
              </DisabledReason>
            </div>
            {ran === "email" ? outcome : null}
          </section>
          {/* Rare and risky: last, closed, in danger ink (the Advanced Last
              Rule); each result stays beside its own action. */}
          <AdvancedSection
            storageKey="access.person-security"
            summary={
              resettable
                ? "Recovery and sign out, Reset two-step"
                : "Recovery and sign out"
            }
          >
            <section aria-labelledby={`${person.id}-signout-title`}>
              <h4 id={`${person.id}-signout-title`} className="font-medium">
                Recovery and sign out
              </h4>
              <p className="text-muted-foreground mt-1 text-sm">
                Signs them out on every device, then sends a recovery link.
              </p>
              <div className="mt-2 sm:-ml-3">
                <DisabledReason reason={reasonFor("revoke")}>
                  <Button
                    className="text-danger-text min-h-11 w-full sm:w-auto"
                    variant="ghost"
                    onClick={() => setAction("revoke")}
                  >
                    Send recovery and sign out
                  </Button>
                </DisabledReason>
              </div>
              {ran === "revoke" ? outcome : null}
            </section>
            {/* Reset only while two-step is on: there is nothing to reset
                when the person has no authenticator. */}
            {resettable ? (
              <section aria-labelledby={`${person.id}-mfa-title`}>
                <h4 id={`${person.id}-mfa-title`} className="font-medium">
                  Two-step verification
                </h4>
                {data.assurance !== "aal2" ? (
                  <p id={`${person.id}-mfa-reason`} className="mt-3 text-sm">
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
                <div className="mt-2 sm:-ml-3">
                  <DisabledReason
                    reason={reasonFor("reset")}
                    // The visible line says why, so it is announced once.
                    reasonId={
                      data.status.target_eligible && data.assurance !== "aal2"
                        ? `${person.id}-mfa-reason`
                        : undefined
                    }
                  >
                    <Button
                      className="text-danger-text min-h-11 w-full sm:w-auto"
                      variant="ghost"
                      onClick={() => setAction("reset")}
                    >
                      Reset two-step verification
                    </Button>
                  </DisabledReason>
                </div>
                {ran === "reset" ? outcome : null}
              </section>
            ) : null}
          </AdvancedSection>
          {/* A reset's result stays after the next read hides its block. */}
          {ran === "reset" && !resettable ? outcome : null}
        </>
      )}
      {/* A result whose action block is gone (the read failed) stays here. */}
      {!data && ran ? outcome : null}
      <AlertDialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setAction(null);
        }}
      >
        <AlertDialogContent className="access-ui slim-ui">
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
              disabled={pending}
              onClick={() => setAction(null)}
            >
              Cancel
            </Button>
            <DisabledReason
              reason={!pending && !ready ? "Checking security…" : null}
            >
              <Button
                variant={action === "email" ? "default" : "destructive"}
                className="min-h-11"
                pending={pending}
                pendingLabel={action ? copies[action].pending : undefined}
                onClick={() => void confirm()}
              >
                {action ? copies[action].confirm : "Confirm"}
              </Button>
            </DisabledReason>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
