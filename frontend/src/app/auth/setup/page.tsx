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

type SetupFailure = "retryable" | "session" | "unavailable" | "uncertain";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function classifySetupFailure(response: Response, body: unknown): SetupFailure {
  // Success was already checked by the caller. An incomplete success response
  // cannot prove that a password mutation did not happen.
  if (response.ok) return "uncertain";
  if (response.status === 401) return "session";
  if (response.status >= 500) {
    const detail = isRecord(body) ? body.detail : undefined;
    return detail === "Authentication service unavailable" ||
      detail === "Authentication service timed out"
      ? "unavailable"
      : "uncertain";
  }
  if (
    isRecord(body) &&
    body.detail === "Password set, but account setup could not be completed"
  )
    return "uncertain";
  return "retryable";
}

export default function AuthSetupPage() {
  const router = useRouter();
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const [error, setError] = useState("");
  const [failure, setFailure] = useState<SetupFailure | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || failure === "session" || failure === "uncertain") return;
    setMismatch(password !== confirmation);
    if (password !== confirmation) {
      document.getElementById("confirmation")?.focus();
      return;
    }
    setError("");
    setFailure(null);
    setPending(true);
    try {
      let response: Response;
      try {
        response = await fetch("/session/password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ password, confirmation }),
        });
      } catch {
        setFailure("uncertain");
        setError(
          "Password setup may have completed. Return to sign in to confirm before trying again.",
        );
        return;
      }
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && isRecord(body) && body.authenticated === true) {
        router.replace("/openview");
        return;
      }
      const kind = classifySetupFailure(response, body);
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
          <h1 className="text-2xl font-semibold">Set your password</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            Finish setting up your invited OpenSlate account.
          </p>
        </div>
        {error && (
          <div className="mb-5 space-y-3">
            <Alert role="alert" variant="destructive">
              {error}
            </Alert>
            {failure === "session" || failure === "uncertain" ? (
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
                    !hydrated ||
                    pending ||
                    failure === "session" ||
                    failure === "uncertain"
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
                    failure === "session" ||
                    failure === "uncertain"
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
              failure === "session" ||
              failure === "uncertain"
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
