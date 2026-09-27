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
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { completeRecovery, requestRecovery } from "@/lib/auth-api";
import {
  consumeRecoveryToken,
  hasValidRecoveryPasswordLength,
  passwordsMatch,
  retainRecoveryToken,
} from "@/lib/recovery-token";

type RequestState = "idle" | "sent" | "error";
type CompletionState = "idle" | "error";

export default function RecoveryPage() {
  const router = useRouter();
  const [recoveryToken, setRecoveryToken] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [passwordLengthInvalid, setPasswordLengthInvalid] = useState(false);
  const [mismatch, setMismatch] = useState(false);
  const [requestState, setRequestState] = useState<RequestState>("idle");
  const [completionState, setCompletionState] =
    useState<CompletionState>("idle");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    function captureInitialLink() {
      const captured = consumeRecoveryToken(window.location, window.history);
      setRecoveryToken((current) => retainRecoveryToken(current, captured));
    }
    function captureNewLink() {
      setRecoveryToken(consumeRecoveryToken(window.location, window.history));
    }
    captureInitialLink();
    setHydrated(true);
    window.addEventListener("hashchange", captureNewLink);
    return () => {
      window.removeEventListener("hashchange", captureNewLink);
    };
  }, []);

  async function submitRequest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setRequestState("idle");
    setPending(true);
    try {
      await requestRecovery(email);
      setRequestState("sent");
    } catch {
      setRequestState("error");
    } finally {
      setPending(false);
    }
  }

  async function submitCompletion(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !recoveryToken) return;
    const validPasswordLength = hasValidRecoveryPasswordLength(password);
    setPasswordLengthInvalid(!validPasswordLength);
    if (!validPasswordLength) {
      document.getElementById("password")?.focus();
      return;
    }
    const matches = passwordsMatch(password, confirmation);
    setMismatch(!matches);
    if (!matches) {
      document.getElementById("confirmation")?.focus();
      return;
    }
    setCompletionState("idle");
    setPending(true);
    try {
      await completeRecovery(recoveryToken, password);
      router.replace("/login");
    } catch {
      setCompletionState("error");
    } finally {
      setPending(false);
    }
  }

  const completingRecovery = recoveryToken !== null;

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
            {completingRecovery ? "Choose a new password" : "Reset password"}
          </h1>
          <p className="text-muted-foreground mt-2 text-sm">
            {completingRecovery
              ? "Choose a strong password for your OpenSlate account."
              : "Enter your email to get reset instructions."}
          </p>
        </div>
        {!hydrated ? (
          <p className="text-muted-foreground text-sm" role="status">
            Preparing password recovery…
          </p>
        ) : completingRecovery ? (
          <>
            {completionState === "error" ? (
              <Alert role="alert" variant="destructive" className="mb-5">
                We could not reset your password. Check the requirements and try
                again.
              </Alert>
            ) : null}
            <form className="space-y-5" onSubmit={submitCompletion}>
              <Field className="space-y-2" invalid={passwordLengthInvalid}>
                <FieldLabel htmlFor="password">New password</FieldLabel>
                <FieldControl
                  render={
                    <Input
                      id="password"
                      autoFocus
                      aria-invalid={passwordLengthInvalid}
                      aria-describedby={
                        passwordLengthInvalid
                          ? "password-requirements password-error"
                          : "password-requirements"
                      }
                      autoComplete="new-password"
                      type="password"
                      minLength={12}
                      maxLength={128}
                      required
                      disabled={pending}
                      value={password}
                      onChange={(event) => {
                        setPassword(event.target.value);
                        setPasswordLengthInvalid(false);
                      }}
                    />
                  }
                />
                <FieldDescription id="password-requirements">
                  Use 12 to 128 characters and avoid a common password.
                </FieldDescription>
                {passwordLengthInvalid ? (
                  <FieldError match id="password-error">
                    Use a password between 12 and 128 characters.
                  </FieldError>
                ) : null}
              </Field>
              <Field className="space-y-2" invalid={mismatch}>
                <FieldLabel htmlFor="confirmation">
                  Confirm new password
                </FieldLabel>
                <FieldControl
                  render={
                    <Input
                      id="confirmation"
                      aria-invalid={mismatch}
                      aria-describedby={
                        mismatch ? "confirmation-error" : undefined
                      }
                      autoComplete="new-password"
                      type="password"
                      minLength={12}
                      required
                      disabled={pending}
                      value={confirmation}
                      onChange={(event) => setConfirmation(event.target.value)}
                    />
                  }
                />
                {mismatch ? (
                  <FieldError match id="confirmation-error">
                    Passwords must match.
                  </FieldError>
                ) : null}
              </Field>
              <Button className="w-full" size="lg" disabled={pending}>
                {pending ? (
                  "Saving…"
                ) : (
                  <>
                    Reset password <ArrowRight aria-hidden="true" />
                  </>
                )}
              </Button>
            </form>
          </>
        ) : (
          <>
            {requestState === "sent" ? (
              <Alert role="status" variant="success" className="mb-5">
                If an account matches that email, we will send reset
                instructions.
              </Alert>
            ) : null}
            {requestState === "error" ? (
              <Alert role="alert" variant="destructive" className="mb-5">
                We could not process that request. Try again shortly.
              </Alert>
            ) : null}
            <form className="space-y-5" onSubmit={submitRequest}>
              <Field className="space-y-2">
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <FieldControl
                  render={
                    <Input
                      id="email"
                      type="email"
                      autoFocus
                      autoComplete="email"
                      required
                      disabled={pending}
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                    />
                  }
                />
              </Field>
              <Button className="w-full" size="lg" disabled={pending}>
                {pending ? (
                  "Requesting…"
                ) : (
                  <>
                    Request recovery <ArrowRight aria-hidden="true" />
                  </>
                )}
              </Button>
            </form>
          </>
        )}
        <p className="text-muted-foreground mt-8 text-center text-sm">
          Remembered your password?{" "}
          <a className="text-primary font-medium hover:underline" href="/login">
            Return to sign in
          </a>
        </p>
      </section>
    </main>
  );
}
