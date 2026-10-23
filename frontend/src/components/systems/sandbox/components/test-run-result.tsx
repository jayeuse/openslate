"use client";

import { useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  FileInput,
  GitBranch,
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
import { cn } from "@/lib/utils";
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

// The Result pane of Test (docs/specs/sandbox-relayout.md S11, F15). It
// shows only a run made with the current setup. Each fact has one place: the
// headline gives the outcome, the steps say what ran, and Field comparison
// gives each value before and after. Inputs used and relationship routing
// wait closed, last.

/** The id of the result heading, which a run on a phone scrolls to. */
export const TEST_RESULT_HEADING_ID = "sandbox-test-result-heading";
/** The id of the outcome headline, which takes focus after that run. */
export const TEST_OUTCOME_HEADLINE_ID = "sandbox-test-outcome-headline";

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
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="text-muted-foreground">
        {describeTrigger(recordTrigger.trigger, design, testedModuleId)}
      </span>
      <Button
        variant="outline"
        size="sm"
        className="min-h-11 xl:min-h-8"
        disabled={pending}
        aria-label={`Test this instead: ${recordTrigger.name}`}
        onClick={() => onTryTrigger(recordTrigger.trigger)}
      >
        Test this instead
      </Button>
    </div>
  );
}

/** One step of the result rail: its icon, its name, and one line. */
function Step({
  name,
  line,
  icon,
  last = false,
  children,
}: {
  name: string;
  line: string;
  icon: ReactNode;
  last?: boolean;
  children?: ReactNode;
}) {
  return (
    <li className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3">
      <span aria-hidden="true" className="relative flex justify-center">
        <span className="text-muted-foreground z-[1] grid size-7 place-items-center rounded-full bg-[var(--surface-sunken)] [&_svg]:size-4">
          {icon}
        </span>
        {last ? null : (
          <span className="absolute top-[1.875rem] -bottom-0.5 w-px bg-[var(--rule-strong)]" />
        )}
      </span>
      <div className={cn("grid min-w-0 gap-1.5 text-sm", !last && "pb-3")}>
        <p className="flex min-h-7 min-w-0 items-baseline gap-2.5">
          <span className="shrink-0 font-semibold">{name}</span>
          <span
            title={line}
            className="text-muted-foreground min-w-0 truncate @max-[30rem]/result:whitespace-normal"
          >
            {line}
          </span>
        </p>
        {children}
      </div>
    </li>
  );
}

/** "Status", "Status and Priority", "Status, Priority, and 2 more". */
function namesLine(names: readonly string[]): string {
  if (names.length <= 2) return names.join(" and ");
  if (names.length === 3) return `${names[0]}, ${names[1]}, and ${names[2]}`;
  return `${names[0]}, ${names[1]}, and ${names.length - 2} more`;
}

/** Counts of each trace outcome, in the order they first appear. */
function outcomesLine(run: SandboxTestRun): string {
  const counts = new Map<string, number>();
  for (const trace of run.result.triggerTraces)
    counts.set(trace.outcome, (counts.get(trace.outcome) ?? 0) + 1);
  if (counts.size === 0) return "No triggers ran.";
  return [...counts]
    .map(([outcome, count]) => `${count} ${outcome.toLocaleLowerCase()}`)
    .join(" · ");
}

type ResultProps = {
  design: SandboxDocumentDesign;
  /** The run made with the current setup, if any. */
  run: SandboxTestRun | undefined;
  summary: TestRunSummary | null;
  /** A run is in flight. */
  running: boolean;
  pending: boolean;
  onShowField: (id: string) => void;
  onRunAgain: (run: SandboxTestRun) => void;
  onShowOnCanvas: (run: SandboxTestRun) => void;
  triggers: readonly SandboxTrigger[];
  /** Set up the next test with this trigger's event. */
  onTryTrigger: (trigger: SandboxTriggerEvent) => void;
  /** The setup changed after this result was shown. */
  inputsChanged: boolean;
  /** Runs the test with the current setup. */
  onRunCurrent: () => void;
};

export function TestResult({
  design,
  run,
  summary,
  running,
  pending,
  onShowField,
  onRunAgain,
  onShowOnCanvas,
  triggers,
  onTryTrigger,
  inputsChanged,
  onRunCurrent,
}: ResultProps) {
  return (
    <section
      aria-label="Test outcome"
      className="@container/result flex min-w-0 flex-col @min-[900px]/test:h-full @min-[900px]/test:min-h-0"
    >
      <div className="border-border flex min-h-14 flex-wrap items-center gap-x-2.5 gap-y-1 border-b px-5 py-2">
        <h3
          id={TEST_RESULT_HEADING_ID}
          tabIndex={-1}
          aria-label="Test result"
          data-slot="section-title"
          className="font-semibold outline-none"
        >
          Result
        </h3>
        {run ? (
          <Button
            variant="ghost"
            className="ml-auto min-h-11 px-3 xl:min-h-8"
            onClick={() => onShowOnCanvas(run)}
          >
            <Waypoints aria-hidden="true" />
            Show test on canvas
          </Button>
        ) : null}
      </div>
      <div className="grid min-w-0 content-start gap-5 p-5 @min-[900px]/test:min-h-0 @min-[900px]/test:flex-1 @min-[900px]/test:overflow-y-auto">
        {running ? (
          <p role="status" className="text-muted-foreground text-sm">
            Running test…
          </p>
        ) : null}
        {run ? (
          <RunResult
            design={design}
            run={run}
            summary={summary}
            pending={pending}
            onShowField={onShowField}
            onRunAgain={onRunAgain}
            triggers={triggers}
            onTryTrigger={onTryTrigger}
            inputsChanged={inputsChanged}
            onRunCurrent={onRunCurrent}
          />
        ) : running ? null : (
          <p className="text-muted-foreground text-sm">
            Run a test to see the result.
          </p>
        )}
      </div>
    </section>
  );
}

function RunResult({
  design,
  run,
  summary,
  pending,
  onShowField,
  onRunAgain,
  triggers,
  onTryTrigger,
  inputsChanged,
  onRunCurrent,
}: Omit<ResultProps, "run" | "running" | "onShowOnCanvas"> & {
  run: SandboxTestRun;
}) {
  const changed = comparisonRows(run).filter((row) => row.changed);
  const stale = summary?.stale ?? null;
  const issues = summary?.issues ?? [];
  const traces = run.result.triggerTraces;
  return (
    <>
      <p className="text-muted-foreground -mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <time dateTime={run.createdAt}>
          {new Date(run.createdAt).toLocaleString()}
        </time>
        <Badge variant="outline">Test only · live data unchanged</Badge>
      </p>
      {/* One stale bar (copy cut 15). The live region is always present, so
          screen readers announce the bar when it appears. */}
      <div role="status" className="empty:hidden">
        {inputsChanged || stale === "older-draft" ? (
          <div className="bg-warn-tint text-warn-text flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm font-medium">
            <span>{inputsChanged ? "Inputs changed" : "Draft changed"}</span>
            <Button
              size="sm"
              variant="outline"
              className="max-xl:min-h-11"
              pending={pending}
              pendingLabel="Running…"
              onClick={() => (inputsChanged ? onRunCurrent() : onRunAgain(run))}
            >
              Run again
            </Button>
          </div>
        ) : null}
      </div>
      <h4
        id={TEST_OUTCOME_HEADLINE_ID}
        tabIndex={-1}
        className="text-lg font-semibold outline-none"
      >
        {run.result.issues.length
          ? stale
            ? "Issues from this earlier test"
            : "This test needs attention"
          : changed.length
            ? `${changed.length} field${changed.length === 1 ? "" : "s"} changed in this test`
            : "No field changes in this test"}
      </h4>
      {run.result.issues.length > 0 && (
        <Alert variant="warning">
          {stale ? null : (
            <p className="mb-2 font-medium">
              Review these issues before relying on the result.
            </p>
          )}
          <ul aria-label="Issues" className="space-y-3">
            {issues.map((issue) => {
              // The shown run always tested the setup's module.
              const field =
                issue.subject?.kind === "field" ? issue.subject : null;
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
                      className="mt-1 min-h-11 whitespace-normal xl:min-h-8"
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
      <ol aria-label="Steps" className="grid min-w-0">
        <Step
          name="Input"
          icon={<FileInput />}
          line={`${moduleName(design, run.input.moduleId)} · ${eventDescription(design, run)}`}
        />
        <Step
          name="Trigger outcomes"
          icon={<GitBranch />}
          // One trace is the line itself; more are counted, then listed.
          line={
            traces.length === 1
              ? `${traces[0]!.label} · ${traces[0]!.outcome}`
              : outcomesLine(run)
          }
        >
          {traces.length === 1 ? (
            traces[0]!.outcome === "Not triggered" ? (
              <NotTriggeredReason
                trigger={triggers.find(
                  (item) => item.id === traces[0]!.triggerId,
                )}
                design={design}
                testedModuleId={run.input.moduleId}
                pending={pending}
                onTryTrigger={onTryTrigger}
              />
            ) : null
          ) : traces.length ? (
            <div className="divide-border grid divide-y">
              {traces.map((trace, index) => (
                <div
                  key={`${trace.triggerId}-${index}`}
                  className="grid gap-1 py-1.5 first:pt-0 last:pb-0"
                >
                  <p className="[overflow-wrap:anywhere]">
                    <span className="font-medium">{trace.label}</span>
                    <span className="text-muted-foreground">
                      {" · "}
                      {trace.outcome}
                    </span>
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
                </div>
              ))}
            </div>
          ) : null}
        </Step>
        <Step
          name="Result"
          icon={<Check />}
          last
          line={
            changed.length
              ? `${namesLine(
                  changed.map((row) =>
                    fieldName(design, run.input.moduleId, row.id),
                  ),
                )} changed`
              : "No field values changed."
          }
        />
      </ol>
      <TestComparison key={run.id} design={design} run={run} />
      <div className="border-border grid border-t pt-1">
        <Disclosure label="Inputs used for this result">
          <dl className="grid max-h-72 gap-x-4 gap-y-2 overflow-y-auto text-sm [overflow-wrap:anywhere] @min-[30rem]/result:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
            {Object.entries(run.input.values).map(([id, value]) => (
              <div key={id} className="contents">
                <dt className="text-muted-foreground">
                  {fieldName(design, run.input.moduleId, id)}
                </dt>
                <dd className="whitespace-pre-wrap">
                  {displayValue(value, "Not provided")}
                </dd>
              </div>
            ))}
          </dl>
        </Disclosure>
        {run.result.routes.length > 0 && (
          <Disclosure label="Relationship routing">
            <ul className="text-muted-foreground space-y-2 text-sm">
              {run.result.routes.map((route, index) => (
                <li key={index}>
                  <span className="font-medium">{route.label}</span>
                  {route.detail ? `: ${route.detail}` : ""}
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
      </div>
    </>
  );
}

/** A closed section of the result, opened by its named header. */
function Disclosure({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={label}>
      <Collapsible className="group">
        <CollapsibleTrigger
          render={
            <Button
              variant="ghost"
              className="h-auto min-h-11 w-full justify-between px-0 text-left text-sm font-medium hover:bg-transparent xl:min-h-9"
            />
          }
        >
          {label}
          <ChevronDown
            aria-hidden="true"
            className="size-4 transition-transform group-data-open:rotate-180 motion-reduce:transition-none"
          />
        </CollapsibleTrigger>
        <CollapsibleContent keepMounted className="pb-3">
          {children}
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

/** Each value before and after the run: the changed ones, or all (keyed by
    run, so another result starts on its own view). */
function TestComparison({
  design,
  run,
}: {
  design: SandboxDocumentDesign;
  run: SandboxTestRun;
}) {
  const rows = comparisonRows(run);
  const changed = rows.filter((row) => row.changed);
  // With nothing changed, the headline already says so; the list opens on
  // every value instead of an empty Changed view.
  const [showAll, setShowAll] = useState(changed.length === 0);
  const [limit, setLimit] = useState(12);
  const visible = showAll ? rows : changed;
  return (
    <section aria-label="Field comparison" className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">Field comparison</h4>
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
          className="w-fit shrink-0 [&>*]:whitespace-nowrap"
        >
          <ToggleGroupItem value="changed">
            Changed ({changed.length})
          </ToggleGroupItem>
          <ToggleGroupItem value="all">
            All fields ({rows.length})
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {visible.length ? (
        <div className="border-border overflow-hidden rounded-lg border">
          <Table className="table-fixed text-left text-sm [overflow-wrap:anywhere]">
            <TableCaption className="sr-only mt-0">
              Saved test input and values after the test
            </TableCaption>
            <TableHeader className="text-muted-foreground">
              <TableRow className="hover:bg-transparent">
                <TableHead
                  scope="col"
                  className="h-9 w-[40%] px-3 text-xs font-medium whitespace-normal"
                >
                  Field
                </TableHead>
                <TableHead
                  scope="col"
                  className="h-9 w-[30%] px-2 text-xs font-medium whitespace-normal"
                >
                  Before
                </TableHead>
                <TableHead
                  scope="col"
                  className="h-9 w-[30%] px-3 pl-2 text-xs font-medium whitespace-normal"
                >
                  After
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
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
                    className="h-auto min-h-10 px-3 py-2 align-top font-medium whitespace-normal"
                  >
                    {fieldName(design, run.input.moduleId, row.id)}
                    <span
                      className={cn(
                        "block text-xs font-normal",
                        row.changed ? "text-success" : "text-muted-foreground",
                      )}
                    >
                      {row.after === undefined
                        ? "Not evaluated"
                        : row.changed
                          ? "Changed"
                          : "Unchanged"}
                    </span>
                  </TableHead>
                  <TableCell className="h-auto px-2 py-2 align-top whitespace-pre-wrap">
                    {displayValue(row.before, "Not provided")}
                  </TableCell>
                  <TableCell className="h-auto py-2 pr-3 pl-2 align-top whitespace-pre-wrap">
                    {displayValue(row.after, "No value")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          {showAll ? "No field values to compare." : "No field values changed."}
        </p>
      )}
      {visible.length > limit && (
        <Button
          variant="outline"
          className="min-h-11 w-full xl:min-h-8"
          onClick={() => setLimit(limit + 12)}
        >
          Show more result fields
        </Button>
      )}
    </section>
  );
}
