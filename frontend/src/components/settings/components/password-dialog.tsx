"use client";

import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DialogFrameFooter,
  DialogFrameHeader,
  dialogFrameContentClass,
} from "@/components/ui/dialog-frame";
import { Input } from "@/components/ui/input";
import {
  PASSWORD_LENGTH_MESSAGE,
  type AccountSecurity,
} from "../hooks/use-account-security";
import { DialogRows } from "./dialog-rows";

/**
 * Change password (PD12): the framed dialog with a named close, the 12 to 128
 * characters rule under the new password, and the sign-out consequence
 * before the action.
 */
export function PasswordDialog({
  security,
  finalFocus,
}: {
  security: AccountSecurity;
  /** Where focus returns when the dialog closes. */
  finalFocus: () => HTMLElement | false;
}) {
  const password = security.password;
  const busy = security.busy;
  return (
    <Dialog
      open={password.open}
      dismissible={!password.pending}
      onOpenChange={password.setOpen}
    >
      <DialogContent
        className={`${dialogFrameContentClass} max-w-lg`}
        // The dialog opens on its first field (PD61).
        initialFocus={() => document.getElementById("current-password")}
        finalFocus={finalFocus}
      >
        <DialogFrameHeader
          title={<DialogTitle>Change password</DialogTitle>}
          closeLabel="Close password"
          closeDisabled={password.pending}
          onClose={() => password.setOpen(false)}
        />
        <form
          id="password-change-form"
          className="flex min-w-0 flex-col gap-4"
          noValidate
          onSubmit={password.submit}
        >
          <DialogRows
            rows={[
              {
                label: "Current password",
                htmlFor: "current-password",
                value: (
                  <>
                    <Input
                      aria-invalid={Boolean(password.currentPasswordError)}
                      aria-describedby={
                        password.currentPasswordError
                          ? "current-password-error"
                          : undefined
                      }
                      autoComplete="current-password"
                      className="min-h-11"
                      id="current-password"
                      maxLength={128}
                      onChange={(event) =>
                        password.setCurrentPassword(event.target.value)
                      }
                      required
                      type="password"
                      value={password.currentPassword}
                    />
                    {password.currentPasswordError && (
                      <p
                        id="current-password-error"
                        role="alert"
                        className="text-destructive text-sm"
                      >
                        {password.currentPasswordError}
                      </p>
                    )}
                  </>
                ),
              },
              {
                label: "New password",
                htmlFor: "new-password",
                value: (
                  <>
                    <Input
                      aria-invalid={Boolean(password.newPasswordError)}
                      aria-describedby={
                        password.newPasswordError === PASSWORD_LENGTH_MESSAGE
                          ? "new-password-error"
                          : password.newPasswordError
                            ? "new-password-guidance new-password-error"
                            : "new-password-guidance"
                      }
                      autoComplete="new-password"
                      className="min-h-11"
                      id="new-password"
                      maxLength={128}
                      minLength={12}
                      onChange={(event) =>
                        password.setNewPassword(event.target.value)
                      }
                      required
                      type="password"
                      value={password.newPassword}
                    />
                    {password.newPasswordError !== PASSWORD_LENGTH_MESSAGE && (
                      <p
                        className="text-muted-foreground text-xs"
                        id="new-password-guidance"
                      >
                        Use 12 to 128 characters.
                      </p>
                    )}
                    {password.newPasswordError && (
                      <p
                        id="new-password-error"
                        role="alert"
                        className="text-destructive text-sm"
                      >
                        {password.newPasswordError}
                      </p>
                    )}
                  </>
                ),
              },
            ]}
          />
          {password.formError && (
            <p role="alert" className="text-destructive text-sm">
              {password.formError}
            </p>
          )}
          {password.feedback && (
            <p role="status" className="bg-muted rounded-lg p-3 text-sm">
              {password.feedback}
            </p>
          )}
          {password.sessionNote && (
            <p role="status" className="text-muted-foreground text-sm">
              {password.sessionNote}
            </p>
          )}
          <p className="bg-muted flex items-center gap-2 rounded-[var(--radius)] px-3 py-2 text-sm">
            <LogOut
              aria-hidden="true"
              className="text-muted-foreground size-4 shrink-0"
            />
            Other devices sign out after the change.
          </p>
        </form>
        <DialogFrameFooter>
          <DialogFooter className="mt-0">
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={password.pending}
              onClick={() => password.setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="password-change-form"
              className="min-h-11"
              disabled={busy || !security.accountId}
            >
              {password.pending ? "Changing password…" : "Change password"}
            </Button>
          </DialogFooter>
        </DialogFrameFooter>
      </DialogContent>
    </Dialog>
  );
}
