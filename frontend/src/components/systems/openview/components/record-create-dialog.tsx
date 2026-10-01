"use client";

import { useRef, useState } from "react";
import { getApiFieldErrors } from "@/lib/api";
import type {
  OpenViewDataSourceField,
  OpenViewRecord,
} from "../adapters/views-api";
import { createOpenViewRecord } from "../adapters/records-api";
import {
  encodeRecordForm,
  initialFormValues,
  serverFieldMessage,
  type RecordFormErrors,
  type RecordFormValues,
} from "../domain/record-form";
import { RecordFormFields } from "./record-form-fields";
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

type RecordCreateDialogProps = {
  open: boolean;
  moduleId: string;
  moduleName: string;
  fields: readonly OpenViewDataSourceField[];
  onOpenChange: (open: boolean) => void;
  onCreated: (record: OpenViewRecord) => void;
};

function CreateForm({
  moduleId,
  moduleName,
  fields,
  onCancel,
  onCreated,
  onDirty,
}: Omit<RecordCreateDialogProps, "open" | "onOpenChange"> & {
  onCancel: () => void;
  onDirty: () => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const focusFirstInvalid = () =>
    requestAnimationFrame(() =>
      formRef.current
        ?.querySelector<HTMLElement>('[aria-invalid="true"]')
        ?.focus(),
    );
  const [values, setValues] = useState<RecordFormValues>(() =>
    initialFormValues(fields, null),
  );
  const [errors, setErrors] = useState<RecordFormErrors>({});
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const create = async () => {
    const encoded = encodeRecordForm(fields, values, null);
    setErrors(encoded.errors);
    if (Object.keys(encoded.errors).length > 0) {
      focusFirstInvalid();
      return;
    }
    setPending(true);
    setError("");
    try {
      onCreated(await createOpenViewRecord({ moduleId, data: encoded.data }));
    } catch (caught) {
      const known = new Set(fields.map((field) => field.id));
      const serverErrors = Object.fromEntries(
        Object.entries(getApiFieldErrors(caught))
          .filter(([fieldId]) => known.has(fieldId))
          .map(([fieldId, messages]) => [
            fieldId,
            serverFieldMessage(messages[0] ?? ""),
          ]),
      );
      setErrors(serverErrors);
      if (Object.keys(serverErrors).length > 0) focusFirstInvalid();
      if (Object.keys(serverErrors).length === 0)
        setError(
          caught instanceof Error && caught.message
            ? caught.message
            : "The record could not be created.",
        );
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      ref={formRef}
      className="flex min-h-0 flex-col gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <div className="min-w-0 pt-4">
        {error ? (
          <Alert role="alert" variant="destructive" className="mb-4">
            {error}
          </Alert>
        ) : null}
        <RecordFormFields
          moduleId={moduleId}
          fields={fields}
          values={values}
          errors={errors}
          disabled={pending}
          onChange={(fieldId, value) => {
            onDirty();
            setValues((current) => ({ ...current, [fieldId]: value }));
            setErrors((current) =>
              Object.fromEntries(
                Object.entries(current).filter(([id]) => id !== fieldId),
              ),
            );
          }}
        />
      </div>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" className="min-h-11" disabled={pending}>
          {pending ? "Creating…" : `Create ${moduleName} record`}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** A dialog that adds one record to the current data source. */
export function RecordCreateDialog({
  open,
  moduleId,
  moduleName,
  fields,
  onOpenChange,
  onCreated,
}: RecordCreateDialogProps) {
  // Typed values are not dropped by an outside click or Escape.
  const [dirty, setDirty] = useState(false);
  const changeOpen = (next: boolean) => {
    if (!next) setDirty(false);
    onOpenChange(next);
  };
  return (
    <Dialog open={open} dismissible={!dirty} onOpenChange={changeOpen}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New record</DialogTitle>
          <DialogDescription>
            Add a record to {moduleName}. Fields left empty use their default
            value.
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <CreateForm
            moduleId={moduleId}
            moduleName={moduleName}
            fields={fields}
            onCancel={() => changeOpen(false)}
            onDirty={() => setDirty(true)}
            onCreated={(record) => {
              setDirty(false);
              onCreated(record);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
