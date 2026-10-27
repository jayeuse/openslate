"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  DialogFrameFooter,
  DialogFrameHeader,
  dialogFrameContentClass,
} from "@/components/ui/dialog-frame";
import { Field, FieldLabel } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  catalogFirstPageOptions,
  fieldsFirstPageOptions,
} from "../../openview/adapters/openview-queries";
import type {
  CalendarSource,
  CalendarSourceInput,
} from "../adapters/board-calendar-sources-api";

/**
 * Add record source (BR57): a framed dialog with Module and Date field. The
 * modules are those the manager reads; a field must be a date or datetime.
 */
export function BoardCalendarSourceDialog({
  open,
  existing,
  onClose,
  onAdd,
}: {
  open: boolean;
  existing: readonly CalendarSource[];
  onClose: () => void;
  onAdd: (input: CalendarSourceInput) => Promise<void>;
}) {
  const [moduleId, setModuleId] = useState("");
  const [dateFieldId, setDateFieldId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modules = useQuery({ ...catalogFirstPageOptions(), enabled: open });
  const fields = useQuery({
    ...fieldsFirstPageOptions(moduleId),
    enabled: open && Boolean(moduleId),
  });
  const dateFields = (fields.data?.items ?? []).filter(
    (field) =>
      (field.type === "date" || field.type === "datetime") &&
      !existing.some((source) => source.dateFieldId === field.id),
  );

  function close() {
    if (pending) return;
    setModuleId("");
    setDateFieldId("");
    setError(null);
    onClose();
  }

  async function add() {
    if (!moduleId || !dateFieldId || pending) return;
    setPending(true);
    setError(null);
    try {
      await onAdd({ moduleId, dateFieldId });
      setModuleId("");
      setDateFieldId("");
      onClose();
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.message
          ? failure.message
          : "The record source was not added. Try again.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      dismissible={!pending}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className={cn(dialogFrameContentClass, "max-w-lg")}>
        <DialogFrameHeader
          title={<DialogTitle>Add record source</DialogTitle>}
          description={
            <p className="text-muted-foreground text-sm">
              Records show on their dates for everyone who reads this board and
              the module.
            </p>
          }
          closeLabel="Close without adding"
          closeDisabled={pending}
          onClose={close}
        />
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <Field className="gap-1.5">
            <FieldLabel htmlFor="board-calendar-source-module">
              Module
            </FieldLabel>
            <NativeSelect
              id="board-calendar-source-module"
              className="w-full"
              value={moduleId}
              disabled={pending || modules.isPending}
              onChange={(event) => {
                setModuleId(event.target.value);
                setDateFieldId("");
              }}
            >
              <option value="">
                {modules.isPending ? "Loading modules…" : "Choose a module"}
              </option>
              {(modules.data?.items ?? []).map((module) => (
                <option key={module.id} value={module.id}>
                  {module.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field className="gap-1.5">
            <FieldLabel htmlFor="board-calendar-source-field">
              Date field
            </FieldLabel>
            <NativeSelect
              id="board-calendar-source-field"
              className="w-full"
              value={dateFieldId}
              disabled={pending || !moduleId || fields.isPending}
              onChange={(event) => setDateFieldId(event.target.value)}
            >
              <option value="">
                {!moduleId
                  ? "Choose a module first"
                  : fields.isPending
                    ? "Loading fields…"
                    : dateFields.length
                      ? "Choose a date field"
                      : "This module has no date field to add"}
              </option>
              {dateFields.map((field) => (
                <option key={field.id} value={field.id}>
                  {field.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {modules.isError || fields.isError ? (
            <p role="alert" className="text-danger-text text-sm">
              The modules could not be loaded. Close and try again.
            </p>
          ) : null}
          <DialogFrameFooter>
            {error ? (
              <p role="alert" className="text-danger-text text-sm">
                {error}
              </p>
            ) : null}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                className="min-h-11 xl:min-h-8"
                disabled={pending}
                onClick={close}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="min-h-11 xl:min-h-8"
                disabled={pending || !moduleId || !dateFieldId}
              >
                {pending ? "Adding…" : "Add source"}
              </Button>
            </div>
          </DialogFrameFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
