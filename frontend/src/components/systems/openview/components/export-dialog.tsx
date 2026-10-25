"use client";

import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { ApiError } from "@/lib/api";
import { requestSessionRecheck } from "@/lib/auth-api";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { cn } from "@/lib/utils";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  useVerifiedWorkspaceUserId,
  useWorkspaceInteractionSuspended,
} from "../../shared/runtime/workspace-identity";
import {
  isOpenViewAccessDenied,
  useOpenViewAccessDenied,
} from "../adapters/openview-access";
import {
  exportOpenViewRecords,
  type RecordsExportOptions,
} from "../adapters/records-export-api";
import type {
  OpenViewDataSourceField,
  OpenViewQueryDefinition,
} from "../adapters/views-api";

type ExportDialogProps = {
  moduleId: string;
  viewId: string | null;
  definition: OpenViewQueryDefinition;
  fields: OpenViewDataSourceField[];
  returnFocus: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onDownloaded: () => void;
};

function failureMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (["mfa_required", "ip_not_allowed"].includes(error.code ?? "")) {
      return "Session access needs to be checked before continuing.";
    }
    if (error.status === 401) {
      queueMicrotask(requestSessionRecheck);
      return "Your session needs to be checked before continuing.";
    }
    if (error.status === 403)
      return "You no longer have permission to export this data.";
    if (error.status === 404)
      return "This data source or view is no longer available. Choose another view.";
    if (error.code === "export_limit_exceeded")
      return "Export exceeds 10,000 rows or 8 MB. Narrow your query and try again.";
    if (error.code === "export_no_columns")
      return "Choose at least one column or include Record ID.";
  }
  return "The export could not be downloaded. Try again.";
}

export function ExportDialog({
  moduleId,
  viewId,
  definition,
  fields,
  returnFocus,
  onClose,
  onDownloaded,
}: ExportDialogProps) {
  const id = useId();
  const verifiedUserId = useVerifiedWorkspaceUserId();
  const suspended = useWorkspaceInteractionSuspended();
  const denied = useOpenViewAccessDenied();
  const [orderedFields, setOrderedFields] = useState(fields);
  const [selected, setSelected] = useState(
    () => new Set(fields.map((field) => field.id)),
  );
  const [format, setFormat] = useState<"csv" | "xlsx">("csv");
  const [includeRecordId, setIncludeRecordId] = useState(false);
  const [title, setTitle] = useState("");
  const [includeDetails, setIncludeDetails] = useState(true);
  const [accent, setAccent] = useState<"theme" | "gray" | "none">("theme");
  const [banded, setBanded] = useState(false);
  const [totals, setTotals] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const submitLock = useRef(false);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const urls = useRef(new Set<string>());
  const owner = useRef({
    mounted: false,
    userId: verifiedUserId,
    suspended,
    denied,
  });
  useLayoutEffect(() => {
    owner.current = {
      mounted: true,
      userId: verifiedUserId,
      suspended,
      denied,
    };
    return () => {
      owner.current.mounted = false;
      generation.current += 1;
      controller.current?.abort();
      for (const url of urls.current) URL.revokeObjectURL(url);
      urls.current.clear();
    };
  }, [verifiedUserId, suspended, denied]);
  const empty = selected.size === 0 && !includeRecordId;
  const cancel = () => {
    generation.current += 1;
    controller.current?.abort();
    submitLock.current = false;
    onClose();
  };
  const move = (fieldId: string, direction: -1 | 1) => {
    setOrderedFields((current) => {
      const index = current.findIndex((field) => field.id === fieldId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };
  const download = async () => {
    if (
      submitLock.current ||
      empty ||
      suspended ||
      denied ||
      isOpenViewAccessDenied()
    )
      return;
    submitLock.current = true;
    const request = ++generation.current;
    const abort = new AbortController();
    controller.current = abort;
    const userId = verifiedUserId;
    const ownsResult = () =>
      owner.current.mounted &&
      owner.current.userId === userId &&
      !owner.current.suspended &&
      !owner.current.denied &&
      !isOpenViewAccessDenied() &&
      request === generation.current &&
      !abort.signal.aborted;
    setPending(true);
    setError("");
    const source = {
      moduleId,
      viewId,
      includeRecordId,
      definition: {
        ...definition,
        columns: orderedFields
          .filter((field) => selected.has(field.id))
          .map((field) => ({ fieldId: field.id, expectedType: field.type })),
      },
    };
    const options: RecordsExportOptions =
      format === "csv"
        ? { ...source, format }
        : {
            ...source,
            format,
            title: title.trim() || null,
            includeDetails,
            accent,
            banded,
            totals,
          };
    try {
      const attachment = await exportOpenViewRecords(options, abort.signal);
      if (!ownsResult()) return;
      const url = URL.createObjectURL(attachment.blob);
      urls.current.add(url);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = attachment.filename;
      anchor.click();
      window.setTimeout(() => {
        URL.revokeObjectURL(url);
        urls.current.delete(url);
      }, 0);
      if (ownsResult()) onDownloaded();
    } catch (failure) {
      if (ownsResult()) setError(failureMessage(failure));
    } finally {
      if (ownsResult()) {
        submitLock.current = false;
        setPending(false);
      }
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
    >
      <DialogContent
        className={cn(dialogFrameContentClass, "sm:max-w-xl")}
        finalFocus={returnFocus}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void download();
          }}
        >
          <DialogFrameHeader
            title={<DialogTitle>Export records</DialogTitle>}
            description={
              <DialogDescription>
                Choose the columns and format for your current view.
              </DialogDescription>
            }
            closeLabel="Close export"
            onClose={cancel}
          />
          <FieldGroup className="gap-5">
            <Field>
              <FieldLabel htmlFor={`${id}-format`}>Format</FieldLabel>
              <Select
                id={`${id}-format`}
                className="min-h-11"
                disabled={pending}
                value={format}
                onValueChange={(value) =>
                  setFormat(value === "xlsx" ? "xlsx" : "csv")
                }
              >
                <option value="csv">CSV</option>
                <option value="xlsx">Excel (.xlsx)</option>
              </Select>
            </Field>
            <fieldset
              aria-describedby={empty ? `${id}-columns-error` : undefined}
            >
              <legend className="mb-2 text-sm font-medium">Columns</legend>
              <ul
                aria-label="Export columns"
                className="divide-y rounded-[var(--radius)] border"
              >
                {orderedFields.map((field, index) => (
                  <li
                    key={field.id}
                    className="flex min-w-0 items-center gap-1 px-2 py-1"
                  >
                    <label className="flex min-h-11 min-w-0 flex-1 items-center gap-3 px-1 text-sm">
                      <Checkbox
                        disabled={pending}
                        checked={selected.has(field.id)}
                        onCheckedChange={(checked) =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (checked) next.add(field.id);
                            else next.delete(field.id);
                            return next;
                          })
                        }
                      />
                      <span className="break-words">{field.name}</span>
                    </label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="min-h-11 min-w-11 shrink-0"
                      aria-label={`Move ${field.name} up`}
                      disabled={pending || index === 0}
                      onClick={() => move(field.id, -1)}
                    >
                      <ArrowUp aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="min-h-11 min-w-11 shrink-0"
                      aria-label={`Move ${field.name} down`}
                      disabled={pending || index === orderedFields.length - 1}
                      onClick={() => move(field.id, 1)}
                    >
                      <ArrowDown aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
              {empty ? (
                <p
                  id={`${id}-columns-error`}
                  role="alert"
                  className="text-destructive mt-2 text-sm"
                >
                  Choose at least one column or include Record ID.
                </p>
              ) : null}
            </fieldset>
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <Checkbox
                disabled={pending}
                checked={includeRecordId}
                onCheckedChange={setIncludeRecordId}
              />
              Include Record ID
            </label>
            {format === "xlsx" ? (
              <>
                <Field>
                  <FieldLabel htmlFor={`${id}-title`}>Title</FieldLabel>
                  <Input
                    id={`${id}-title`}
                    className="min-h-11"
                    value={title}
                    maxLength={120}
                    disabled={pending}
                    placeholder="Optional"
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </Field>
                <label className="flex min-h-11 items-center gap-3 text-sm">
                  <Checkbox
                    checked={includeDetails}
                    disabled={pending}
                    onCheckedChange={setIncludeDetails}
                  />
                  Include details
                </label>
                <Field>
                  <FieldLabel htmlFor={`${id}-accent`}>Accent</FieldLabel>
                  <Select
                    id={`${id}-accent`}
                    className="min-h-11"
                    value={accent}
                    disabled={pending}
                    onValueChange={(value) =>
                      setAccent(
                        value === "gray" || value === "none" ? value : "theme",
                      )
                    }
                  >
                    <option value="theme">Organization theme</option>
                    <option value="gray">Gray</option>
                    <option value="none">None</option>
                  </Select>
                </Field>
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="flex min-h-11 items-center gap-3 text-sm">
                    <Checkbox
                      checked={banded}
                      disabled={pending}
                      onCheckedChange={setBanded}
                    />
                    Banded rows
                  </label>
                  <label className="flex min-h-11 items-center gap-3 text-sm">
                    <Checkbox
                      checked={totals}
                      disabled={pending}
                      onCheckedChange={setTotals}
                    />
                    Numeric totals
                  </label>
                </div>
              </>
            ) : null}
            <p className="text-muted-foreground text-sm">
              Exports up to 10,000 rows. Your export is recorded.
            </p>
            {error ? (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            ) : null}
          </FieldGroup>
          <DialogFrameFooter>
            <DialogFooter className="mt-0">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={cancel}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="min-h-11"
                disabled={pending || empty || suspended || denied}
                aria-describedby={empty ? `${id}-columns-error` : undefined}
              >
                {pending ? "Downloading…" : "Download"}
              </Button>
            </DialogFooter>
          </DialogFrameFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
