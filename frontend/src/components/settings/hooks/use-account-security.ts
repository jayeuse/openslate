"use client";

import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useWorkspaceSignOut } from "@/components/systems/shared/runtime/workspace-identity";
import { authMeOptions } from "@/components/systems/openview/adapters/openview-queries";
import { accessKeys } from "@/components/systems/access/adapters/access-queries";
import { ApiError } from "@/lib/api";
import {
  changeAccountPassword,
  endAccountSession,
  endOtherAccountSessions,
  type AccountSession,
} from "@/components/systems/platform/adapters/account-api";
import {
  accountSessionsOptions,
  platformKeys,
} from "@/components/systems/platform/adapters/platform-queries";

type AccountConfirmation =
  | { type: "session"; session: AccountSession }
  | { type: "other-sessions" }
  | null;

export const PASSWORD_LENGTH_MESSAGE = "Use 12 to 128 characters.";

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

export function sessionLoadErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 403)
    return "Sessions are not available for this account.";
  return "Sessions could not be loaded. Try again.";
}

function sessionActionErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 503)
    return "Session changes are temporarily unavailable. Try again.";
  return "The session could not be changed. Refresh the list and try again.";
}

/**
 * The Sign-in group's password change and device sessions (PD11, PD12), moved
 * from Platform › Account. One owner serializes the password change and the
 * session revocations: while one runs, the others wait.
 */
export function useAccountSecurity() {
  const queryClient = useQueryClient();
  const completeSignOut = useWorkspaceSignOut();
  const actionTrigger = useRef<HTMLElement | null>(null);
  const identity = useQuery(authMeOptions());
  const accountId = identity.data?.id ?? "";
  const sessionsQuery = useQuery(accountSessionsOptions(accountId));
  const passwordMutation = useMutation({
    mutationFn: (values: { currentPassword: string; newPassword: string }) =>
      changeAccountPassword(values.currentPassword, values.newPassword),
  });
  const sessionMutation = useMutation({ mutationFn: endAccountSession });
  const otherSessionsMutation = useMutation({
    mutationFn: endOtherAccountSessions,
  });
  const [confirmation, setConfirmation] = useState<AccountConfirmation>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
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

  function resetPasswordForm() {
    setCurrentPassword("");
    setNewPassword("");
    setCurrentPasswordError("");
    setNewPasswordError("");
    setPasswordFormError("");
    setPasswordFeedback("");
    setPasswordSessionNote("");
  }

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
        "Password changed. Other devices are signed out; this device stays signed in.",
      );
    } catch (error) {
      const message = passwordErrorMessage(error);
      const field = passwordErrorField(error);
      if (field === "current") setCurrentPasswordError(message);
      else if (field === "new") setNewPasswordError(message);
      else setPasswordFormError(message);
      setPasswordSessionNote(
        "Other devices may be signed out. Check Sessions.",
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
        setSessionActionFeedback("Session ended. That device signs out.");
      } else {
        await otherSessionsMutation.mutateAsync();
        setConfirmation(null);
        setSessionActionFeedback(
          "Other sessions ended. This device stays signed in.",
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

  return {
    accountId,
    password: {
      open: passwordOpen,
      setOpen: (next: boolean) => {
        if (!next && passwordMutation.isPending) return;
        setPasswordOpen(next);
        if (next) resetPasswordForm();
        else {
          setCurrentPassword("");
          setNewPassword("");
        }
      },
      pending: passwordMutation.isPending,
      currentPassword,
      newPassword,
      setCurrentPassword: (value: string) => {
        setCurrentPassword(value);
        setCurrentPasswordError("");
        setPasswordFormError("");
      },
      setNewPassword: (value: string) => {
        setNewPassword(value);
        setNewPasswordError("");
        setPasswordFormError("");
      },
      currentPasswordError,
      newPasswordError,
      formError: passwordFormError,
      feedback: passwordFeedback,
      sessionNote: passwordSessionNote,
      submit: (event: FormEvent<HTMLFormElement>) => void submitPassword(event),
    },
    sessions: {
      list: activeSessions,
      othersCount: otherSessions.length,
      loading: sessionsLoading,
      error: sessionError,
      retry: () => {
        if (identity.isError) void identity.refetch();
        else void sessionsQuery.refetch();
      },
      actionError: sessionActionError,
      actionFeedback: sessionActionFeedback,
    },
    busy: securityMutationPending,
    confirmation,
    actionTrigger,
    askEndSession: (session: AccountSession, trigger: HTMLElement | null) => {
      actionTrigger.current = trigger;
      setSessionActionError("");
      setSessionActionFeedback("");
      setConfirmation({ type: "session", session });
    },
    askEndOthers: (trigger: HTMLElement | null) => {
      actionTrigger.current = trigger;
      setSessionActionError("");
      setConfirmation({ type: "other-sessions" });
    },
    cancelConfirmation: () => setConfirmation(null),
    confirm: () => void confirmAccountAction(),
  };
}

export type AccountSecurity = ReturnType<typeof useAccountSecurity>;
