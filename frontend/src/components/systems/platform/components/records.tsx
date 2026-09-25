"use client";

import Link from "next/link";
import { ArrowUpRight, Files } from "lucide-react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Action, Choice, Panel } from "../../shared/components/ui";
import type { Person } from "../../access/domain/model";
import type { SampleRecord } from "../../shared/data/sample-data";

type RecordsProps = {
  records: readonly SampleRecord[];
  people: readonly Person[];
  selectedRecord: SampleRecord | null;
  followed: readonly string[];
  assignmentValue: string;
  assignmentError: string | undefined;
  navigationPending: boolean;
  pendingAssignment: boolean;
  pendingDiscussion: boolean;
  pendingFollow: boolean;
  hasRecordDiscussion: boolean;
  isNavigationPending: () => boolean;
  onSelectRecord: (recordId: string) => void;
  onAssignRecord: (recordId: string, assignee: string) => void;
  onRetryAssignment: () => void;
  onStartDiscussion: () => void;
  onToggleFollow: () => void;
};

export default function Records({
  records,
  people,
  selectedRecord,
  followed,
  assignmentValue,
  assignmentError,
  navigationPending,
  pendingAssignment,
  pendingDiscussion,
  pendingFollow,
  hasRecordDiscussion,
  isNavigationPending,
  onSelectRecord,
  onAssignRecord,
  onRetryAssignment,
  onStartDiscussion,
  onToggleFollow,
}: RecordsProps) {
  return (
    <div className="grid items-start gap-5 xl:grid-cols-2">
      <Panel title="Connected record actions">
        {selectedRecord ? (
          <>
            <Choice
              label="Select record"
              value={selectedRecord.id}
              disabled={navigationPending}
              onChange={(event) => {
                if (isNavigationPending()) return;
                onSelectRecord(event.target.value);
              }}
            >
              {records.map((record) => (
                <option key={record.id} value={record.id}>
                  {record.title}
                </option>
              ))}
            </Choice>
            <div className="bg-muted/40 rounded-lg p-5">
              <p className="text-muted-foreground text-xs tracking-widest uppercase">
                Service job
              </p>
              <h3 className="mt-2 text-xl font-semibold">
                {selectedRecord.title}
              </h3>
              <p className="mt-2 text-sm">
                {selectedRecord.customer} · {selectedRecord.status}
              </p>
            </div>
            <Choice
              label="Assign record to"
              value={assignmentValue}
              disabled={navigationPending || pendingAssignment}
              onChange={(event) => {
                if (isNavigationPending()) return;
                onAssignRecord(selectedRecord.id, event.target.value);
              }}
            >
              {Array.from(
                new Set([
                  "Unassigned",
                  ...people
                    .filter((person) => person.active)
                    .map((person) => person.name),
                  selectedRecord.assignee,
                  assignmentValue,
                ]),
              ).map((person) => (
                <option key={person}>{person}</option>
              ))}
            </Choice>
            {assignmentError && (
              <div
                role="alert"
                className="border-destructive/50 bg-destructive/10 space-y-2 rounded-lg border p-3 text-sm"
              >
                <p>{assignmentError}</p>
                <Action
                  size="sm"
                  variant="outline"
                  disabled={navigationPending || pendingAssignment}
                  onClick={onRetryAssignment}
                >
                  Retry assignment
                </Action>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Action onClick={onStartDiscussion} disabled={pendingDiscussion}>
                {pendingDiscussion
                  ? "Starting discussion…"
                  : hasRecordDiscussion
                    ? "Record discussion ready"
                    : "Start chat about record"}
              </Action>
              <Action onClick={onToggleFollow} disabled={pendingFollow}>
                {pendingFollow
                  ? "Updating follow…"
                  : followed.includes(selectedRecord.id)
                    ? "Unfollow record"
                    : "Follow record"}
              </Action>
            </div>
            <p className="text-muted-foreground text-sm">
              These sample records can’t be linked to connected Boards.
            </p>
            <p className="text-muted-foreground text-sm">
              {followed.includes(selectedRecord.id)
                ? "Following this record for future updates."
                : "Follow this record to keep its changes in your notification center."}
            </p>
          </>
        ) : (
          <Empty className="min-h-64 border-dashed">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Files />
              </EmptyMedia>
              <EmptyTitle>No records yet</EmptyTitle>
              <EmptyDescription>
                Add a record through Platform import and export to use connected
                record actions.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </Panel>
      <Panel title="Continue your workflow">
        <Link
          className="flex min-h-14 items-center justify-between rounded-lg border p-4 text-sm"
          href="/boards"
        >
          Open Boards
          <ArrowUpRight className="size-4" />
        </Link>
        <Link
          className="flex min-h-14 items-center justify-between rounded-lg border p-4 text-sm"
          href="/comms"
        >
          Open record discussion
          <ArrowUpRight className="size-4" />
        </Link>
        {selectedRecord ? (
          <Link
            className="flex min-h-14 items-center justify-between rounded-lg border p-4 text-sm"
            href={`/openview?record=${encodeURIComponent(selectedRecord.id)}`}
          >
            View record in OpenView
            <ArrowUpRight className="size-4" />
          </Link>
        ) : (
          <p className="text-muted-foreground text-sm">
            Add a record to continue to its OpenView page.
          </p>
        )}
        <p className="text-muted-foreground text-xs">
          Assignment and links stay in sync across workspace pages.
        </p>
      </Panel>
    </div>
  );
}
