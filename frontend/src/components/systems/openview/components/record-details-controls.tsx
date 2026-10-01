"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { getApiFieldErrors } from "@/lib/api";
import type {
  OpenViewDataSourceField,
  OpenViewRecord,
} from "../adapters/views-api";
import {
  deleteOpenViewRecord,
  getOpenViewRecord,
  isStaleRecordSave,
  restoreOpenViewRecord,
  updateOpenViewRecord,
} from "../adapters/records-api";
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

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
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
    "open" | "save" | "delete" | "restore" | "reload" | null
  >(null);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

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
        errorMessage(caught, "The record could not be opened for editing."),
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
          setError(errorMessage(caught, "The record could not be saved."));
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
      setError(errorMessage(caught, "The record could not be deleted."));
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
      setError(errorMessage(caught, "The record could not be restored."));
    } finally {
      setPending(null);
    }
  };

  const busy = pending !== null;
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
            <Alert role="alert" variant="warning">
              <p className="font-medium">
                Someone saved this record after you opened it
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
          {canWrite ? (
            <div className="flex flex-wrap gap-2">
              {editable ? (
                <>
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
                </>
              ) : (
                <Button
                  type="button"
                  className="min-h-11"
                  disabled={busy}
                  onClick={() => void restore()}
                >
                  {pending === "restore" ? "Restoring…" : "Restore record"}
                </Button>
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
