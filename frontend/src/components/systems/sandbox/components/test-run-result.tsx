"use client";

import { useState, type ReactNode } from "react";
import {
  ArrowDown,
  Check,
  ChevronDown,
  FileInput,
  GitBranch,
  ListChecks,
} from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type {
  SandboxDocumentDesign,
  SandboxFieldValue,
} from "../domain/document";
import type { SandboxTestEvent, SandboxTestRun } from "../state/api";

function fieldName(
  design: SandboxDocumentDesign,
  moduleId: string,
  fieldId: string,
) {
  return (
    design.modules
      .find((item) => item.id === moduleId)
      ?.fields.find((field) => field.id === fieldId)?.name ??
    "Unavailable field"
  );
}
function moduleName(design: SandboxDocumentDesign, moduleId: string) {
  return (
    design.modules.find((item) => item.id === moduleId)?.name ??
    "Unavailable module"
  );
}
function displayValue(
  value: SandboxFieldValue | undefined,
  missing: string,
): string {
  if (value === undefined) return missing;
  if (value === null) return "No value";
  if (value === true) return "Yes";
  if (value === false) return "No";
  if (value === "") return "Empty text";
  return String(value);
}
function comparisonRows(run: SandboxTestRun) {
  return Array.from(
    new Set([
      ...Object.keys(run.input.values),
      ...Object.keys(run.result.values),
    ]),
  ).map((id) => {
    const before = run.input.values[id];
    const after = run.result.values[id];
    return {
      id,
      before,
      after,
      changed: after !== undefined && !Object.is(before, after),
    };
  });
}
function eventDescription(
  design: SandboxDocumentDesign,
  run: SandboxTestRun,
): string {
  const event: SandboxTestEvent = run.event;
  if (event.kind === "record-created") return "An item is added";
  if (event.kind === "field-changed")
    return `${fieldName(design, run.input.moduleId, event.fieldId)} changes`;
  if (event.kind === "threshold-crossed")
    return `${fieldName(design, run.input.moduleId, event.fieldId)} crosses a threshold from ${displayValue(event.previousValue, "Not provided")}`;
  const days = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ];
  return event.frequency === "daily"
    ? `Daily schedule at ${event.time}`
    : `Weekly schedule: ${days[(event.weekday ?? 0) - 1] ?? "day not specified"}, ${event.time}`;
}
function Stage({
  title,
  icon,
  children,
}: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="bg-card border-border rounded-xl border p-4">
      <div className="text-muted-foreground mb-2 flex items-center gap-2 text-xs font-medium">
        <span aria-hidden="true" className="[&_svg]:size-4">
          {icon}
        </span>
        {title}
      </div>
      <div className="space-y-2 text-sm leading-relaxed [overflow-wrap:anywhere] break-words">
        {children}
      </div>
    </div>
  );
}
function Connector() {
  return (
    <ArrowDown
      aria-hidden="true"
      strokeWidth={1.25}
      className="text-muted-foreground mx-auto h-10 w-5"
    />
  );
}

type OutcomeProps = {
  design: SandboxDocumentDesign;
  run: SandboxTestRun | undefined;
  currentModuleId: string;
  onShowField: (id: string) => void;
};
export function TestOutcome({
  design,
  run,
  currentModuleId,
  onShowField,
}: OutcomeProps) {
  if (!run)
    return (
      <section aria-label="Test outcome" className="min-w-0">
        <h3 className="font-semibold">Test outcome</h3>
        <div className="border-border mt-5 rounded-xl border border-dashed px-5 py-10">
          <ListChecks
            className="text-muted-foreground mb-4 size-6"
            aria-hidden="true"
          />
          <p className="text-sm">
            Run a test to see the expected outcome here.
          </p>
          <p className="text-muted-foreground mt-2 text-sm">
            Choose an event and enter temporary values. Your live workspace
            stays unchanged.
          </p>
        </div>
      </section>
    );
  const rows = comparisonRows(run);
  const changed = rows.filter((row) => row.changed);
  const missing = rows.filter((row) => row.after === undefined).length;
  return (
    <section aria-label="Test outcome" className="min-w-0">
      <h3 className="font-semibold">Test result</h3>
      <p className="text-muted-foreground mt-1 text-xs">
        Draft revision {run.documentRevision} ·{" "}
        <time dateTime={run.createdAt}>
          {new Date(run.createdAt).toLocaleString()}
        </time>
      </p>
      <p className="mt-4 text-lg font-semibold">
        {run.result.issues.length
          ? "This test needs attention"
          : changed.length
            ? `${changed.length} field${changed.length === 1 ? "" : "s"} changed in this test`
            : "No field changes in this test"}
      </p>
      {run.result.issues.length > 0 && (
        <Alert variant="warning" className="mt-4">
          <p className="mb-2 font-medium">
            Review these issues before relying on the result.
          </p>
          <ul className="space-y-3">
            {run.result.issues.map((issue, index) => {
              const field = design.modules
                .find((item) => item.id === currentModuleId)
                ?.fields.find(
                  (item) => item.id === issue.targetId && !item.closed,
                );
              return (
                <li key={`${issue.code}-${index}`} className="text-sm">
                  <p>{issue.message}</p>
                  {field && currentModuleId === run.input.moduleId && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-1 min-h-9 whitespace-normal"
                      onClick={() => onShowField(field.id)}
                    >
                      Show {field.name} input
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </Alert>
      )}
      <div className="mx-auto my-6 w-full max-w-md">
        <Stage title="Input" icon={<FileInput />}>
          <p className="font-medium">
            {moduleName(design, run.input.moduleId)}
          </p>
          <p>{eventDescription(design, run)}</p>
          <p className="text-muted-foreground text-xs">
            Using the temporary values saved with this test.
          </p>
        </Stage>
        <Connector />
        <Stage title="Automation outcomes" icon={<GitBranch />}>
          {run.result.automationTraces.length ? (
            <ol className="divide-border divide-y">
              {run.result.automationTraces.map((trace, index) => (
                <li
                  key={`${trace.automationId}-${index}`}
                  className="py-2 first:pt-0 last:pb-0"
                >
                  <p className="font-medium">{trace.label}</p>
                  <p className="text-muted-foreground mt-1">
                    {trace.outcome === "Applied"
                      ? "Applied in test"
                      : trace.outcome}
                  </p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-muted-foreground">
              No automation outcomes were returned.
            </p>
          )}
        </Stage>
        <Connector />
        <Stage title="Result" icon={<Check />}>
          <p>
            {changed.length} returned field
            {changed.length === 1 ? " value differs" : " values differ"} from
            the input.
          </p>
          {changed.slice(0, 3).map((row) => (
            <p key={row.id}>
              <span className="font-medium">
                {fieldName(design, run.input.moduleId, row.id)}:{" "}
              </span>
              {displayValue(row.before, "Not provided")} →{" "}
              {displayValue(row.after, "Not returned")}
            </p>
          ))}
          {changed.length > 3 && (
            <p className="text-muted-foreground">
              {changed.length - 3} more changes in Field comparison.
            </p>
          )}
          {missing > 0 && (
            <p className="text-warning">
              {missing} input field{missing === 1 ? " has" : "s have"} no
              returned value. Review all result fields.
            </p>
          )}
        </Stage>
      </div>
      <div className="border-border border-t pt-4">
        <h4 className="text-sm font-semibold">How to read this result</h4>
        <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
          Outcomes are reported by the test engine. Field comparison shows the
          final returned values, including any changes from subsequent
          automation steps.
        </p>
        <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
          Editing inputs does not change this result. Run the test again to
          evaluate new values.
        </p>
      </div>
      {run.result.routes.length > 0 && (
        <Collapsible className="group border-border mt-5 border-t pt-3">
          <CollapsibleTrigger
            render={
              <Button
                variant="ghost"
                className="h-auto min-h-11 w-full justify-between px-0 text-left text-sm font-medium hover:bg-transparent"
              />
            }
          >
            Relationship routing
            <ChevronDown
              aria-hidden="true"
              className="size-4 transition-transform group-data-open:rotate-180 motion-reduce:transition-none"
            />
          </CollapsibleTrigger>
          <CollapsibleContent keepMounted>
            <ul className="text-muted-foreground space-y-2 text-sm">
              {run.result.routes.map((route, index) => (
                <li key={index}>
                  <span className="font-medium">{route.label}</span>
                  {route.detail ? `: ${route.detail}` : ""}
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </section>
  );
}

export function TestComparison({
  design,
  run,
}: {
  design: SandboxDocumentDesign;
  run: SandboxTestRun | undefined;
}) {
  const [showAll, setShowAll] = useState(false);
  const [limit, setLimit] = useState(12);
  const rows = run ? comparisonRows(run) : [];
  const changed = rows.filter((row) => row.changed);
  const unchanged = rows.filter(
    (row) => row.after !== undefined && !row.changed,
  ).length;
  const missing = rows.filter((row) => row.after === undefined).length;
  const visible = showAll ? rows : changed;
  return (
    <section aria-label="Field comparison" className="min-w-0">
      <h3 className="font-semibold">Field comparison</h3>
      <p className="text-muted-foreground mt-2 text-sm">
        Compare the inputs used with the test result.
      </p>
      {!run ? (
        <p className="text-muted-foreground mt-8 text-sm">
          Your before and after values will appear here after a test.
        </p>
      ) : (
        <>
          <ToggleGroup
            aria-label="Result fields"
            multiple={false}
            value={[showAll ? "all" : "changed"]}
            onValueChange={(selection) => {
              const selected = selection[0];
              if (selected === "all") setShowAll(true);
              if (selected === "changed") setShowAll(false);
              setLimit(12);
            }}
            className="bg-muted mt-5 flex w-full flex-wrap gap-1 rounded-lg p-1"
          >
            <ToggleGroupItem
              value="changed"
              aria-label="Changed fields"
              className="aria-pressed:bg-secondary aria-pressed:text-secondary-foreground h-auto min-h-11 min-w-0 flex-1 px-2 text-xs whitespace-normal"
            >
              Changed ({changed.length})
            </ToggleGroupItem>
            <ToggleGroupItem
              value="all"
              aria-label="All result fields"
              className="aria-pressed:bg-secondary aria-pressed:text-secondary-foreground h-auto min-h-11 min-w-0 flex-1 px-2 text-xs whitespace-normal"
            >
              All fields ({rows.length})
            </ToggleGroupItem>
          </ToggleGroup>
          {visible.length ? (
            <Table className="mt-4 table-fixed text-left [overflow-wrap:anywhere]">
              <TableCaption className="sr-only mt-0">
                Saved test input and returned values
              </TableCaption>
              <TableHeader className="border-border text-muted-foreground border-b">
                <TableRow className="hover:bg-transparent">
                  <TableHead
                    scope="col"
                    className="h-auto w-[40%] px-0 py-3 pr-2 whitespace-normal"
                  >
                    Field
                  </TableHead>
                  <TableHead
                    scope="col"
                    className="h-auto w-[30%] px-1 py-3 whitespace-normal"
                  >
                    Before
                  </TableHead>
                  <TableHead
                    scope="col"
                    className="h-auto w-[30%] py-3 pr-0 pl-1 whitespace-normal"
                  >
                    After
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="[&_tr:last-child]:border-b">
                {visible.slice(0, limit).map((row) => (
                  <TableRow
                    key={row.id}
                    className={
                      row.changed
                        ? "bg-success/5 hover:bg-success/5"
                        : "hover:bg-transparent"
                    }
                  >
                    <TableHead
                      scope="row"
                      className="h-auto px-0 py-3 pr-2 align-top whitespace-normal"
                    >
                      {fieldName(design, run.input.moduleId, row.id)}
                      <span
                        className={`mt-1 block text-xs font-normal ${row.changed ? "text-success" : "text-muted-foreground"}`}
                      >
                        {row.after === undefined
                          ? "Not evaluated"
                          : row.changed
                            ? "Changed"
                            : "Unchanged"}
                      </span>
                    </TableHead>
                    <TableCell className="h-auto px-1 py-3 align-top whitespace-pre-wrap">
                      {displayValue(row.before, "Not provided")}
                    </TableCell>
                    <TableCell className="h-auto py-3 pr-0 pl-1 align-top whitespace-pre-wrap">
                      {displayValue(row.after, "Not returned")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-muted-foreground my-6 text-sm">
              {showAll
                ? "No field values were returned for comparison."
                : "No returned field changes."}
            </p>
          )}
          {visible.length > limit && (
            <Button
              variant="outline"
              className="mt-3 min-h-11 w-full"
              onClick={() => setLimit(limit + 12)}
            >
              Show more result fields
            </Button>
          )}
          <p className="text-muted-foreground mt-4 text-xs">
            {unchanged} field{unchanged === 1 ? "" : "s"} unchanged
            {missing ? ` · ${missing} not returned` : ""}
          </p>
          <div className="border-border mt-6 border-t pt-4">
            <p className="text-sm font-medium">Live workspace unchanged</p>
            <p className="text-muted-foreground mt-2 text-sm">
              These are temporary test values. No operational records were
              created or changed.
            </p>
          </div>
          <section
            aria-label="Inputs used for this result"
            className="border-border mt-6 border-t pt-4"
          >
            <Collapsible className="group">
              <CollapsibleTrigger
                render={
                  <Button
                    variant="ghost"
                    className="h-auto min-h-11 w-full justify-between px-0 text-left text-sm font-medium hover:bg-transparent"
                  />
                }
              >
                Inputs used for this result
                <ChevronDown
                  aria-hidden="true"
                  className="size-4 transition-transform group-data-open:rotate-180 motion-reduce:transition-none"
                />
              </CollapsibleTrigger>
              <CollapsibleContent keepMounted>
                <p className="text-muted-foreground mb-3 text-sm">
                  {moduleName(design, run.input.moduleId)} ·{" "}
                  {eventDescription(design, run)}
                </p>
                <dl className="max-h-72 space-y-3 overflow-y-auto text-sm [overflow-wrap:anywhere]">
                  {Object.entries(run.input.values).map(([id, value]) => (
                    <div key={id}>
                      <dt className="text-muted-foreground">
                        {fieldName(design, run.input.moduleId, id)}
                      </dt>
                      <dd className="mt-1 whitespace-pre-wrap">
                        {displayValue(value, "Not provided")}
                      </dd>
                    </div>
                  ))}
                </dl>
              </CollapsibleContent>
            </Collapsible>
          </section>
          <p className="text-muted-foreground mt-4 text-xs">
            Field names reflect the current setup. This result belongs to draft
            revision {run.documentRevision}.
          </p>
        </>
      )}
    </section>
  );
}
