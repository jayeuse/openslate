"use client";

import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Mail } from "lucide-react";
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
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DialogFrameFooter,
  DialogFrameHeader,
  dialogFrameContentClass,
} from "@/components/ui/dialog-frame";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { requestEmailChange } from "@/lib/auth-api";
import { profileSelfOptions } from "@/components/profile/adapters/profile-queries";
import { DialogRows } from "./dialog-rows";
import { FactValue, focusReturn } from "./rows";

/**
 * The Email row (PD12): the saved address as plain text and a quiet Change…
 * that opens the framed email dialog. Acceptance only requests confirmation;
 * the saved address changes after both links are confirmed.
 */
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
  const opener = useRef<HTMLButtonElement | null>(null);
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
        "The request could not be confirmed after you signed in again. Check both inboxes before you ask again; nothing is sent again by itself.",
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
          ? "Your current password was not accepted, or you were signed out. Check your password and try again."
          : failure instanceof ApiError && failure.status === 409
            ? "This email address cannot be used, or the request did not finish. Your saved email has not changed."
            : failure instanceof ApiError && failure.status === 403
              ? "Your email cannot be changed right now. Finish any sign-in check you are asked for, such as two-step verification, then try again."
              : failure instanceof ApiError && failure.status === 422
                ? "Check the new email address and current password. The request was not accepted."
                : "The request could not be confirmed. Confirmation emails may have been sent. Check both inboxes before you ask again; nothing is sent again by itself.",
      );
    } finally {
      if (current === version.current && !controller.signal.aborted) {
        operation.current = null;
        setPending(false);
      }
    }
  }
  function close() {
    setOpen(false);
    setPassword("");
    setEmail("");
  }
  return (
    <FactValue
      action={
        <Button
          ref={opener}
          variant="outline"
          aria-label="Change email"
          className="min-h-11 xl:min-h-8"
          disabled={blocked}
          onClick={() => {
            setOpen(true);
            setEmail("");
            setPassword("");
            setAccepted(false);
            setError("");
          }}
        >
          Change…
        </Button>
      }
    >
      <span className="break-all">{self.data?.email ?? "Unavailable"}</span>
      <Dialog
        open={open && !suspended}
        dismissible={!pending}
        onOpenChange={(next) => {
          if (next) setOpen(true);
          else close();
        }}
      >
        <DialogContent
          className={`${dialogFrameContentClass} max-w-lg`}
          // The dialog opens on its first field (PD61).
          initialFocus={() => document.getElementById("email-change-new")}
          finalFocus={() => focusReturn(opener.current, "identity")()}
        >
          <DialogFrameHeader
            title={<DialogTitle>Change email</DialogTitle>}
            description={
              <DialogDescription>
                You may need to sign in again after you confirm.
              </DialogDescription>
            }
            closeLabel="Close email"
            closeDisabled={pending}
            onClose={close}
          />
          <form
            id="email-change-form"
            className="flex min-w-0 flex-col gap-4"
            onSubmit={(event) => {
              void submit(event);
            }}
          >
            <DialogRows
              rows={[
                {
                  label: "Current email",
                  value: (
                    <span className="break-all">{self.data?.email ?? ""}</span>
                  ),
                },
                {
                  label: "New email",
                  htmlFor: "email-change-new",
                  value: (
                    <Input
                      id="email-change-new"
                      type="email"
                      autoComplete="email"
                      maxLength={255}
                      required
                      className="min-h-11"
                      placeholder="name@example.com"
                      value={email}
                      disabled={blocked || accepted}
                      onChange={(event) => setEmail(event.target.value)}
                    />
                  ),
                },
                {
                  label: "Current password",
                  htmlFor: "email-change-password",
                  value: (
                    <Input
                      id="email-change-password"
                      type="password"
                      autoComplete="current-password"
                      required
                      className="min-h-11"
                      value={password}
                      disabled={blocked || accepted}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  ),
                },
              ]}
            />
            <p className="bg-muted flex items-center gap-2 rounded-[var(--radius)] px-3 py-2 text-sm">
              <Mail
                aria-hidden="true"
                className="text-muted-foreground size-4 shrink-0"
              />
              The change finishes when you confirm both emails.
            </p>
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
          </form>
          <DialogFrameFooter>
            <DialogFooter className="mt-0">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={pending}
                onClick={close}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                form="email-change-form"
                className="min-h-11"
                disabled={blocked || accepted || !email.trim() || !password}
              >
                {pending ? "Sending…" : "Send confirmation emails"}
              </Button>
            </DialogFooter>
          </DialogFrameFooter>
        </DialogContent>
      </Dialog>
    </FactValue>
  );
}
