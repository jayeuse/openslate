"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, KeyRound } from "lucide-react";
import { useRouter } from "next/navigation";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldControl,
  FieldLabel,
  FieldError,
} from "@/components/ui/field";
import { ApiError } from "@/lib/api";
import {
  acceptOrganizationInvitation,
  completeInvitation,
  getAuthMe,
  probeEmailConfirmationSession,
  selectOrganization,
  type PendingInvitation,
} from "@/lib/auth-api";
import { setCurrentOrganizationId } from "@/lib/organization-context";
import { PendingInvitationList } from "@/components/organization-gate";
import { workspaceStartRoute } from "@/components/workspace-start";
import {
  consumeInvitationToken,
  retainInvitationToken,
} from "@/lib/invitation-token";

type SetupFailure = "retryable" | "session" | "unavailable" | "uncertain";
/** Without a link, a signed-in account joins from its pending invitations. */
type SignedInAccount =
  | { status: "unknown" }
  | { status: "signed-out" }
  | { status: "signed-in"; invitations: PendingInvitation[] };

function classifySetupFailure(error: unknown): SetupFailure {
  if (!(error instanceof ApiError)) return "uncertain";
  if (error.status === 401) return "session";
  if (error.status >= 500) return "unavailable";
  return "retryable";
}

export default function AuthSetupPage() {
  const router = useRouter();
  const invitationVersion = useRef(0);
  const [invitationToken, setInvitationToken] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const [error, setError] = useState("");
  const [failure, setFailure] = useState<SetupFailure | null>(null);
  const [pending, setPending] = useState(false);
  const [account, setAccount] = useState<SignedInAccount>({
    status: "unknown",
  });
  useEffect(() => {
    function captureInitialLink() {
      const captured = consumeInvitationToken(window.location, window.history);
      setInvitationToken((current) => retainInvitationToken(current, captured));
    }
    function captureNewLink() {
      invitationVersion.current += 1;
      setInvitationToken(
        consumeInvitationToken(window.location, window.history),
      );
      setPassword("");
      setConfirmation("");
      setMismatch(false);
      setError("");
      setFailure(null);
      setPending(false);
    }
    captureInitialLink();
    setHydrated(true);
    window.addEventListener("hashchange", captureNewLink);
    return () => {
      window.removeEventListener("hashchange", captureNewLink);
    };
  }, []);
  useEffect(() => {
    if (!ready || invitationToken) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const session = await probeEmailConfirmationSession(controller.signal);
        if (!session.authenticated || session.setup_required) {
          setAccount({ status: "signed-out" });
          return;
        }
        const me = await getAuthMe(controller.signal);
        if (!controller.signal.aborted)
          setAccount({
            status: "signed-in",
            invitations: me.pendingInvitations,
          });
      } catch {
        if (!controller.signal.aborted) setAccount({ status: "signed-out" });
      }
    })();
    return () => controller.abort();
  }, [hydrated, invitationToken]);

  async function join(invitation: PendingInvitation) {
    await acceptOrganizationInvitation(invitation.id);
    try {
      await selectOrganization(invitation.orgId);
    } catch {
      // A gated organization opens its gate in the workspace.
    }
    setCurrentOrganizationId(invitation.orgId);
    router.replace(await workspaceStartRoute());
  }

  // Without a link, wait for the signed-in check before offering the form.
  const ready =
    hydrated && (invitationToken !== null || account.status !== "unknown");
  const missingInvitationLink =
    hydrated && !invitationToken && account.status === "signed-out";
  const setupFailure = missingInvitationLink ? "session" : failure;
  const setupError = missingInvitationLink
    ? "This invitation link is invalid or incomplete. Request a new invitation."
    : error;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || setupFailure === "session" || setupFailure === "uncertain")
      return;
    if (!invitationToken) {
      setFailure("session");
      setError(
        "This invitation link is invalid or incomplete. Request a new invitation.",
      );
      return;
    }
    setMismatch(password !== confirmation);
    if (password !== confirmation) {
      document.getElementById("confirmation")?.focus();
      return;
    }
    setError("");
    setFailure(null);
    setPending(true);
    const submittedVersion = invitationVersion.current;
    try {
      await completeInvitation(invitationToken, password);
      if (submittedVersion !== invitationVersion.current) return;
      router.replace("/login?completed=password");
    } catch (error) {
      if (submittedVersion !== invitationVersion.current) return;
      const kind = classifySetupFailure(error);
      setFailure(kind);
      if (kind === "session")
        setError(
          "Your invitation session has expired. Return to sign in and start again.",
        );
      else if (kind === "uncertain")
        setError(
          "Password setup may have completed. Return to sign in to confirm before trying again.",
        );
      else if (kind === "unavailable")
        setError(
          "Authentication is temporarily unavailable. Your entries are still here. Try again shortly.",
        );
      else
        setError(
          "We could not set that password. Check the requirements and try again.",
        );
    } finally {
      if (submittedVersion === invitationVersion.current) setPending(false);
    }
  }

  return (
    <main className="bg-background text-foreground flex min-h-screen items-center justify-center px-6 py-12">
      <section className="w-full max-w-sm">
        <a
          href="/"
          className="mb-12 inline-flex items-center gap-2 text-sm font-semibold"
        >
          <span className="bg-primary text-primary-foreground grid size-8 place-items-center rounded-md text-xs">
            OS
          </span>
          OpenSlate
        </a>
        <div className="mb-8">
          <div className="bg-accent text-accent-foreground mb-5 grid size-11 place-items-center rounded-full">
            <KeyRound size={20} aria-hidden="true" />
          </div>
          <h1 className="text-2xl font-semibold">
            {account.status === "signed-in"
              ? "Join an organization"
              : "Set your password"}
          </h1>
          <p className="text-muted-foreground mt-2 text-sm">
            {account.status === "signed-in"
              ? "You are signed in. Join an organization that invited this account."
              : "Finish setting up your invited OpenSlate account."}
          </p>
        </div>
        {account.status === "signed-in" ? (
          <div className="space-y-5">
            {account.invitations.length > 0 ? (
              <PendingInvitationList
                invitations={account.invitations}
                onJoin={join}
              />
            ) : (
              <Alert>No pending invitations for this account.</Alert>
            )}
            <Button asChild variant="outline" className="w-full">
              <a href="/openview">Go to your workspace</a>
            </Button>
          </div>
        ) : (
          <>
            {setupError && (
              <div className="mb-5 space-y-3">
                <Alert role="alert" variant="destructive">
                  {setupError}
                </Alert>
                {setupFailure === "session" || setupFailure === "uncertain" ? (
                  <Button asChild variant="outline" className="w-full">
                    <a href="/login">Return to sign in</a>
                  </Button>
                ) : null}
              </div>
            )}
            <form className="space-y-5" onSubmit={submit}>
              <Field className="space-y-2">
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <FieldControl
                  render={
                    <Input
                      id="password"
                      type="password"
                      disabled={
                        !ready ||
                        pending ||
                        missingInvitationLink ||
                        setupFailure === "session" ||
                        setupFailure === "uncertain"
                      }
                      autoComplete="new-password"
                      minLength={12}
                      required
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  }
                />
              </Field>
              <Field className="space-y-2" invalid={mismatch}>
                <FieldLabel htmlFor="confirmation">Confirm password</FieldLabel>
                <FieldControl
                  render={
                    <Input
                      id="confirmation"
                      aria-invalid={mismatch}
                      aria-describedby={
                        mismatch ? "confirmation-error" : undefined
                      }
                      type="password"
                      disabled={
                        !ready ||
                        pending ||
                        missingInvitationLink ||
                        setupFailure === "session" ||
                        setupFailure === "uncertain"
                      }
                      autoComplete="new-password"
                      minLength={12}
                      required
                      value={confirmation}
                      onChange={(event) => setConfirmation(event.target.value)}
                    />
                  }
                />
                {mismatch && (
                  <FieldError match id="confirmation-error">
                    Passwords must match.
                  </FieldError>
                )}
              </Field>
              <Button
                className="w-full"
                size="lg"
                disabled={
                  !ready ||
                  pending ||
                  missingInvitationLink ||
                  setupFailure === "session" ||
                  setupFailure === "uncertain"
                }
              >
                {pending ? (
                  "Saving…"
                ) : (
                  <>
                    Continue <ArrowRight aria-hidden="true" />
                  </>
                )}
              </Button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
