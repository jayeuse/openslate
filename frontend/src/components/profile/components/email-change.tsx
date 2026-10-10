"use client";

import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  useVerifiedWorkspaceUserId,
  useWorkspaceInteractionSuspended,
} from "@/components/systems/shared/runtime/workspace-identity";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { requestEmailChange } from "@/lib/auth-api";
import { profileSelfOptions } from "../adapters/profile-queries";

export default function EmailChange() {
  const userId = useVerifiedWorkspaceUserId();
  const suspended = useWorkspaceInteractionSuspended();
  const self = useQuery({ ...profileSelfOptions(userId), enabled: !suspended });
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [accepted, setAccepted] = useState(false);
  const version = useRef(0);
  const operation = useRef<AbortController | null>(null);
  const blocked = suspended || pending || !self.data || Boolean(self.error);
  useLayoutEffect(() => {
    version.current += 1;
    if (operation.current) {
      operation.current.abort();
      operation.current = null;
      setPending(false);
      setPassword("");
      setAccepted(false);
      setError(
        "The request outcome could not be confirmed after sign-in reverification. Check both inboxes before making another request; nothing will be resent automatically.",
      );
    }
    return () => {
      version.current += 1;
      operation.current?.abort();
    };
  }, [userId, suspended]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked || !email.trim() || !password || accepted) return;
    const current = version.current;
    const controller = new AbortController();
    operation.current = controller;
    setPending(true);
    setError("");
    try {
      await requestEmailChange(email.trim(), password, controller.signal);
      if (current !== version.current || controller.signal.aborted) return;
      setAccepted(true);
      setPassword("");
      // Acceptance requests confirmation; it is not authoritative saved-email state.
    } catch (failure: unknown) {
      if (current !== version.current || controller.signal.aborted) return;
      setError(
        failure instanceof ApiError && failure.status === 401
          ? "Your current password or sign-in session was not accepted. Check your password before trying again."
          : failure instanceof ApiError && failure.status === 409
            ? "The email address is unavailable, or the request may be incomplete. Your saved email has not been changed by this request."
            : failure instanceof ApiError && failure.status === 403
              ? "This request is not permitted in the current sign-in context. Complete any required verification before trying again."
              : failure instanceof ApiError && failure.status === 422
                ? "Check the new email address and current password. The request was not accepted."
                : "The request outcome could not be confirmed. Confirmation emails may have been sent. Check both inboxes before making another request; nothing will be resent automatically.",
      );
    } finally {
      if (current === version.current && !controller.signal.aborted) {
        operation.current = null;
        setPending(false);
      }
    }
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-4">
      <p className="text-muted-foreground max-w-prose text-sm">
        Changing your sign-in email requires your current password and
        confirmation at both addresses. Your saved email stays unchanged until
        confirmation is complete.
      </p>
      <Button
        variant="outline"
        className="min-h-11"
        disabled={blocked}
        onClick={() => {
          setOpen(true);
          setEmail("");
          setPassword("");
          setAccepted(false);
          setError("");
        }}
      >
        Change email
      </Button>
      <Dialog
        open={open && !suspended}
        dismissible={!pending}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setPassword("");
            setEmail("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change email</DialogTitle>
            <DialogDescription>
              Enter your new email and current password. Confirm both email
              links in a signed-out browser context.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              void submit(event);
            }}
          >
            <Field>
              <FieldLabel htmlFor="email-change-new">New email</FieldLabel>
              <Input
                id="email-change-new"
                type="email"
                autoComplete="email"
                maxLength={255}
                required
                value={email}
                disabled={blocked || accepted}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="email-change-password">
                Current password
              </FieldLabel>
              <Input
                id="email-change-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                disabled={blocked || accepted}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
            {error && (
              <Alert role="alert" variant="destructive">
                {error}
              </Alert>
            )}
            {accepted && (
              <p role="status" className="text-sm">
                Confirmation requested. Check both email addresses and confirm
                each link. This request has not changed your saved email.
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={pending}
                onClick={() => {
                  setOpen(false);
                  setPassword("");
                  setEmail("");
                }}
              >
                Close
              </Button>
              <Button
                type="submit"
                aria-label="Send confirmation emails"
                className="min-h-11"
                disabled={blocked || accepted || !email.trim() || !password}
              >
                {pending ? "Requesting…" : "Send confirmation emails"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
