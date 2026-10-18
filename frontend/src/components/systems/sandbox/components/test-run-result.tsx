"use client";

import { useState, type ReactNode } from "react";
import {
  ArrowDown,
  Check,
  ChevronDown,
  FileInput,
  GitBranch,
  ListChecks,
  Waypoints,
} from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import type { SandboxDocumentDesign } from "../domain/document";
import type { SandboxTestRun } from "../state/api";
import {
  comparisonRows,
  describeTrigger,
  displayValue,
  eventDescription,
  fieldName,
  moduleName,
  type TestRunSummary,
} from "../domain/test-run-summary";
import type { SandboxTrigger, SandboxTriggerEvent } from "../domain/document";

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
    <div
      data-slot="card"
      className="bg-card border-card-edge shadow-card rounded-xl border p-4"
    >
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

/** Why a trigger did not run, with a way to test the event that runs it. */
function NotTriggeredReason({
  trigger: recordTrigger,
  design,
  testedModuleId,
  pending,
  onTryTrigger,
}: {
  trigger: SandboxTrigger | undefined;
  design: SandboxDocumentDesign;
  testedModuleId: string;
  pending: boolean;
  onTryTrigger: (trigger: SandboxTriggerEvent) => void;
}) {
  if (!recordTrigger) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-muted-foreground">
        {describeTrigger(recordTrigger.trigger, design, testedModuleId)}
      </span>
      <Button
        variant="outline"
        size="sm"
        className="min-h-9"
        disabled={pending}
        aria-label={`Test ${recordTrigger.name} instead`}
        onClick={() => onTryTrigger(recordTrigger.trigger)}
      >
        Test this instead
      </Button>
    </div>
  );
}

type OutcomeProps = {
  design: SandboxDocumentDesign;
  run: SandboxTestRun | undefined;
  summary: TestRunSummary | null;
  currentModuleId: string;
  pending: boolean;
  onShowField: (id: string) => void;
  onRunAgain: (run: SandboxTestRun) => void;
  onShowOnCanvas: (run: SandboxTestRun) => void;
  triggers: readonly SandboxTrigger[];
  /** Set up the next test with this trigger's trigger. */
  onTryTrigger: (trigger: SandboxTriggerEvent) => void;
  /** The setup changed after this result was shown. */
  inputsChanged?: boolean;
  /** Runs the test with the current setup. */
  onRunCurrent?: () => void;
};

/** The id of the result heading, which takes focus after a run on phones. */
export const TEST_RESULT_HEADING_ID = "sandbox-test-result-heading";
export function TestOutcome({
  design,
  run,
  summary,
  currentModuleId,
  pending,
  onShowField,
  onRunAgain,
  onShowOnCanvas,
  triggers,
  onTryTrigger,
  inputsChanged = false,
  onRunCurrent,
}: OutcomeProps) {
  if (!run)
    return (
      <section aria-label="Test outcome" className="min-w-0">
        <h3 data-slot="section-title" className="font-semibold">
          Test outcome
        </h3>
        <div className="border-border mt-5 rounded-xl border border-dashed px-5 py-10">
          <ListChecks
            className="text-muted-foreground mb-4 size-6"
            aria-hidden="true"
          />
          <p className="text-sm">
            Run a test to see the expected outcome here.
          </p>
        </div>
      </section>
    );
  const rows = comparisonRows(run);
  const changed = rows.filter((row) => row.changed);
  const missing = rows.filter((row) => row.after === undefined).length;
  const stale = summary?.stale ?? null;
  const issues = summary?.issues ?? [];
  return (
    <section aria-label="Test outcome" className="min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3
            id={TEST_RESULT_HEADING_ID}
            tabIndex={-1}
            data-slot="section-title"
            className="font-semibold outline-none"
          >
            Test result
          </h3>
          <p className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <time dateTime={run.createdAt}>
              {new Date(run.createdAt).toLocaleString()}
            </time>
            <Badge variant="outline">Test only · live data unchanged</Badge>
          </p>
        </div>
        {stale !== "module-gone" && (
          <Button
            variant="outline"
            size="sm"
            className="min-h-9"
            onClick={() => onShowOnCanvas(run)}
          >
            <Waypoints aria-hidden="true" />
            Show test on canvas
          </Button>
        )}
      </div>
      {stale === "module-gone" ? (
        <Alert className="mt-4">
          Module removed. Choose another module to test.
        </Alert>
      ) : inputsChanged || stale === "older-draft" ? (
        // One stale bar (copy cut 15): the result no longer matches what
        // the user sees, and Run again is the way back.
        <div
          role="status"
          className="bg-warn-tint text-warn-text mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm font-medium"
        >
          <span>{inputsChanged ? "Inputs changed" : "Draft changed"}</span>
          <Button
            size="sm"
            variant="outline"
            className="max-xl:min-h-11"
            pending={pending}
            pendingLabel="Running…"
            onClick={() =>
              inputsChanged && onRunCurrent ? onRunCurrent() : onRunAgain(run)
            }
          >
            Run again
          </Button>
        </div>
      ) : null}
      <p className="mt-4 text-lg font-semibold">
        {run.result.issues.length
          ? stale
            ? "Issues from this earlier test"
            : "This test needs attention"
          : changed.length
            ? `${changed.length} field${changed.length === 1 ? "" : "s"} changed in this test`
            : "No field changes in this test"}
      </p>
      {run.result.issues.length > 0 && (
        <Alert variant="warning" className="mt-4">
          <p className="mb-2 font-medium">
            {stale
              ? "These were found in the earlier test. The current draft may differ."
              : "Review these issues before relying on the result."}
          </p>
          <ul className="space-y-3">
            {issues.map((issue) => {
              const field =
                issue.subject?.kind === "field" &&
                currentModuleId === run.input.moduleId
                  ? issue.subject
                  : null;
              return (
                <li key={issue.key} className="text-sm">
                  <p>
                    {issue.subject && (
                      <span className="font-medium">
                        {issue.subject.name}:{" "}
                      </span>
                    )}
                    {issue.message}
                    {issue.count > 1 && (
                      <span className="text-muted-foreground">
                        {" "}
                        ({issue.count} times)
                      </span>
                    )}
                  </p>
                  {field && (
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
        <Stage title="Trigger outcomes" icon={<GitBranch />}>
          {run.result.triggerTraces.length ? (
            <ol className="divide-border divide-y">
              {run.result.triggerTraces.map((trace, index) => (
                <li
                  key={`${trace.triggerId}-${index}`}
                  className="py-2 first:pt-0 last:pb-0"
                >
                  <p className="font-medium">{trace.label}</p>
                  <p className="text-muted-foreground mt-1">
                    {trace.outcome === "Applied"
                      ? "Applied in test"
                      : trace.outcome}
                  </p>
                  {trace.outcome === "Not triggered" ? (
                    <NotTriggeredReason
                      trigger={triggers.find(
                        (item) => item.id === trace.triggerId,
                      )}
                      design={design}
                      testedModuleId={run.input.moduleId}
                      pending={pending}
                      onTryTrigger={onTryTrigger}
                    />
                  ) : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-muted-foreground">
              No triggers ran in this test.
            </p>
          )}
        </Stage>
        <Connector />
        <Stage title="Result" icon={<Check />}>
          <p>
            {changed.length} field
            {changed.length === 1 ? " value is" : " values are"} different after
            the test.
          </p>
          {changed.slice(0, 3).map((row) => (
            <p key={row.id}>
              <span className="font-medium">
                {fieldName(design, run.input.moduleId, row.id)}:{" "}
              </span>
              {displayValue(row.before, "Not provided")} →{" "}
              {displayValue(row.after, "No value")}
            </p>
          ))}
          {changed.length > 3 && (
            <p className="text-muted-foreground">
              {changed.length - 3} more changes in Field comparison.
            </p>
          )}
          {missing > 0 && (
            <p className="text-warning">
              {missing} field{missing === 1 ? " has" : "s have"} no value after
              the test. Review all result fields.
            </p>
          )}
        </Stage>
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
      <h3 data-slot="section-title" className="font-semibold">
        Field comparison
      </h3>
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
            variant="segmented"
            className="mt-5"
          >
            <ToggleGroupItem value="changed">
              Changed ({changed.length})
            </ToggleGroupItem>
            <ToggleGroupItem value="all">
              All fields ({rows.length})
            </ToggleGroupItem>
          </ToggleGroup>
          {visible.length ? (
            <Table className="mt-4 table-fixed text-left [overflow-wrap:anywhere]">
              <TableCaption className="sr-only mt-0">
                Saved test input and values after the test
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
                      {displayValue(row.after, "No value")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-muted-foreground my-6 text-sm">
              {showAll
                ? "No field values to compare."
                : "No field values changed."}
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
            {missing ? ` · ${missing} with no value after the test` : ""}
          </p>
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
            Field names reflect the current setup.
          </p>
        </>
      )}
    </section>
  );
}
