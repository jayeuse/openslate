"use client";

import { useId, type ReactNode, type Ref } from "react";
import { ChevronLeft, RotateCcw } from "lucide-react";
import { AdvancedSection } from "@/components/ui/advanced-section";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { isAutomaticSave } from "../domain/version-history";
import type { SandboxCommandResult } from "../state/commands";
import type { SandboxVersion } from "../state/api";
import { versionKindWord } from "./version-list";

// One version's detail in History (docs/specs/sandbox-relayout.md S8, S10):
// the label, kind, number, and a quiet Restore in the head; Saved and Note
// as label-left rows; then Compare (the children); then Advanced with the
// label edit and Delete version.

export type CheckpointLabelEdit = {
  id: string;
  value: string;
  error: string;
};

function formatVersionDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function VersionDetail({
  version,
  hidden,
  phone,
  headingRef,
  viewerId,
  pending,
  onBack,
  onRestore,
  onDelete,
  deleteReason,
  deleteBlocked,
  labelEdit,
  onLabelEdit,
  updateVersion,
  onLabelSaved,
  children,
}: {
  version: SandboxVersion | undefined;
  /** On phones the detail hides while the list shows. */
  hidden: boolean;
  phone: boolean;
  headingRef: Ref<HTMLHeadingElement>;
  /** The signed-in account: its own saves say "You". */
  viewerId: string;
  pending: boolean;
  onBack: () => void;
  /** Opens the Restore confirmation; the button gets focus back. */
  onRestore: (button: HTMLElement) => void;
  onDelete: (button: HTMLElement) => void;
  /** Why Delete version is unavailable, when it is. */
  deleteReason: string | null;
  deleteBlocked: boolean;
  labelEdit: CheckpointLabelEdit | null;
  onLabelEdit: (edit: CheckpointLabelEdit | null) => void;
  updateVersion: (
    id: string,
    label: string,
  ) => Promise<SandboxCommandResult<SandboxVersion>>;
  onLabelSaved: (version: SandboxVersion) => void;
  /** Compare, between the facts and Advanced. */
  children: ReactNode;
}) {
  return (
    <section
      aria-label="Selected version"
      className={cn(
        "bg-card border-border @container/detail flex min-w-0 flex-col rounded-xl border xl:h-full xl:min-h-0 xl:overflow-clip",
        hidden && "hidden",
      )}
    >
      {version ? (
        <>
          <div
            className={cn(
              "border-border flex min-h-14 flex-wrap items-center gap-x-2 gap-y-1 border-b py-2",
              phone ? "px-3" : "px-5",
            )}
          >
            {phone ? (
              <Button
                variant="ghost"
                className="-ml-1 min-h-11 px-2"
                onClick={onBack}
              >
                <ChevronLeft aria-hidden="true" />
                <span className="sr-only">Back to </span>
                Versions
              </Button>
            ) : null}
            <h2
              ref={headingRef}
              tabIndex={-1}
              data-slot="section-title"
              title={version.label}
              className={cn(
                "min-w-0 text-lg font-semibold outline-none",
                phone
                  ? "order-last basis-full px-2 [overflow-wrap:anywhere] break-words"
                  : "truncate",
              )}
            >
              {version.label}
            </h2>
            <Badge variant="outline" className="shrink-0">
              {versionKindWord(version, isAutomaticSave(version))}
            </Badge>
            <span className="text-muted-foreground shrink-0 text-sm tabular-nums">
              v{version.sequence}
            </span>
            <Button
              variant="ghost"
              className="ml-auto min-h-11 shrink-0 px-3 xl:min-h-8"
              disabled={pending}
              onClick={(event) => onRestore(event.currentTarget)}
            >
              <RotateCcw aria-hidden="true" />
              Restore<span className="sr-only"> version</span>
            </Button>
          </div>

          <div className="grid min-h-0 min-w-0 flex-1 content-start gap-5 p-5 xl:overflow-y-auto">
            <dl className="grid gap-x-4 gap-y-2 text-sm @min-[30rem]/detail:grid-cols-[7rem_minmax(0,1fr)]">
              <dt className="text-muted-foreground">Saved</dt>
              <dd title={version.createdAt}>
                <time dateTime={version.createdAt}>
                  {formatVersionDate(version.createdAt)}
                </time>
                {/* The page knows no other account's name. */}
                {version.performedBy === viewerId ? " · You" : ""}
              </dd>
              {version.note ? (
                <>
                  <dt className="text-muted-foreground">Note</dt>
                  <dd className="break-words">{version.note}</dd>
                </>
              ) : null}
            </dl>

            {children}

            <AdvancedSection
              storageKey="sandbox.version"
              summary={
                version.kind === "checkpoint"
                  ? "Edit label, Delete version"
                  : "Delete version"
              }
            >
              {labelEdit?.id === version.id ? (
                <form
                  aria-label={`Edit checkpoint label ${version.label}`}
                  className="grid gap-3"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    if (pending || !labelEdit) return;
                    const label = labelEdit.value.trim();
                    if (!label) {
                      onLabelEdit({
                        ...labelEdit,
                        error: "Checkpoint label is required",
                      });
                      return;
                    }
                    if (labelEdit.value.length > 80) {
                      onLabelEdit({
                        ...labelEdit,
                        error:
                          "Checkpoint label must be 80 characters or fewer",
                      });
                      return;
                    }
                    const result = await updateVersion(version.id, label);
                    if (!result.ok) {
                      onLabelEdit({
                        ...labelEdit,
                        error: result.error,
                      });
                      return;
                    }
                    onLabelSaved(result.value);
                    // The new label shows in place (inline feedback).
                    onLabelEdit(null);
                  }}
                >
                  <LabeledField label="Checkpoint label">
                    {(controlId) => (
                      <Input
                        id={controlId}
                        autoFocus
                        required
                        maxLength={80}
                        disabled={pending}
                        value={labelEdit.value}
                        onKeyDown={(event) => {
                          if (event.key !== "Escape" || pending) return;
                          event.preventDefault();
                          onLabelEdit(null);
                        }}
                        onChange={(event) =>
                          onLabelEdit({
                            ...labelEdit,
                            value: event.target.value,
                            error: "",
                          })
                        }
                      />
                    )}
                  </LabeledField>
                  {labelEdit.error ? (
                    <Alert variant="destructive" role="alert">
                      {labelEdit.error}
                    </Alert>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      type="submit"
                      pending={pending}
                      pendingLabel="Saving…"
                    >
                      Save label
                    </Button>
                    <Button
                      size="sm"
                      type="button"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => onLabelEdit(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              ) : null}
              {version.kind === "checkpoint" && labelEdit?.id !== version.id ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    onLabelEdit({
                      id: version.id,
                      value: version.label,
                      error: "",
                    })
                  }
                >
                  Edit checkpoint label
                </Button>
              ) : null}
              <DisabledReason reason={deleteReason}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-danger-text"
                  disabled={pending || deleteBlocked}
                  onClick={(event) => onDelete(event.currentTarget)}
                >
                  Delete version
                </Button>
              </DisabledReason>
            </AdvancedSection>
          </div>
        </>
      ) : (
        <Empty className="border-0 py-10">
          <EmptyHeader>
            <EmptyTitle>Select a version to see its details.</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
    </section>
  );
}

function LabeledField({
  label,
  children,
}: {
  label: string;
  children: (controlId: string) => ReactNode;
}) {
  const controlId = useId();
  return (
    <Field>
      <FieldLabel htmlFor={controlId} className="text-xs">
        {label}
      </FieldLabel>
      {children(controlId)}
    </Field>
  );
}
