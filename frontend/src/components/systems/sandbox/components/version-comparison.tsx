"use client";

import { useId, useState, type Ref } from "react";
import {
  ChevronDown,
  ChevronRight,
  GitCompareArrows,
  Minus,
  Plus,
  SlidersHorizontal,
} from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { cn } from "@/lib/utils";
import { projectSandboxDocument } from "../domain/document-bridge";
import type { SandboxVersion, SandboxVersionDetail } from "../state/api";

// Compare inside the version detail (docs/specs/sandbox-relayout.md S8):
// Older, then Newer, and Compare; the result is one row per area with its
// count from older to newer and added, removed, and changed tags. A row with
// changes opens its entries.

type Operation = "added" | "removed" | "changed";

const areas = [
  { prefix: "Department", label: "Departments" },
  { prefix: "Module", label: "Modules" },
  { prefix: "Field", label: "Fields" },
  { prefix: "Relationship", label: "Relationships" },
  { prefix: "Trigger", label: "Triggers" },
  { prefix: "Scenario", label: "Scenarios" },
] as const;

type Area = (typeof areas)[number]["label"] | "Other changes";

function areaCounts(
  version: SandboxVersionDetail,
): Record<Area, number | null> {
  const design = projectSandboxDocument(version.document);
  return {
    Departments: design.departments.length,
    Modules: design.modules.length,
    Fields: design.modules.reduce(
      (total, item) => total + item.fields.length,
      0,
    ),
    Relationships: design.relationships.length,
    Triggers: design.rules.length,
    Scenarios: version.document.scenarios.length,
    "Other changes": null,
  };
}

function operationOf(change: string): Operation {
  const operation = change.match(/^[A-Za-z]+ (added|removed):/)?.[1];
  return operation === "added" || operation === "removed"
    ? operation
    : "changed";
}

function versionName(version: SandboxVersion): string {
  return `v${version.sequence} · ${version.label}`;
}

function VersionChoice({
  label,
  value,
  versions,
  onChange,
}: {
  label: "Older" | "Newer";
  value: string;
  versions: readonly SandboxVersion[];
  onChange: (value: string) => void;
}) {
  const controlId = useId();
  return (
    <Field className="min-w-0 gap-1.5">
      <FieldLabel htmlFor={controlId} className="text-xs">
        {label}
      </FieldLabel>
      <NativeSelect
        id={controlId}
        className="w-full [&_select]:min-h-11 xl:[&_select]:min-h-8"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {versions.map((version) => (
          <NativeSelectOption key={version.id} value={version.id}>
            {versionName(version)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </Field>
  );
}

export function VersionCompare({
  headingRef,
  versions,
  older,
  newer,
  onOlderChange,
  onNewerChange,
  onCompare,
  disabled,
  comparing,
  error,
  result,
  hint,
}: {
  headingRef: Ref<HTMLHeadingElement>;
  /** Every version the page knows, newest first. */
  versions: readonly SandboxVersion[];
  older: string;
  newer: string;
  onOlderChange: (id: string) => void;
  onNewerChange: (id: string) => void;
  onCompare: () => void;
  disabled: boolean;
  comparing: boolean;
  error: string;
  /** The compared pair while it matches the selects. */
  result: {
    older: SandboxVersionDetail;
    newer: SandboxVersionDetail;
    changes: readonly string[];
  } | null;
  hint: string;
}) {
  return (
    <section
      aria-label="Version comparison"
      className="border-border grid min-w-0 gap-3 border-t pt-5"
    >
      <h3
        ref={headingRef}
        tabIndex={-1}
        data-slot="section-title"
        className="font-semibold outline-none"
      >
        Compare
      </h3>
      {versions.length ? (
        <div className="grid min-w-0 gap-3 @min-[34rem]/detail:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] @min-[34rem]/detail:items-end">
          <VersionChoice
            label="Older"
            value={older}
            versions={versions}
            onChange={onOlderChange}
          />
          <ChevronRight
            aria-hidden="true"
            className="text-muted-foreground hidden size-4 xl:mb-2 @min-[34rem]/detail:mb-2.5 @min-[34rem]/detail:block"
          />
          <VersionChoice
            label="Newer"
            value={newer}
            versions={versions}
            onChange={onNewerChange}
          />
          <Button
            variant="ghost"
            className="min-h-11 justify-self-start xl:min-h-8"
            disabled={disabled || !older || !newer}
            pending={comparing}
            pendingLabel="Comparing…"
            onClick={onCompare}
          >
            <GitCompareArrows aria-hidden="true" />
            Compare<span className="sr-only"> versions</span>
          </Button>
        </div>
      ) : null}
      {error ? <Alert variant="destructive">{error}</Alert> : null}
      {result ? (
        <VersionChangeTable {...result} />
      ) : (
        <p className="text-muted-foreground text-sm">{hint}</p>
      )}
    </section>
  );
}

function VersionChangeTable({
  older,
  newer,
  changes,
}: {
  older: SandboxVersionDetail;
  newer: SandboxVersionDetail;
  changes: readonly string[];
}) {
  const before = areaCounts(older);
  const after = areaCounts(newer);
  const rows = [
    ...areas.map((area) => ({
      label: area.label as Area,
      entries: changes.filter((change) => change.startsWith(area.prefix + " ")),
    })),
    {
      label: "Other changes" as Area,
      entries: changes.filter(
        (change) => !areas.some((area) => change.startsWith(area.prefix + " ")),
      ),
    },
  ].filter(
    // The five structure areas always show; Scenarios and Other only with
    // changes.
    (row, index) => index < 5 || row.entries.length > 0,
  );
  return (
    <div className="border-border overflow-hidden rounded-lg border">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">
          Changes from {versionName(older)} to {versionName(newer)}
        </caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">Area</th>
            <th scope="col">Count, older to newer</th>
            <th scope="col">Changes</th>
          </tr>
        </thead>
        {rows.map((row) => (
          <ChangeRow
            key={`${older.id}-${newer.id}-${row.label}`}
            label={row.label}
            before={before[row.label]}
            after={after[row.label]}
            entries={row.entries}
          />
        ))}
      </table>
    </div>
  );
}

function ChangeRow({
  label,
  before,
  after,
  entries,
}: {
  label: Area;
  before: number | null;
  after: number | null;
  entries: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  const entriesId = useId();
  const tally: Record<Operation, number> = { added: 0, removed: 0, changed: 0 };
  for (const entry of entries) tally[operationOf(entry)] += 1;
  return (
    <tbody className="border-border border-t first:border-t-0">
      <tr className="align-middle">
        <th scope="row" className="w-2/5 py-0 pr-2 pl-1 font-normal">
          {entries.length ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={entriesId}
              aria-label={`${label}, ${entries.length} change ${entries.length === 1 ? "entry" : "entries"}`}
              className="hover:bg-muted focus-visible:outline-ring flex min-h-11 w-full cursor-pointer items-center gap-1.5 rounded-md px-2 text-left font-medium outline-offset-2 focus-visible:outline-2 xl:min-h-9"
              onClick={() => setOpen((value) => !value)}
            >
              {open ? (
                <ChevronDown
                  aria-hidden="true"
                  className="text-muted-foreground size-3.5 shrink-0"
                />
              ) : (
                <ChevronRight
                  aria-hidden="true"
                  className="text-muted-foreground size-3.5 shrink-0"
                />
              )}
              <span className="min-w-0">{label}</span>
            </button>
          ) : (
            <span className="text-muted-foreground flex min-h-11 items-center pl-7 xl:min-h-9">
              {label}
            </span>
          )}
        </th>
        <td className="w-full px-2 whitespace-nowrap tabular-nums">
          {before === null || after === null ? null : (
            <>
              {before} <span aria-hidden="true">→</span>
              <span className="sr-only">to</span> {after}
            </>
          )}
        </td>
        <td className="px-3 py-1.5 text-right whitespace-nowrap">
          {entries.length ? (
            <span className="inline-flex flex-wrap justify-end gap-1">
              {tally.added ? (
                <Badge variant="success">{tally.added} added</Badge>
              ) : null}
              {tally.removed ? (
                <Badge variant="destructive">{tally.removed} removed</Badge>
              ) : null}
              {tally.changed ? (
                <Badge variant="outline">{tally.changed} changed</Badge>
              ) : null}
            </span>
          ) : (
            <span className="text-muted-foreground">No change</span>
          )}
        </td>
      </tr>
      {entries.length ? (
        <tr id={entriesId} hidden={!open}>
          <td
            colSpan={3}
            className="bg-muted/30 border-border border-t px-4 py-3"
          >
            <ul className="grid gap-2">
              {entries.map((change, index) => {
                const operation = operationOf(change);
                const Mark =
                  operation === "added"
                    ? Plus
                    : operation === "removed"
                      ? Minus
                      : SlidersHorizontal;
                return (
                  <li
                    key={`${change}-${index}`}
                    className="flex items-start gap-2.5 text-sm leading-relaxed [overflow-wrap:anywhere]"
                  >
                    <Mark
                      aria-hidden="true"
                      className={cn(
                        "mt-1 size-3.5 shrink-0",
                        operation === "added"
                          ? "text-success"
                          : operation === "removed"
                            ? "text-destructive"
                            : "text-muted-foreground",
                      )}
                    />
                    <span className="min-w-0">{change}</span>
                  </li>
                );
              })}
            </ul>
          </td>
        </tr>
      ) : null}
    </tbody>
  );
}
