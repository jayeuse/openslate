"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getApiFieldErrors } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-errors";
import { lifecycleErrorMessage } from "@/lib/lifecycle";
import { LifecyclePurgeReview } from "@/components/systems/shared/lifecycle-purge-review";
import { authMeOptions } from "../adapters/openview-queries";
import {
  subscribeWorkspaceLifecycleSettings,
  workspaceLifecycleQueryOptions,
} from "../../manage/adapters/workspace-api";
import type {
  OpenViewDataSourceField,
  OpenViewRecord,
} from "../adapters/views-api";
import {
  deleteOpenViewRecord,
  getOpenViewRecord,
  isStaleRecordSave,
  previewRecordPurge,
  purgeRecord,
  restoreOpenViewRecord,
  updateOpenViewRecord,
} from "../adapters/records-api";
import type { LifecyclePurgePreview } from "@/lib/lifecycle";
import {
  encodeRecordForm,
  initialFormValues,
  serverFieldMessage,
  type RecordFormErrors,
  type RecordFormValues,
} from "../domain/record-form";
import { RecordFormFields } from "./record-form-fields";
import { Alert } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

type Editing = {
  /** The complete stored record the form started from. */
  source: OpenViewRecord;
  values: RecordFormValues;
  errors: RecordFormErrors;
  stale: boolean;
};

type RecordDetailsControlsProps = {
  record: OpenViewRecord;
  moduleId: string;
  /** Every active field of the record's module, in order. */
  fields: readonly OpenViewDataSourceField[];
  canWrite: boolean;
  /** The read-only field list. */
  children: ReactNode;
  onChanged: (message: string) => void;
  /** Reports whether the edit form is open, so the dialog can guard it. */
  onEditingChange?: (editing: boolean) => void;
};

/** Focuses after React renders the next state. */
function focusSoon(find: () => HTMLElement | null | undefined) {
  requestAnimationFrame(() => find()?.focus());
}

function fieldErrors(
  error: unknown,
  fields: readonly OpenViewDataSourceField[],
): RecordFormErrors {
  const known = new Set(fields.map((field) => field.id));
  return Object.fromEntries(
    Object.entries(getApiFieldErrors(error))
      .filter(([fieldId]) => known.has(fieldId))
      .map(([fieldId, messages]) => [
        fieldId,
        serverFieldMessage(messages[0] ?? ""),
      ]),
  );
}

/** The Details tab: read-only values, or the edit form, and lifecycle actions. */
export function RecordDetailsControls({
  record,
  moduleId,
  fields,
  canWrite,
  children,
  onChanged,
  onEditingChange,
}: RecordDetailsControlsProps) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const identity = useQuery(authMeOptions());
  const isAdmin = identity.data?.role === "admin";
  const client = useQueryClient();
  const workspace = useQuery({
    ...workspaceLifecycleQueryOptions(),
    enabled: isAdmin && record.isDeleted,
  });
  const canPurge =
    isAdmin &&
    record.isDeleted &&
    workspace.isSuccess &&
    workspace.data.purge_enabled;
  useEffect(() => {
    if (isAdmin && record.isDeleted)
      return subscribeWorkspaceLifecycleSettings(client);
  }, [client, isAdmin, record.isDeleted]);
  const isEditing = editing !== null;
  useEffect(() => {
    onEditingChange?.(isEditing);
  }, [isEditing, onEditingChange]);
  useEffect(() => () => onEditingChange?.(false), [onEditingChange]);
  const focusFirstInvalid = () =>
    focusSoon(() =>
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]'),
    );
  const focusEditButton = () => focusSoon(() => editButtonRef.current);
  const [pending, setPending] = useState<
    | "open"
    | "save"
    | "delete"
    | "restore"
    | "reload"
    | "purge-preview"
    | "purge"
    | null
  >(null);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [purgePreview, setPurgePreview] =
    useState<LifecyclePurgePreview | null>(null);
  const [purgeConfirmationName, setPurgeConfirmationName] = useState("");
  const [purgePassword, setPurgePassword] = useState("");
  const [purgeReviewAgain, setPurgeReviewAgain] = useState(false);
  const busy = pending !== null;
  useEffect(() => {
    if (canPurge) return;
    setPurgePreview(null);
    setPurgeConfirmationName("");
    setPurgePassword("");
    setPurgeReviewAgain(false);
  }, [canPurge]);

  const startEditing = async (reload = false) => {
    setPending(reload ? "reload" : "open");
    setError("");
    try {
      const source = await getOpenViewRecord(record.id);
      if (source.isDeleted) {
        setEditing(null);
        setError("This record was deleted. Restore it to change its values.");
        onChanged("");
        return;
      }
      setEditing({
        source,
        values: initialFormValues(fields, source.data),
        errors: {},
        stale: false,
      });
      if (!reload)
        focusSoon(() =>
          formRef.current?.querySelector<HTMLElement>(
            "input, select, textarea",
          ),
        );
    } catch (caught) {
      setError(
        apiErrorMessage(caught, "The record could not be opened for editing."),
      );
    } finally {
      setPending(null);
    }
  };

  const save = async () => {
    if (!editing) return;
    const { data, errors, changed } = encodeRecordForm(
      fields,
      editing.values,
      editing.source.data,
    );
    if (Object.keys(errors).length > 0) {
      setEditing({ ...editing, errors });
      focusFirstInvalid();
      return;
    }
    if (!changed) {
      setEditing(null);
      focusEditButton();
      return;
    }
    setPending("save");
    setError("");
    try {
      await updateOpenViewRecord({
        recordId: record.id,
        revision: editing.source.updatedAt,
        data,
      });
      setEditing(null);
      onChanged("Record saved.");
      focusEditButton();
    } catch (caught) {
      if (isStaleRecordSave(caught)) {
        setEditing({ ...editing, errors: {}, stale: true });
      } else {
        const errors = fieldErrors(caught, fields);
        setEditing({ ...editing, errors });
        if (Object.keys(errors).length > 0) focusFirstInvalid();
        if (Object.keys(errors).length === 0)
          setError(apiErrorMessage(caught, "The record could not be saved."));
      }
    } finally {
      setPending(null);
    }
  };

  const remove = async () => {
    setPending("delete");
    setError("");
    try {
      await deleteOpenViewRecord(record.id);
      setConfirmDelete(false);
      onChanged("Record deleted. You can restore it from this dialog.");
    } catch (caught) {
      setConfirmDelete(false);
      setError(apiErrorMessage(caught, "The record could not be deleted."));
    } finally {
      setPending(null);
    }
  };

  const restore = async () => {
    setPending("restore");
    setError("");
    try {
      await restoreOpenViewRecord(record.id);
      onChanged("Record restored.");
    } catch (caught) {
      setError(apiErrorMessage(caught, "The record could not be restored."));
    } finally {
      setPending(null);
    }
  };

  const clearPurgeReview = () => {
    setPurgePreview(null);
    setPurgeConfirmationName("");
    setPurgePassword("");
    setPurgeReviewAgain(false);
  };

  const beginPurgeReview = async () => {
    if (!canPurge || busy) return;
    setPending("purge-preview");
    setError("");
    clearPurgeReview();
    try {
      const preview = await previewRecordPurge(record.id);
      setPurgePreview(preview);
      setPurgeReviewAgain(preview.impact.blockers.length > 0);
    } catch (caught) {
      setError(
        lifecycleErrorMessage(
          caught,
          "A permanent-deletion review could not be prepared. Try again.",
        ),
      );
      setPurgeReviewAgain(true);
    } finally {
      setPending(null);
      setPurgePassword("");
    }
  };

  const confirmPurge = async () => {
    if (
      !canPurge ||
      !purgePreview ||
      purgePreview.impact.blockers.length > 0 ||
      purgeConfirmationName !== purgePreview.confirmation_name ||
      purgePassword.length === 0 ||
      busy
    )
      return;
    const password = purgePassword;
    setPending("purge");
    setError("");
    try {
      await purgeRecord(record.id, {
        token: purgePreview.token,
        confirmationName: purgePreview.confirmation_name,
        password,
      });
      clearPurgeReview();
      onChanged("Record permanently deleted.");
    } catch (caught) {
      setError(
        lifecycleErrorMessage(
          caught,
          "The record was not permanently deleted. Request a new review and try again.",
        ),
      );
      clearPurgeReview();
      setPurgeReviewAgain(true);
    } finally {
      setPurgePassword("");
      setPending(null);
    }
  };

  const editable = canWrite && !record.isDeleted;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {error ? (
        <Alert role="alert" variant="destructive">
          {error}
        </Alert>
      ) : null}
      {editing ? (
        <form
          ref={formRef}
          className="flex min-w-0 flex-col gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {editing.stale ? (
            <Alert role="alert" variant="destructive">
              <p className="font-medium">
                This record changed after you opened it
              </p>
              <p className="mt-1">
                Your changes are not saved. Load the latest values, then make
                your changes again.
              </p>
              <Button
                type="button"
                variant="outline"
                className="mt-3 min-h-11"
                disabled={busy}
                onClick={() => void startEditing(true)}
              >
                {pending === "reload" ? "Loading…" : "Load latest values"}
              </Button>
            </Alert>
          ) : null}
          <RecordFormFields
            moduleId={moduleId}
            fields={fields}
            values={editing.values}
            errors={editing.errors}
            disabled={busy}
            onChange={(fieldId, value) =>
              setEditing((current) =>
                current
                  ? {
                      ...current,
                      values: { ...current.values, [fieldId]: value },
                      errors: Object.fromEntries(
                        Object.entries(current.errors).filter(
                          ([id]) => id !== fieldId,
                        ),
                      ),
                    }
                  : current,
              )
            }
          />
          <div className="bg-card sticky bottom-0 z-10 flex flex-wrap gap-2 border-t py-3">
            <Button
              type="submit"
              className="min-h-11"
              disabled={busy || editing.stale}
            >
              {pending === "save" ? "Saving…" : "Save changes"}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={busy}
              onClick={() => {
                setEditing(null);
                setError("");
                focusEditButton();
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          {editable ? (
            <div className="flex flex-wrap gap-2">
              <Button
                ref={editButtonRef}
                type="button"
                className="min-h-11"
                disabled={busy}
                onClick={() => void startEditing()}
              >
                {pending === "open" ? "Opening…" : "Edit record"}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="text-destructive min-h-11"
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >
                Delete record
              </Button>
            </div>
          ) : record.isDeleted && (canWrite || isAdmin) ? (
            <div className="flex flex-wrap gap-2">
              {canWrite ? (
                <Button
                  type="button"
                  className="min-h-11"
                  disabled={busy}
                  onClick={() => void restore()}
                >
                  {pending === "restore" ? "Restoring…" : "Restore record"}
                </Button>
              ) : null}
              {canPurge ? (
                <Button
                  type="button"
                  variant="outline"
                  className="text-destructive min-h-11"
                  disabled={busy}
                  onClick={() => void beginPurgeReview()}
                >
                  {pending === "purge-preview"
                    ? "Preparing review…"
                    : purgeReviewAgain
                      ? "Review again"
                      : "Permanently delete"}
                </Button>
              ) : null}
            </div>
          ) : null}
          {canPurge && purgePreview ? (
            <div className="border-border space-y-4 rounded-lg border p-4">
              <LifecyclePurgeReview impact={purgePreview.impact} />
              {purgePreview.impact.blockers.length > 0 ? null : (
                <form
                  className="space-y-4"
                  onSubmit={(event: FormEvent<HTMLFormElement>) => {
                    event.preventDefault();
                    void confirmPurge();
                  }}
                >
                  <p className="text-sm" role="status">
                    Type the exact record ID and enter your administrator
                    password to continue.
                  </p>
                  <p className="text-sm">
                    Record ID: <code className="break-all">{record.id}</code>
                  </p>
                  <div className="space-y-2">
                    <label
                      htmlFor={`${id}-purge-confirmation`}
                      className="text-sm font-medium"
                    >
                      Type the record ID
                    </label>
                    <input
                      id={`${id}-purge-confirmation`}
                      value={purgeConfirmationName}
                      autoComplete="off"
                      disabled={busy}
                      className="border-input bg-card text-foreground focus-visible:outline-ring min-h-11 w-full rounded-md border px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
                      onChange={(event) =>
                        setPurgeConfirmationName(event.target.value)
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <label
                      htmlFor={`${id}-purge-password`}
                      className="text-sm font-medium"
                    >
                      Administrator password
                    </label>
                    <input
                      id={`${id}-purge-password`}
                      type="password"
                      value={purgePassword}
                      autoComplete="current-password"
                      disabled={busy}
                      className="border-input bg-card text-foreground focus-visible:outline-ring min-h-11 w-full rounded-md border px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
                      onChange={(event) => setPurgePassword(event.target.value)}
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="submit"
                      variant="destructive"
                      className="min-h-11"
                      disabled={
                        busy ||
                        purgeConfirmationName !==
                          purgePreview.confirmation_name ||
                        purgePassword.length === 0
                      }
                    >
                      {pending === "purge"
                        ? "Deleting…"
                        : "Confirm permanent deletion"}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={busy}
                      onClick={() => {
                        clearPurgeReview();
                        setError("");
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              )}
            </div>
          ) : null}
          {children}
        </>
      )}
      <AlertDialog
        open={confirmDelete}
        onOpenChange={(open) => {
          if (!busy) setConfirmDelete(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this record?</AlertDialogTitle>
            <AlertDialogDescription>
              It moves to deleted records, and its links are hidden. You can
              restore it later with its values and links.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={busy}
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="min-h-11"
              disabled={busy}
              onClick={() => void remove()}
            >
              {pending === "delete" ? "Deleting…" : "Delete record"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
