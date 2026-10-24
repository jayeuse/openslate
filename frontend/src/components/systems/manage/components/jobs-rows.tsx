"use client";

import type { Route } from "next";
import { MoreHorizontal, RotateCcw } from "lucide-react";

import { useId } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { GuardedWorkspaceLink } from "@/components/workspace-navigation-guard";
import { cn } from "@/lib/utils";

import { manageJobIdentity, type ManageJob } from "../adapters/jobs-api";
import {
  JOB_EMPTY,
  jobActions,
  jobAttempts,
  jobKindLabel,
  jobOtherTime,
  jobProblem,
  jobStatus,
  jobSubject,
  jobTime,
} from "../domain/job-rules";
import { StatusWord } from "./status-word";

/** A job state as a dot and a word. */
function JobStatusWord({ state }: { state: string }) {
  return <StatusWord {...jobStatus(state)} />;
}

/**
 * The subject in ink. A subject with a record keeps its link, underlined on
 * hover and focus; its name stays the subject.
 */
function Subject({ job, phone }: { job: ManageJob; phone: boolean }) {
  const name = jobSubject(job);
  return job.subjectLink ? (
    <GuardedWorkspaceLink
      href={job.subjectLink as Route}
      title={name}
      className={cn(
        "text-foreground focus-visible:outline-ring min-w-0 truncate font-medium underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-2",
        phone && "inline-flex min-h-11 items-center",
      )}
    >
      {name}
    </GuardedWorkspaceLink>
  ) : (
    <span title={name} className="min-w-0 truncate font-medium">
      {name}
    </span>
  );
}

/**
 * The one time of a row; a next run says so, a last attempt is the default.
 * The other time, when it adds a fact, is in the title and for screen readers.
 */
function When({
  job,
  formatTime,
}: {
  job: ManageJob;
  formatTime: (value: string) => string;
}) {
  const { label, at } = jobTime(job);
  const other = jobOtherTime(job);
  const otherText = other ? `${other.label} ${formatTime(other.at)}` : null;
  return (
    <span className="tabular-nums" title={otherText ?? undefined}>
      {label === "Next run" ? (
        <span className="text-muted-foreground">Next </span>
      ) : (
        <span className="sr-only">Last attempt </span>
      )}
      {at ? <time dateTime={at}>{formatTime(at)}</time> : JOB_EMPTY}
      {otherText ? <span className="sr-only">. {otherText}</span> : null}
    </span>
  );
}

/** Retry in a row menu, only on a row the server lets you retry. */
function RowMenu({
  job,
  blocked,
  onRetry,
}: {
  job: ManageJob;
  blocked: boolean;
  onRetry: (job: ManageJob) => void;
}) {
  const actions = jobActions(job);
  if (!actions.length) return null;
  const name = jobSubject(job);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-11 shrink-0 xl:size-8"
            aria-label={`Actions for ${name}`}
          >
            <MoreHorizontal aria-hidden="true" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="slim-ui min-w-36">
        <DropdownMenuItem
          className="min-h-11 xl:min-h-0"
          aria-label={`Retry ${name}`}
          disabled={blocked}
          onClick={() => onRetry(job)}
        >
          <RotateCcw aria-hidden="true" />
          Retry
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const headClassName = "text-muted-foreground h-9 px-3 text-xs";
const cellClassName = "h-10 px-3 py-0";

/**
 * Jobs rows (MD9): from 768px a table of 40px one-line rows (state, kind,
 * subject, when, attempts), with a recorded problem on a second line; on a
 * phone a list whose rows add the full problem on their own line. Retry sits
 * in a row menu.
 */
export function JobsRows({
  rows,
  phone,
  formatTime,
  blocked,
  onRetry,
  empty,
}: {
  rows: readonly ManageJob[];
  phone: boolean;
  formatTime: (value: string) => string;
  /** True while commands wait for a read, a command, or a recovery. */
  blocked: boolean;
  onRetry: (job: ManageJob) => void;
  empty: string;
}) {
  if (phone)
    return rows.length ? (
      <ul aria-label="Jobs" className="divide-border min-w-0 divide-y">
        {rows.map((job) => {
          const problem = jobProblem(job);
          const attempts = jobAttempts(job.attempts);
          return (
            <li
              key={manageJobIdentity(job)}
              className="flex min-w-0 items-start gap-1 pt-0.5 pr-1 pb-2 pl-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex min-h-11 min-w-0 items-center justify-between gap-3">
                  <Subject job={job} phone />
                  <span className="shrink-0 text-sm">
                    <JobStatusWord state={job.state} />
                  </span>
                </div>
                <p className="text-muted-foreground truncate text-xs">
                  {jobKindLabel(job.kind)} ·{" "}
                  <When job={job} formatTime={formatTime} />
                  {attempts ? ` · ${attempts}` : null}
                </p>
                {problem ? (
                  <p className="text-muted-foreground mt-0.5 text-xs break-words">
                    {problem}
                  </p>
                ) : null}
              </div>
              {/* The menu column keeps its width, so state words line up. */}
              {jobActions(job).length ? (
                <RowMenu job={job} blocked={blocked} onRetry={onRetry} />
              ) : (
                <span aria-hidden="true" className="size-11 shrink-0" />
              )}
            </li>
          );
        })}
      </ul>
    ) : (
      <p className="p-5 text-sm">{empty}</p>
    );
  return (
    <Table aria-label="Jobs" className="table-fixed">
      <colgroup>
        <col className="w-32" />
        <col className="w-36" />
        <col />
        <col className="w-52" />
        <col className="w-28" />
      </colgroup>
      <TableHeader className="bg-card sticky top-0 z-10">
        <TableRow className="hover:bg-transparent">
          {["State", "Job", "Subject", "When", "Attempts"].map((head) => (
            <TableHead key={head} className={headClassName}>
              {head}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length ? (
          rows.map((job) => (
            <JobRow
              key={manageJobIdentity(job)}
              job={job}
              formatTime={formatTime}
              blocked={blocked}
              onRetry={onRetry}
            />
          ))
        ) : (
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={5} className="py-8 text-center text-sm">
              {empty}
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}

/**
 * One job on one 40px line. A recorded problem adds a second, wrapping line
 * under the row from the Job column, so it reads in full by keyboard and
 * touch; the row is described by it.
 */
function JobRow({
  job,
  formatTime,
  blocked,
  onRetry,
}: {
  job: ManageJob;
  formatTime: (value: string) => string;
  blocked: boolean;
  onRetry: (job: ManageJob) => void;
}) {
  const problemId = useId();
  const problem = jobProblem(job);
  return (
    <>
      <TableRow
        aria-describedby={problem ? problemId : undefined}
        className={cn("h-10", problem && "border-b-0")}
      >
        <TableCell className={cn(cellClassName, "text-sm")}>
          <JobStatusWord state={job.state} />
        </TableCell>
        <TableCell className={cn(cellClassName, "truncate")}>
          {jobKindLabel(job.kind)}
        </TableCell>
        <TableCell className={cellClassName}>
          <span className="flex min-w-0">
            <Subject job={job} phone={false} />
          </span>
        </TableCell>
        <TableCell className={cn(cellClassName, "truncate")}>
          <When job={job} formatTime={formatTime} />
        </TableCell>
        <TableCell className={cn(cellClassName, "pr-1 tabular-nums")}>
          <span className="flex min-w-0 items-center justify-between gap-2">
            <span>{job.attempts > 0 ? job.attempts : JOB_EMPTY}</span>
            <RowMenu job={job} blocked={blocked} onRetry={onRetry} />
          </span>
        </TableCell>
      </TableRow>
      {problem ? (
        // A line of the row above, not a row of its own.
        <TableRow role="presentation" className="hover:bg-transparent">
          <TableCell className="p-0" />
          <TableCell
            id={problemId}
            colSpan={4}
            className="text-muted-foreground px-3 pt-0 pb-2.5 text-sm [overflow-wrap:anywhere] whitespace-normal"
          >
            {problem}
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}
