"use client";

import { useId, useRef, useState, type ReactNode } from "react";
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
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { changesFrom, counts } from "../domain/model";
import { projectSandboxDocument } from "../domain/document-bridge";
import type { SandboxDocumentV2 } from "../domain/document";
import type { SandboxCommandResult } from "../state/commands";
import type {
  SandboxDocumentResponse,
  SandboxVersion,
  SandboxVersionDetail,
} from "../state/api";

type Props = {
  versions: SandboxVersion[];
  getVersion: (
    id: string,
  ) => Promise<SandboxCommandResult<SandboxVersionDetail>>;
  updateVersion: (
    id: string,
    label: string,
  ) => Promise<SandboxCommandResult<SandboxVersion>>;
  restoreVersion: (
    id: string,
  ) => Promise<SandboxCommandResult<SandboxDocumentResponse>>;
  deleteVersion: (id: string) => Promise<SandboxCommandResult<null>>;
  notify: (message: string) => void;
  pending: boolean;
};

function canonicalEntityChanges(
  label: "Automation" | "Scenario",
  before: ReadonlyArray<{ id: string; name: string }>,
  after: ReadonlyArray<{ id: string; name: string }>,
): string[] {
  const beforeById = new Map(before.map((item) => [item.id, item]));
  const afterById = new Map(after.map((item) => [item.id, item]));
  const changes: string[] = [];
  for (const item of after) {
    const previous = beforeById.get(item.id);
    if (!previous) changes.push(`${label} added: ${item.name}`);
    else if (JSON.stringify(previous) !== JSON.stringify(item))
      changes.push(`${label} changed: ${item.name}`);
  }
  for (const item of before)
    if (!afterById.has(item.id)) changes.push(`${label} removed: ${item.name}`);
  return changes;
}

/** Compares canonical v2 documents without reducing automation content to Designer rules. */
export function canonicalVersionChanges(
  before: SandboxDocumentV2,
  after: SandboxDocumentV2,
): string[] {
  return [
    ...changesFrom(
      projectSandboxDocument(before),
      projectSandboxDocument(after),
    ),
    ...canonicalEntityChanges(
      "Automation",
      before.automations,
      after.automations,
    ),
    ...canonicalEntityChanges("Scenario", before.scenarios, after.scenarios),
  ];
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

function VersionChoice({
  label,
  value,
  versions,
  onChange,
}: {
  label: string;
  value: string;
  versions: SandboxVersion[];
  onChange: (value: string) => void;
}) {
  return (
    <LabeledField label={label}>
      {(controlId) => (
        <NativeSelect
          id={controlId}
          className="w-full [&_select]:min-h-11"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          {versions.map((version) => (
            <NativeSelectOption key={version.id} value={version.id}>
              {version.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      )}
    </LabeledField>
  );
}

export function VersionsWorkspace({
  versions,
  getVersion,
  updateVersion,
  restoreVersion,
  deleteVersion,
  notify,
  pending,
}: Props) {
  const [compareA, setCompareA] = useState(versions[0]?.id ?? "");
  const [compareB, setCompareB] = useState(versions.at(-1)?.id ?? "");
  const [comparing, setComparing] = useState(false);
  const [checkpointLabelEdit, setCheckpointLabelEdit] = useState<{
    id: string;
    value: string;
    error: string;
  } | null>(null);
  const [confirm, setConfirm] = useState<{
    kind: "restore" | "delete";
    id: string;
  } | null>(null);
  const [comparison, setComparison] = useState<{
    first: SandboxVersionDetail;
    second: SandboxVersionDetail;
  } | null>(null);
  const versionActionReturnFocus = useRef<HTMLElement | null>(null);
  const versionsHeading = useRef<HTMLHeadingElement | null>(null);
  const confirmVersion = confirm
    ? versions.find((version) => version.id === confirm.id)
    : undefined;

  async function apply() {
    if (!confirm || pending) return;
    const action = confirm;
    const version = versions.find((candidate) => candidate.id === action.id);
    if (!version) {
      notify("This version is no longer available.");
      return;
    }
    if (action.kind === "delete") {
      const result = await deleteVersion(action.id);
      if (!result.ok) {
        notify(result.error);
        return;
      }
      notify(`${version.label} deleted from shared history.`);
    } else {
      const result = await restoreVersion(action.id);
      if (!result.ok) {
        notify(result.error);
        return;
      }
      notify(
        `Draft restored from ${version.label}. Shared history added a recovery checkpoint.`,
      );
    }
    const deleted = action.kind === "delete";
    setConfirm(null);
    requestAnimationFrame(() => {
      const returnTarget = versionActionReturnFocus.current;
      if (!deleted && returnTarget?.isConnected) returnTarget.focus();
      else versionsHeading.current?.focus();
    });
  }

  function closeVersionConfirm() {
    if (pending) return;
    setConfirm(null);
    requestAnimationFrame(() => {
      const returnTarget = versionActionReturnFocus.current;
      if (returnTarget?.isConnected) returnTarget.focus();
      else versionsHeading.current?.focus();
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap justify-between gap-4">
        <div>
          <h2
            ref={versionsHeading}
            tabIndex={-1}
            className="text-xl font-semibold"
          >
            History
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Keep checkpoints, compare designs, and restore with confidence.
          </p>
        </div>
      </div>

      {versions.length ? (
        <Card>
          <CardContent className="flex flex-wrap items-end gap-3">
            <VersionChoice
              label="Compare first version"
              value={compareA}
              versions={versions}
              onChange={setCompareA}
            />
            <VersionChoice
              label="Compare second version"
              value={compareB}
              versions={versions}
              onChange={setCompareB}
            />
            <Button
              variant="outline"
              disabled={pending || !compareA || !compareB}
              onClick={async () => {
                const [first, second] = await Promise.all([
                  getVersion(compareA),
                  getVersion(compareB),
                ]);
                if (!first.ok) {
                  notify(first.error);
                  return;
                }
                if (!second.ok) {
                  notify(second.error);
                  return;
                }
                setComparison({ first: first.value, second: second.value });
                setComparing(true);
              }}
            >
              Compare versions
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {comparing ? (
        <Card aria-label="Version comparison">
          {comparison ? (
            <>
              <CardHeader>
                <h3 className="font-semibold">
                  {comparison.first.label} → {comparison.second.label}
                </h3>
              </CardHeader>
              <CardContent>
                <div className="text-muted-foreground mt-3 grid gap-2 text-sm md:grid-cols-2">
                  <p>
                    <strong className="text-foreground">Before:</strong>{" "}
                    {counts(projectSandboxDocument(comparison.first.document))}
                  </p>
                  <p>
                    <strong className="text-foreground">After:</strong>{" "}
                    {counts(projectSandboxDocument(comparison.second.document))}
                  </p>
                </div>
                <ul className="mt-4 flex list-inside list-disc flex-col gap-1 text-sm">
                  {canonicalVersionChanges(
                    comparison.first.document,
                    comparison.second.document,
                  ).map((change) => (
                    <li key={change}>{change}</li>
                  ))}
                </ul>
              </CardContent>
            </>
          ) : (
            <CardContent>
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>Select two versions to compare.</EmptyTitle>
                </EmptyHeader>
              </Empty>
            </CardContent>
          )}
        </Card>
      ) : null}

      <Card>
        <CardContent className="divide-border divide-y p-0">
          {versions.length ? (
            [...versions].reverse().map((version) => (
              <article
                key={version.id}
                aria-label={version.label}
                className="flex flex-wrap justify-between gap-4 p-5"
              >
                <div className="min-w-0">
                  <p className="text-muted-foreground text-xs font-medium uppercase">
                    {version.kind === "published" ? "Published" : "Checkpoint"}
                  </p>
                  {checkpointLabelEdit?.id === version.id ? (
                    <form
                      aria-label={`Edit checkpoint label ${version.label}`}
                      className="mt-2 flex flex-col gap-2"
                      onSubmit={async (event) => {
                        event.preventDefault();
                        if (pending || !checkpointLabelEdit) return;
                        const label = checkpointLabelEdit.value.trim();
                        if (!label) {
                          setCheckpointLabelEdit({
                            ...checkpointLabelEdit,
                            error: "Checkpoint label is required",
                          });
                          return;
                        }
                        if (checkpointLabelEdit.value.length > 80) {
                          setCheckpointLabelEdit({
                            ...checkpointLabelEdit,
                            error:
                              "Checkpoint label must be 80 characters or fewer",
                          });
                          return;
                        }
                        const result = await updateVersion(version.id, label);
                        if (!result.ok) {
                          setCheckpointLabelEdit({
                            ...checkpointLabelEdit,
                            error: result.error,
                          });
                          return;
                        }
                        setCheckpointLabelEdit(null);
                        notify("Checkpoint label updated in shared history.");
                      }}
                    >
                      <LabeledField label="Checkpoint label">
                        {(controlId) => (
                          <Input
                            id={controlId}
                            autoFocus
                            required
                            maxLength={80}
                            value={checkpointLabelEdit.value}
                            onChange={(event) =>
                              setCheckpointLabelEdit({
                                ...checkpointLabelEdit,
                                value: event.target.value,
                                error: "",
                              })
                            }
                          />
                        )}
                      </LabeledField>
                      {checkpointLabelEdit.error ? (
                        <Alert variant="destructive" role="alert">
                          {checkpointLabelEdit.error}
                        </Alert>
                      ) : null}
                      <div className="flex gap-2">
                        <Button size="sm" type="submit" disabled={pending}>
                          Save label
                        </Button>
                        <Button
                          size="sm"
                          type="button"
                          variant="ghost"
                          disabled={pending}
                          onClick={() => setCheckpointLabelEdit(null)}
                        >
                          Cancel label edit
                        </Button>
                      </div>
                    </form>
                  ) : (
                    <h3 className="mt-1 font-semibold">{version.label}</h3>
                  )}
                  <p className="text-muted-foreground mt-2 text-xs">
                    {version.createdAt} · {version.byteCount} bytes
                  </p>
                  <p className="mt-2 text-sm">
                    {version.note || "No version note provided."}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {version.kind === "checkpoint" &&
                  checkpointLabelEdit?.id !== version.id ? (
                    <Button
                      variant="outline"
                      disabled={pending}
                      onClick={() =>
                        setCheckpointLabelEdit({
                          id: version.id,
                          value: version.label,
                          error: "",
                        })
                      }
                    >
                      Edit checkpoint label
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={(event) => {
                      versionActionReturnFocus.current = event.currentTarget;
                      setConfirm({ kind: "restore", id: version.id });
                    }}
                  >
                    Restore version
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={
                      pending ||
                      version.kind === "published" ||
                      versions.length === 1
                    }
                    onClick={(event) => {
                      versionActionReturnFocus.current = event.currentTarget;
                      setConfirm({ kind: "delete", id: version.id });
                    }}
                  >
                    Delete version
                  </Button>
                </div>
              </article>
            ))
          ) : (
            <Empty className="border-0 py-10">
              <EmptyHeader>
                <EmptyTitle>No versions yet</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}
        </CardContent>
      </Card>

      <AlertDialog
        open={Boolean(confirm && confirmVersion)}
        onOpenChange={(open) => !open && !pending && closeVersionConfirm()}
      >
        {confirm && confirmVersion ? (
          <AlertDialogContent
            finalFocus={() => {
              const returnTarget = versionActionReturnFocus.current;
              return returnTarget?.isConnected
                ? returnTarget
                : versionsHeading.current;
            }}
            className="max-xl:[&_button]:min-h-11 max-xl:[&_button]:min-w-11 max-xl:[&_input:not([type=checkbox]):not([type=radio])]:min-h-11 max-xl:[&_select]:min-h-11"
          >
            <AlertDialogHeader>
              <AlertDialogTitle>
                {confirm.kind === "delete"
                  ? `Delete ${confirmVersion.label}?`
                  : `Restore ${confirmVersion.label}?`}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {confirm.kind === "delete"
                  ? `Delete ${confirmVersion.label} from shared history?`
                  : `Restore the draft from ${confirmVersion.label}? Shared history will add a recovery checkpoint.`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button
                variant="outline"
                disabled={pending}
                onClick={closeVersionConfirm}
              >
                Cancel {confirm.kind === "delete" ? "deletion" : "restore"}
              </Button>
              <Button
                variant={confirm.kind === "delete" ? "destructive" : "default"}
                disabled={pending}
                onClick={() => void apply()}
              >
                {confirm.kind === "delete"
                  ? `Delete ${confirmVersion.label}`
                  : `Restore ${confirmVersion.label}`}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
    </div>
  );
}
