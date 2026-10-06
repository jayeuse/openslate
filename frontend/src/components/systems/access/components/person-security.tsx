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
import { apiErrorMessage } from "@/lib/api-errors";
import {
  afterPersonSecurityChange,
  personSecurityOptions,
} from "../adapters/access-queries";
import {
  recoverPerson,
  resetPersonMfa,
  personSecurityPartial,
} from "../adapters/security-api";
import { useAccessDraftRegistration } from "../state/draft-navigation";
import type { AccessUser } from "../state/api";

type Action = "email" | "revoke" | "reset";
const copies = {
  email: {
    title: "Send recovery email?",
    confirm: "Send email",
    description:
      "The bound sign-in email gets a recovery request. Provider acceptance does not confirm delivery. Existing sessions stay signed in.",
  },
  revoke: {
    title: "Send recovery and sign out everywhere?",
    confirm: "Send and sign out",
    description:
      "All local sessions are revoked before email is requested. If email fails, those sessions stay signed out. The person can sign in again.",
  },
  reset: {
    title: "Reset multi-factor authentication?",
    confirm: "Reset MFA",
    description:
      "Factors are removed first, then all local sessions are revoked. An interruption can leave a partial result. The person can set up MFA again after signing in.",
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
  useAccessDraftRegistration(
    `person-security-${person.id}`,
    false,
    () => !operation.current,
    pending,
  );
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

  const data = readAccepted && !suspended && !query.isError ? query.data : null;
  const ready = Boolean(data?.status.target_eligible) && !pending;
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
      setNotice(
        selected === "reset"
          ? "Factors cleared and local sessions revoked."
          : selected === "revoke"
            ? "Local sessions revoked. Recovery email request accepted. Delivery is not confirmed."
            : "Recovery email request accepted. Delivery is not confirmed.",
      );
      if (self && selected !== "email") {
        await completeSignOut();
        return;
      }
      try {
        await afterPersonSecurityChange(client, person.id);
      } catch {
        if (current(controller, generation)) {
          setReadAccepted(false);
          setError(
            "The action was accepted, but sessions could not be reloaded. Reload before another action.",
          );
        }
        return;
      }
      if (current(controller, generation)) await refresh();
    } catch (caught) {
      if (!current(controller, generation)) return;
      const partial = personSecurityPartial(caught);
      setReadAccepted(false);
      if (partial) {
        if (selected === "reset") {
          setError(
            partial.local_revocation === "committed"
              ? partial.email_request === "unconfirmed"
                ? "Local sessions were revoked. Email acceptance is unconfirmed. Do not resend automatically."
                : partial.factors_cleared === true
                  ? "Factors were cleared and local sessions revoked, but the action could not be fully recorded."
                  : "Local sessions were revoked. Factor removal could not be fully confirmed."
              : "This action could not be confirmed. Reload security and sessions before trying again.",
          );
        } else {
          const revocationFact =
            partial.local_revocation === "committed"
              ? "Local sessions were revoked."
              : partial.local_revocation === "not_requested"
                ? "No local session revocation was requested."
                : "Local session revocation is unconfirmed.";
          const emailFact =
            partial.email_request === "accepted"
              ? "Recovery email request accepted. Delivery is not confirmed. Do not resend automatically."
              : partial.email_request === "not_attempted"
                ? "Recovery email was not requested. Reload security before another action."
                : "Email acceptance is unconfirmed. Do not resend automatically.";
          setError(`${revocationFact} ${emailFact}`);
        }
        if (self && partial.local_revocation === "committed") {
          await completeSignOut();
          return;
        }
        try {
          await afterPersonSecurityChange(client, person.id);
        } catch {
          if (current(controller, generation))
            setError((message) => `${message} Sessions could not be reloaded.`);
        }
        if (
          self &&
          partial.local_revocation === "unconfirmed" &&
          current(controller, generation)
        )
          requestSessionRecheck();
      } else {
        setError(
          caught instanceof ApiError && caught.status === 401
            ? "Your session must be verified again."
            : apiErrorMessage(
                caught,
                "This action could not be confirmed. Reload security before trying again.",
              ),
        );
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
            Review this person&apos;s current sign-in identity and recovery
            options.
          </p>
        </div>
      </div>
      {query.isError ? (
        <Alert variant="destructive">
          <p>
            Security could not be loaded. No enrollment status is confirmed.
          </p>
          <Button
            className="mt-3 min-h-11"
            variant="outline"
            onClick={() => void refresh()}
          >
            Retry security
          </Button>
        </Alert>
      ) : !data ? (
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
      ) : (
        <>
          <div className="space-y-2">
            <Badge variant="secondary">
              {data.status.verified_factor_count === 0
                ? "No verified factors"
                : `${data.status.verified_factor_count} verified factor${data.status.verified_factor_count === 1 ? "" : "s"}`}
            </Badge>
            <p className="text-muted-foreground text-sm">
              Enrollment does not confirm the assurance of this person&apos;s
              current session.
            </p>
          </div>
          {!data.status.target_eligible ? (
            <Alert variant="warning">
              This person is not eligible for security actions. Pending
              invitations use the invitation actions in Details.
            </Alert>
          ) : null}
          <div className="border-t pt-4">
            <h4 className="font-medium">Recovery email</h4>
            <p className="text-muted-foreground mt-1 text-sm">
              Use the email bound to this person&apos;s sign-in identity.
              Acceptance does not confirm delivery.
            </p>
            {!data.status.smtp_configured ? (
              <p className="mt-3 text-sm">
                Recovery email is not configured. Contact the operator. Session
                actions remain available in Sessions.
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
            <h4 className="font-medium">Multi-factor authentication</h4>
            <p className="text-muted-foreground mt-1 text-sm">
              Reset factors only after confirming the person&apos;s recovery
              need. All local sessions are then revoked.
            </p>
            {data.assurance !== "aal2" ? (
              <p className="mt-3 text-sm">
                Verify your own multi-factor sign-in in{" "}
                <GuardedWorkspaceLink
                  href="/access?view=security"
                  className="text-primary underline underline-offset-4"
                >
                  Sign-in &amp; security
                </GuardedWorkspaceLink>{" "}
                before resetting MFA.
              </p>
            ) : null}
            <Button
              className="mt-3 min-h-11 w-full sm:w-auto"
              variant="outline"
              disabled={!ready || data.assurance !== "aal2"}
              onClick={() => setAction("reset")}
            >
              Reset multi-factor authentication
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
          {error}
          <Button
            variant="outline"
            className="mt-3 min-h-11"
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
        <AlertDialogContent>
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
