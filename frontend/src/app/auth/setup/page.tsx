"use client";

import { useEffect, useState } from "react";
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
import { changePassword, completeInvitation } from "@/lib/auth-api";
import {
  consumeInvitationToken,
  retainInvitationToken,
} from "@/lib/invitation-token";

type SetupFailure = "retryable" | "session" | "unavailable" | "uncertain";

function classifySetupFailure(error: unknown): SetupFailure {
  if (!(error instanceof ApiError)) return "uncertain";
  if (error.status === 401) return "session";
  if (error.status >= 500) return "unavailable";
  return "retryable";
}

export default function AuthSetupPage() {
  const router = useRouter();
  const [invitationToken, setInvitationToken] = useState<string | null>(null);
  const [temporaryPasswordSetup, setTemporaryPasswordSetup] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    const captured = consumeInvitationToken(window.location, window.history);
    setInvitationToken((current) => retainInvitationToken(current, captured));
    setTemporaryPasswordSetup(
      new URLSearchParams(window.location.search).get("temporary") === "1",
    );
    setHydrated(true);
  }, []);
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const [error, setError] = useState("");
  const [failure, setFailure] = useState<SetupFailure | null>(null);
  const [pending, setPending] = useState(false);
  const missingInvitationLink =
    hydrated && !temporaryPasswordSetup && !invitationToken;
  const setupFailure = missingInvitationLink ? "session" : failure;
  const setupError = missingInvitationLink
    ? "This invitation link is invalid or incomplete. Request a new invitation."
    : error;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || setupFailure === "session" || setupFailure === "uncertain")
      return;
    if (!invitationToken && !temporaryPasswordSetup) {
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
    try {
      if (temporaryPasswordSetup) {
        await changePassword(currentPassword, password);
        router.replace("/openview");
      } else {
        await completeInvitation(invitationToken as string, password);
        router.replace("/login");
      }
    } catch (error) {
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
      setPending(false);
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
            {temporaryPasswordSetup
              ? "Change your password"
              : "Set your password"}
          </h1>
          <p className="text-muted-foreground mt-2 text-sm">
            {temporaryPasswordSetup
              ? "Choose a password to finish setting up your account."
              : "Finish setting up your invited OpenSlate account."}
          </p>
        </div>
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
          {temporaryPasswordSetup ? (
            <Field className="space-y-2">
              <FieldLabel htmlFor="current-password">
                Temporary password
              </FieldLabel>
              <FieldControl
                render={
                  <Input
                    id="current-password"
                    type="password"
                    disabled={
                      !hydrated ||
                      pending ||
                      setupFailure === "session" ||
                      setupFailure === "uncertain"
                    }
                    autoComplete="current-password"
                    required
                    value={currentPassword}
                    onChange={(event) => setCurrentPassword(event.target.value)}
                  />
                }
              />
            </Field>
          ) : null}
          <Field className="space-y-2">
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <FieldControl
              render={
                <Input
                  id="password"
                  type="password"
                  disabled={
                    !hydrated ||
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
                  aria-describedby={mismatch ? "confirmation-error" : undefined}
                  type="password"
                  disabled={
                    !hydrated ||
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
              !hydrated ||
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
      </section>
    </main>
  );
}
