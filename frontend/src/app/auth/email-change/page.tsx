"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MailCheck } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { consumeActionToken } from "@/lib/action-token";
import {
  completeEmailChange,
  probeEmailConfirmationSession,
  signOut,
} from "@/lib/auth-api";
import { emailChangeFailure } from "@/lib/email-change-failure";

type Context = "checking" | "signed-out" | "occupied" | "unavailable";
const invalidLink =
  "This email confirmation link is missing or invalid. Open the link from your email again.";

export default function EmailChangePage() {
  const router = useRouter();
  const proof = useRef<string | null>(null);
  const captured = useRef(false);
  const version = useRef(0);
  const operation = useRef<AbortController | null>(null);
  const [context, setContext] = useState<Context>("checking");
  const [valid, setValid] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    async function capture(replaced: boolean) {
      const current = ++version.current;
      operation.current?.abort();
      // Scrub even invalid input before any API request. Strict Mode's second
      // setup retains the already-captured in-memory proof, never URL/storage.
      if (
        !captured.current ||
        replaced ||
        window.location.hash ||
        window.location.search
      ) {
        proof.current = consumeActionToken(
          window.location,
          window.history,
          "email_change",
        );
        captured.current = true;
      }
      setValid(proof.current !== null);
      setError(proof.current ? "" : invalidLink);
      setAcknowledged(false);
      setPending(false);
      setContext("checking");
      const controller = new AbortController();
      operation.current = controller;
      try {
        const session = await probeEmailConfirmationSession(controller.signal);
        if (current === version.current && !controller.signal.aborted)
          setContext(session.authenticated ? "occupied" : "signed-out");
      } catch {
        if (current === version.current && !controller.signal.aborted) {
          setContext("unavailable");
          setError(
            "The browser sign-in context could not be checked. Reopen the email link when the service is available.",
          );
        }
      }
    }
    void capture(false);
    const replace = () => {
      void capture(true);
    };
    window.addEventListener("hashchange", replace);
    return () => {
      version.current += 1;
      operation.current?.abort();
      window.removeEventListener("hashchange", replace);
    };
  }, []);

  async function confirm() {
    if (pending || context !== "signed-out" || !proof.current) return;
    const current = version.current;
    const token = proof.current;
    const controller = new AbortController();
    operation.current = controller;
    setPending(true);
    setError("");
    setAcknowledged(false);
    try {
      const result = await completeEmailChange(token, controller.signal);
      if (current !== version.current || controller.signal.aborted) return;
      proof.current = null;
      setValid(false);
      if (!result.authenticated) setAcknowledged(true);
      else router.replace("/settings#security");
    } catch (failure: unknown) {
      if (current !== version.current || controller.signal.aborted) return;
      const outcome = emailChangeFailure(failure);
      if (outcome.signOutRequired) {
        setContext("occupied");
        setError(outcome.message);
      } else {
        // A failed/unknown one-time command is never replayed, including after 401.
        proof.current = null;
        setValid(false);
        setError(outcome.message);
      }
    } finally {
      if (current === version.current && !controller.signal.aborted)
        setPending(false);
    }
  }

  async function logout() {
    if (pending || context !== "occupied") return;
    const current = version.current;
    setPending(true);
    setError("");
    try {
      await signOut();
      if (current !== version.current) return;
      const session = await probeEmailConfirmationSession();
      if (current !== version.current) return;
      setContext(session.authenticated ? "occupied" : "signed-out");
      if (session.authenticated)
        setError(
          "Sign-out could not be confirmed. The email link has not been used.",
        );
    } catch {
      if (current === version.current)
        setError(
          "Sign-out could not be confirmed. Try signing out again; the email link has not been used.",
        );
    } finally {
      if (current === version.current) setPending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <section
        aria-labelledby="email-change-heading"
        className="border-border bg-card w-full max-w-md rounded-xl border p-6 shadow-sm sm:p-8"
      >
        <div className="bg-secondary text-secondary-foreground mb-6 inline-flex size-12 items-center justify-center rounded-xl">
          <MailCheck className="size-6" aria-hidden="true" />
        </div>
        <h1
          id="email-change-heading"
          className="text-2xl font-semibold tracking-tight"
        >
          Confirm email change
        </h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Confirm the links sent to both your current and new email addresses.
          Opening this page alone does not confirm a change.
        </p>
        <div className="mt-6 space-y-4">
          {context === "checking" && (
            <p role="status" className="text-muted-foreground text-sm">
              Checking browser sign-in context…
            </p>
          )}
          {context === "occupied" && (
            <p className="text-sm">
              This browser has a signed-in context. Sign out explicitly to
              continue; no account will be replaced automatically.
            </p>
          )}
          {error && (
            <Alert variant="destructive" role="alert">
              {error}
            </Alert>
          )}
          {acknowledged && (
            <p role="status" className="text-sm">
              This link was accepted. Confirm the link sent to the other email
              address to finish. You are not signed in by this acknowledgment.
            </p>
          )}
          {context === "occupied" ? (
            <Button
              className="min-h-11 w-full"
              disabled={pending}
              onClick={() => {
                void logout();
              }}
            >
              {pending ? "Signing out…" : "Sign out to continue"}
            </Button>
          ) : (
            <Button
              className="min-h-11 w-full"
              aria-label="Confirm email change"
              disabled={!valid || pending || context !== "signed-out"}
              onClick={() => {
                void confirm();
              }}
            >
              {pending ? "Confirming…" : "Confirm email change"}
            </Button>
          )}
          <a
            href="/login"
            className="text-muted-foreground hover:text-foreground focus-visible:outline-ring flex min-h-11 items-center justify-center rounded-md text-sm underline focus-visible:outline-2"
          >
            Back to sign in
          </a>
        </div>
      </section>
    </main>
  );
}
