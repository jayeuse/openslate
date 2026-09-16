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

export default function AuthSetupPage() {
  const router = useRouter();
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setMismatch(password !== confirmation);
    if (password !== confirmation) {
      document.getElementById("confirmation")?.focus();
      return;
    }
    setError("");
    setPending(true);
    try {
      const response = await fetch("/session/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ password, confirmation }),
      });
      if (!response.ok) throw new Error("Password setup failed");
      router.replace("/openview");
    } catch {
      setError(
        "We could not set up your password. Return to sign in and try again.",
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
            <Button asChild variant="outline" className="w-full">
              <a href="/login">Return to sign in</a>
            </Button>
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
                  disabled={!hydrated}
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
                  disabled={!hydrated}
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
          <Button className="w-full" size="lg" disabled={!hydrated || pending}>
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
