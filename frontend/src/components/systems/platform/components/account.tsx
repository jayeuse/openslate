"use client";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FormEvent } from "react";
import { useWorkspaceSignOut } from "../../shared/runtime/workspace-identity";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "@/components/ui/alert-dialog";
import { authMeOptions } from "@/components/systems/openview/adapters/openview-queries";
import { manageWorkspaceOptions } from "@/components/systems/manage/adapters/manage-queries";
import { accessKeys } from "../../access/adapters/access-queries";
import { LoadingRegion } from "@/components/ui/loading-region";
import { ApiError } from "@/lib/api";
import { Action, Panel } from "../../shared/components/ui";
import {
  changeAccountPassword,
  endAccountSession,
  endOtherAccountSessions,
  type AccountSession,
} from "../adapters/account-api";
import {
  accountSessionsOptions,
  platformKeys,
} from "../adapters/platform-queries";
import { useDisplayRegion } from "@/components/use-display-region";
import { formatWorkspaceDateTime, type WorkspaceRegion } from "@/lib/date-time";

type AccountConfirmation =
  | { type: "session"; session: AccountSession }
  | { type: "other-sessions" }
  | null;

const PASSWORD_LENGTH_MESSAGE = "Use 12 to 128 characters.";

function passwordErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "The current password was not accepted.";
    if (error.status === 429)
      return "Too many password attempts. Wait before trying again.";
    if (error.status === 503)
      return "Password changes are temporarily unavailable. Try again later.";
    if (error.status === 422)
      return "The new password was not accepted. Check the password requirements and try again.";
  }
  return "The password could not be changed. Try again.";
}

function passwordErrorField(error: unknown): "current" | "new" | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 403) return "current";
  if (error.status === 422) return "new";
  return null;
}

function sessionLoadErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 403)
    return "Session access is not available for this account.";
  return "Sessions could not be loaded. Try again.";
}

function sessionActionErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 503)
    return "Session changes are temporarily unavailable. Try again.";
  return "The session could not be changed. Refresh the list and try again.";
}

function accountDeviceLabel(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";

  const browser = /\b(?:Edg|EdgA|EdgiOS|Edge)(?:\/|\b)/i.test(userAgent)
    ? "Edge"
    : /\b(?:Chrome|CriOS)(?:\/|\b)/i.test(userAgent)
      ? "Chrome"
      : /\b(?:Firefox|FxiOS)(?:\/|\b)/i.test(userAgent)
        ? "Firefox"
        : /\bSafari(?:\/|\b)/i.test(userAgent)
          ? "Safari"
          : null;
  const platform = /\bAndroid\b/i.test(userAgent)
    ? "Android"
    : /\biPadOS\b/i.test(userAgent) || /\biPad\b/i.test(userAgent)
      ? "iPadOS"
      : /\b(?:iPhone|iPod|iOS)\b/i.test(userAgent)
        ? "iOS"
        : /\b(?:Macintosh|Mac OS X|macOS)\b/i.test(userAgent)
          ? "macOS"
          : /\bWindows\b/i.test(userAgent)
            ? "Windows"
            : /\bLinux\b/i.test(userAgent)
              ? "Linux"
              : null;

  return browser && platform ? `${browser} on ${platform}` : "Unknown device";
}

function formatLastActive(
  timestamp: string,
  workspace: WorkspaceRegion,
): string {
  try {
    if (Number.isNaN(new Date(timestamp).getTime()))
      return "Date format unavailable";
    return formatWorkspaceDateTime(timestamp, workspace);
  } catch {
    return "Date format unavailable";
  }
}

export default function Account() {
  const queryClient = useQueryClient();
  const completeSignOut = useWorkspaceSignOut();
  const actionTrigger = useRef<HTMLButtonElement | null>(null);
  const cancelTrigger = useRef<HTMLButtonElement | null>(null);
  const identity = useQuery(authMeOptions());
  const accountId = identity.data?.id ?? "";
  const sessionsQuery = useQuery(accountSessionsOptions(accountId));
  const workspaceQuery = useQuery({
    ...manageWorkspaceOptions(),
    enabled: Boolean(identity.data?.currentOrganization),
  });
  const displayRegion = useDisplayRegion(workspaceQuery.data);
  const passwordMutation = useMutation({
    mutationFn: (values: { currentPassword: string; newPassword: string }) =>
      changeAccountPassword(values.currentPassword, values.newPassword),
  });
  const sessionMutation = useMutation({ mutationFn: endAccountSession });
  const otherSessionsMutation = useMutation({
    mutationFn: endOtherAccountSessions,
  });
  const [confirmation, setConfirmation] = useState<AccountConfirmation>(null);
  const [passwordFeedback, setPasswordFeedback] = useState("");
  const [passwordFormError, setPasswordFormError] = useState("");
  const [currentPasswordError, setCurrentPasswordError] = useState("");
  const [newPasswordError, setNewPasswordError] = useState("");
  const [passwordSessionNote, setPasswordSessionNote] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [refreshingAfterPassword, setRefreshingAfterPassword] = useState(false);
  const [sessionActionFeedback, setSessionActionFeedback] = useState("");
  const [sessionActionError, setSessionActionError] = useState("");
  const activeSessions = sessionsQuery.data ?? [];
  const otherSessions = activeSessions.filter((session) => !session.current);
  const sessionError = identity.isError ? identity.error : sessionsQuery.error;
  const sessionsLoading =
    identity.isPending ||
    (Boolean(identity.data) && sessionsQuery.isPending) ||
    refreshingAfterPassword;
  const sessionActionPending =
    sessionMutation.isPending || otherSessionsMutation.isPending;
  const securityMutationPending =
    passwordMutation.isPending ||
    sessionActionPending ||
    refreshingAfterPassword;
  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accountId || securityMutationPending) return;
    const passwordLength = Array.from(newPassword).length;
    const missingCurrentPassword = !currentPassword;
    const invalidNewPassword = passwordLength < 12 || passwordLength > 128;
    setPasswordFeedback("");
    setPasswordSessionNote("");
    setCurrentPasswordError(
      missingCurrentPassword ? "Enter your current password." : "",
    );
    setNewPasswordError(invalidNewPassword ? PASSWORD_LENGTH_MESSAGE : "");
    setPasswordFormError("");
    if (missingCurrentPassword || invalidNewPassword) {
      return;
    }

    try {
      await passwordMutation.mutateAsync({ currentPassword, newPassword });
      setPasswordFeedback(
        "Password changed. Other sessions were ended; this session remains active.",
      );
    } catch (error) {
      const message = passwordErrorMessage(error);
      const field = passwordErrorField(error);
      if (field === "current") setCurrentPasswordError(message);
      else if (field === "new") setNewPasswordError(message);
      else setPasswordFormError(message);
      setPasswordSessionNote(
        "Other sessions may have ended. Check the active session list below.",
      );
    } finally {
      setCurrentPassword("");
      setNewPassword("");
      if (accountId) {
        setRefreshingAfterPassword(true);
        try {
          await Promise.all([
            queryClient.invalidateQueries({
              queryKey: platformKeys.accountSessions(accountId),
              exact: true,
            }),
            queryClient.invalidateQueries({ queryKey: accessKeys.directory() }),
          ]);
        } catch {
          // The query's visible error state explains when the refreshed list
          // could not be loaded.
        } finally {
          setRefreshingAfterPassword(false);
        }
      }
    }
  }

  async function confirmAccountAction() {
    const action = confirmation;
    if (!action || securityMutationPending) return;

    setSessionActionError("");
    setSessionActionFeedback("");
    try {
      if (action.type === "session") {
        await sessionMutation.mutateAsync(action.session.id);
        setConfirmation(null);
        if (action.session.current) {
          await completeSignOut();
          return;
        }
        setSessionActionFeedback(
          "Session ended. That device will be signed out.",
        );
      } else {
        await otherSessionsMutation.mutateAsync();
        setConfirmation(null);
        setSessionActionFeedback(
          "Other sessions ended. Your current session remains active.",
        );
      }
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: platformKeys.accountSessions(accountId),
          exact: true,
        }),
        queryClient.invalidateQueries({ queryKey: accessKeys.directory() }),
      ]);
    } catch (error) {
      setConfirmation(null);
      setSessionActionError(sessionActionErrorMessage(error));
    }
  }
  return (
    <div className="bg-background text-foreground grid grid-cols-1 items-start gap-5 rounded-xl xl:grid-cols-2">
      <Panel title="Account security">
        <div className="space-y-3">
          <h3 data-slot="section-title" className="font-medium">
            Password change
          </h3>
          <p className="text-muted-foreground text-sm">
            Enter your current password and choose a new password.
          </p>
          <form className="space-y-3" noValidate onSubmit={submitPassword}>
            <Field>
              <FieldLabel htmlFor="current-password">
                Current password
              </FieldLabel>
              <Input
                aria-invalid={Boolean(currentPasswordError)}
                aria-describedby={
                  currentPasswordError ? "current-password-error" : undefined
                }
                autoComplete="current-password"
                className="min-h-11"
                id="current-password"
                maxLength={128}
                onChange={(event) => {
                  setCurrentPassword(event.target.value);
                  setCurrentPasswordError("");
                  setPasswordFormError("");
                }}
                required
                type="password"
                value={currentPassword}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="new-password">New password</FieldLabel>
              <Input
                aria-invalid={Boolean(newPasswordError)}
                aria-describedby={
                  newPasswordError === PASSWORD_LENGTH_MESSAGE
                    ? "new-password-error"
                    : newPasswordError
                      ? "new-password-guidance new-password-error"
                      : "new-password-guidance"
                }
                autoComplete="new-password"
                className="min-h-11"
                id="new-password"
                maxLength={128}
                minLength={12}
                onChange={(event) => {
                  setNewPassword(event.target.value);
                  setNewPasswordError("");
                  setPasswordFormError("");
                }}
                required
                type="password"
                value={newPassword}
              />
            </Field>
            {newPasswordError !== PASSWORD_LENGTH_MESSAGE && (
              <p
                className="text-muted-foreground text-xs"
                id="new-password-guidance"
              >
                Use 12 to 128 characters.
              </p>
            )}
            {currentPasswordError && (
              <p
                id="current-password-error"
                role="alert"
                className="text-destructive text-sm"
              >
                {currentPasswordError}
              </p>
            )}
            {newPasswordError && (
              <p
                id="new-password-error"
                role="alert"
                className="text-destructive text-sm"
              >
                {newPasswordError}
              </p>
            )}
            {passwordFormError && (
              <p role="alert" className="text-destructive text-sm">
                {passwordFormError}
              </p>
            )}
            {passwordFeedback && (
              <p role="status" className="bg-muted rounded-lg p-3 text-sm">
                {passwordFeedback}
              </p>
            )}
            {passwordSessionNote && (
              <p role="status" className="text-muted-foreground text-sm">
                {passwordSessionNote}
              </p>
            )}
            <Action
              type="submit"
              disabled={securityMutationPending || !accountId}
            >
              {passwordMutation.isPending
                ? "Changing password…"
                : "Change password"}
            </Action>
          </form>
        </div>
        <div className="space-y-3 border-t pt-4">
          <h3 data-slot="section-title" className="font-medium">
            Device sessions
          </h3>
          <p className="text-muted-foreground text-sm">
            Ending a session signs out that device. Ending this session signs
            you out on this device.
          </p>
          <Action
            disabled={
              !accountId ||
              sessionsLoading ||
              Boolean(sessionError) ||
              otherSessions.length === 0 ||
              securityMutationPending
            }
            onClick={(event) => {
              actionTrigger.current = event.currentTarget;
              setSessionActionError("");
              setConfirmation({ type: "other-sessions" });
            }}
          >
            End all other sessions
          </Action>
          {sessionActionError && (
            <p role="alert" className="text-destructive text-sm">
              {sessionActionError}
            </p>
          )}
          {sessionActionFeedback && (
            <p role="status" className="bg-muted rounded-lg p-3 text-sm">
              {sessionActionFeedback}
            </p>
          )}
          <LoadingRegion
            loading={sessionsLoading}
            label="Loading active sessions…"
            skeleton={
              <div aria-hidden="true" className="space-y-3">
                <div className="bg-muted h-16 animate-pulse rounded-lg" />
                <div className="bg-muted h-16 animate-pulse rounded-lg" />
              </div>
            }
          >
            {sessionError ? (
              <div className="space-y-3 rounded-lg border p-3">
                <p role="alert" className="text-destructive text-sm">
                  {sessionLoadErrorMessage(sessionError)}
                </p>
                <Action
                  onClick={() => {
                    if (identity.isError) void identity.refetch();
                    else void sessionsQuery.refetch();
                  }}
                >
                  Retry sessions
                </Action>
              </div>
            ) : activeSessions.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No active sessions.
              </p>
            ) : (
              <ul aria-label="Active sessions" className="space-y-3">
                {activeSessions.map((session) => (
                  <li
                    key={session.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <p
                        className="max-w-full truncate font-medium"
                        title={session.user_agent ?? undefined}
                      >
                        {accountDeviceLabel(session.user_agent)}
                      </p>
                      <p className="text-muted-foreground text-xs break-all">
                        Sign-in IP: {session.ip_address ?? "Unknown"}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        {session.current ? "Current session · " : ""}
                        Last active{" "}
                        {displayRegion
                          ? formatLastActive(
                              session.refreshed_at,
                              displayRegion,
                            )
                          : workspaceQuery.isLoading
                            ? "Loading organization date settings…"
                            : "Date settings unavailable"}
                      </p>
                    </div>
                    <Action
                      disabled={securityMutationPending}
                      onClick={(event) => {
                        actionTrigger.current = event.currentTarget;
                        setSessionActionError("");
                        setSessionActionFeedback("");
                        setConfirmation({ type: "session", session });
                      }}
                    >
                      End session
                    </Action>
                  </li>
                ))}
              </ul>
            )}
          </LoadingRegion>
          {workspaceQuery.isError && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-3 rounded-lg border p-3"
            >
              <p className="text-destructive flex-1 text-sm">
                {workspaceQuery.data
                  ? "Organization date settings could not be refreshed. Session times use the last loaded settings."
                  : "Organization date settings could not be loaded. Retry to format session times."}
              </p>
              <Action onClick={() => void workspaceQuery.refetch()}>
                Retry date settings
              </Action>
            </div>
          )}
        </div>
        <AlertDialog
          open={confirmation !== null}
          dismissible={!securityMutationPending}
          onOpenChange={(open) => {
            if (!open && !securityMutationPending) setConfirmation(null);
          }}
        >
          <AlertDialogContent
            initialFocus={() => cancelTrigger.current}
            finalFocus={() => actionTrigger.current}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>Confirm account action</AlertDialogTitle>
              <AlertDialogDescription>
                {confirmation?.type === "other-sessions"
                  ? "End all other sessions? Your current session will remain active."
                  : confirmation?.session.current
                    ? "Ending this session will sign you out on this device."
                    : "Ending this session will sign out that device."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Action
                ref={cancelTrigger}
                variant="outline"
                onClick={() => setConfirmation(null)}
                disabled={securityMutationPending}
              >
                Cancel
              </Action>
              <Action
                variant="destructive"
                disabled={securityMutationPending}
                onClick={() => void confirmAccountAction()}
              >
                {confirmation?.type === "other-sessions"
                  ? "Confirm end all other sessions"
                  : confirmation?.session.current
                    ? "End this session and sign out"
                    : "Confirm end session"}
              </Action>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Panel>
    </div>
  );
}
