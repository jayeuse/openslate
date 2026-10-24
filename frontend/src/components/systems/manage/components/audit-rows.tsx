"use client";

import { ChevronRight, Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

import {
  openRowClassName,
  tintRowClassName,
} from "../../access/components/row-open-button";
import { PersonAvatar } from "@/components/person-avatar";
import type { ManageAuditLog } from "../adapters/audit-api";
import {
  AUDIT_SENTENCE_SEPARATOR,
  auditSentence,
  auditSentenceName,
  type AuditFieldNames,
  type AuditKnownNames,
  type AuditListEntry,
} from "../domain/audit-rules";
import { StatusDot, type StatusTone } from "@/components/ui/status-word";

/** The words a row shows; the parent formats time and names the area. */
export type AuditRowText = {
  person: string;
  time: string;
  /** The time with seconds, for the row's unique accessible name. */
  exactTime: string;
  area: string;
};

const dotTone: Record<ManageAuditLog["action"], StatusTone> = {
  create: "flow",
  update: "action",
  delete: "danger",
};

function Sentence({
  log,
  fieldNames,
  names,
}: {
  log: ManageAuditLog;
  fieldNames: AuditFieldNames;
  names: AuditKnownNames;
}) {
  const { verb, fields, target } = auditSentence(log, fieldNames, names);
  return (
    // Below 1280px the sentence wraps, so the dot sits on its first line.
    <span className="flex min-w-0 items-start gap-1.5 xl:items-center">
      <span className="flex h-lh shrink-0 items-center xl:h-auto">
        <StatusDot tone={dotTone[log.action]} />
      </span>
      {/* Below 1280px the sentence wraps, as on Security events (MD19). */}
      <span className="min-w-0 break-words xl:truncate">
        <b className="font-medium">{verb}</b>
        {fields ? (
          <>
            {" "}
            <span className="text-muted-foreground">{fields}</span>
          </>
        ) : null}
        <span className="text-muted-foreground">
          {AUDIT_SENTENCE_SEPARATOR}
        </span>
        <b className="font-medium">{target}</b>
      </span>
    </span>
  );
}

/**
 * The open control of one event: the sentence is its visible name, and the
 * person and time make the name unique; its hit area covers the row.
 */
function OpenEvent({
  log,
  text,
  fieldNames,
  names,
  onOpen,
}: {
  log: ManageAuditLog;
  text: AuditRowText;
  fieldNames: AuditFieldNames;
  names: AuditKnownNames;
  onOpen: (log: ManageAuditLog, opener: HTMLButtonElement) => void;
}) {
  return (
    <button
      type="button"
      aria-label={`${auditSentenceName(log, fieldNames, names)}, ${text.person}, ${text.exactTime}`}
      className="focus-visible:outline-ring -mx-1 flex min-h-11 w-full min-w-0 items-center rounded-md px-1 text-left after:absolute after:inset-0 after:content-[''] focus-visible:outline-2 xl:min-h-8"
      onClick={(event) => onOpen(log, event.currentTarget)}
    >
      <Sentence log={log} fieldNames={fieldNames} names={names} />
    </button>
  );
}

function FoldText({ count, shown }: { count: number; shown: boolean }) {
  return (
    <span>
      {count} system {count === 1 ? "event" : "events"}{" "}
      {shown ? "on this page" : "hidden on this page"}, such as read receipts.
    </span>
  );
}

function FoldToggle({
  shown,
  onToggle,
}: {
  shown: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="text-action-text min-h-11 px-2 text-sm xl:min-h-8"
      onClick={onToggle}
    >
      {shown ? "Hide" : "Show"}
      <span className="sr-only"> system events</span>
    </Button>
  );
}

/**
 * Activity rows (MD6): from 1280px a table of 40px one-line rows (when,
 * person, what happened, area) whose whole row opens the event; below 1280px
 * a list of two-line rows, because the table cut what happened at 1024
 * (MD19). This page's system events fold into one row.
 */
export function AuditRows({
  entries,
  textFor,
  fieldNames,
  names,
  selectedId,
  onOpen,
  onToggleSystem,
}: {
  entries: readonly AuditListEntry[];
  textFor: (log: ManageAuditLog) => AuditRowText;
  fieldNames: AuditFieldNames;
  names: AuditKnownNames;
  selectedId: string | null;
  onOpen: (log: ManageAuditLog, opener: HTMLButtonElement) => void;
  onToggleSystem: () => void;
}) {
  return (
    <>
      <div className="manage-scroll hidden xl:block">
        <Table aria-label="Activity history table" className="table-fixed">
          <colgroup>
            <col className="w-44" />
            <col className="w-48" />
            <col />
            <col className="w-44" />
          </colgroup>
          <TableHeader className="bg-card sticky top-0 z-10">
            <TableRow className="hover:bg-transparent">
              {["When", "Person", "What happened", "Area"].map((head) => (
                <TableHead
                  key={head}
                  className="text-muted-foreground h-9 px-3 text-xs"
                >
                  {head}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => {
              if (entry.kind === "system")
                return (
                  <TableRow key="system" className="hover:bg-transparent">
                    <TableCell
                      colSpan={4}
                      className="text-muted-foreground h-10 px-3 py-0 text-sm"
                    >
                      <span className="flex items-center gap-2">
                        <Info aria-hidden="true" className="size-4 shrink-0" />
                        <FoldText count={entry.count} shown={entry.shown} />
                        <FoldToggle
                          shown={entry.shown}
                          onToggle={onToggleSystem}
                        />
                      </span>
                    </TableCell>
                  </TableRow>
                );
              const { log } = entry;
              const text = textFor(log);
              return (
                <TableRow
                  key={log.id}
                  data-state={log.id === selectedId ? "selected" : undefined}
                  className={cn(openRowClassName, tintRowClassName, "h-10")}
                >
                  <TableCell className="text-muted-foreground h-10 truncate px-3 py-0 tabular-nums">
                    <time dateTime={log.created_at}>{text.time}</time>
                  </TableCell>
                  <TableCell className="h-10 px-3 py-0">
                    <span className="flex min-w-0 items-center gap-2">
                      <PersonAvatar
                        name={text.person}
                        avatarUrl={null}
                        size="sm"
                        className="size-6 text-[10px]"
                      />
                      <span className="truncate">{text.person}</span>
                    </span>
                  </TableCell>
                  <TableCell className="h-10 overflow-hidden px-3 py-0">
                    <OpenEvent
                      log={log}
                      text={text}
                      fieldNames={fieldNames}
                      names={names}
                      onOpen={onOpen}
                    />
                  </TableCell>
                  <TableCell className="text-muted-foreground h-10 px-3 py-0">
                    <span className="flex min-w-0 items-center justify-between gap-2">
                      <span className="truncate">{text.area}</span>
                      <ChevronRight
                        aria-hidden="true"
                        className="size-4 shrink-0 opacity-60"
                      />
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <ul
        aria-label="Activity history"
        className="divide-border manage-scroll min-w-0 divide-y xl:hidden"
      >
        {entries.map((entry) => {
          if (entry.kind === "system")
            return (
              <li
                key="system"
                className="text-muted-foreground flex min-h-14 items-center gap-2 px-3 py-1.5 text-sm"
              >
                <Info aria-hidden="true" className="size-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <FoldText count={entry.count} shown={entry.shown} />
                </span>
                <FoldToggle shown={entry.shown} onToggle={onToggleSystem} />
              </li>
            );
          const { log } = entry;
          const text = textFor(log);
          return (
            <li
              key={log.id}
              data-state={log.id === selectedId ? "selected" : undefined}
              className={cn(
                openRowClassName,
                tintRowClassName,
                "flex min-h-14 min-w-0 flex-col justify-center gap-0.5 px-3 py-1.5",
              )}
            >
              <span className="flex min-w-0 items-center justify-between gap-3">
                <OpenEvent
                  log={log}
                  text={text}
                  fieldNames={fieldNames}
                  names={names}
                  onOpen={onOpen}
                />
                <time
                  dateTime={log.created_at}
                  className="text-muted-foreground shrink-0 text-xs tabular-nums"
                >
                  {text.time}
                </time>
              </span>
              <span className="text-muted-foreground truncate pl-3.5 text-xs">
                {text.person} · {text.area}
              </span>
            </li>
          );
        })}
      </ul>
    </>
  );
}
