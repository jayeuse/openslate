"use client";

import type { Route } from "next";
import { ArrowRight, X } from "lucide-react";

import { AdvancedSection } from "@/components/ui/advanced-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { PersonAvatar } from "@/components/person-avatar";
import { GuardedWorkspaceLink } from "@/components/workspace-navigation-guard";
import { formatWorkspaceDateTime, type WorkspaceRegion } from "@/lib/date-time";

import type { ManageAuditLog } from "../adapters/audit-api";
import {
  auditChanges,
  auditKind,
  auditSentence,
  type AuditFieldNames,
} from "../domain/audit-rules";

/** Where the record opens, when this viewer has a page for it. */
function recordHref(log: ManageAuditLog, admin: boolean): Route | null {
  if (!log.entity_id || log.action === "delete") return null;
  const id = encodeURIComponent(log.entity_id);
  if (log.entity_type === "records") return `/openview?record=${id}` as Route;
  if (!admin) return null;
  if (log.entity_type === "users")
    return `/access?view=people&user=${id}` as Route;
  if (log.entity_type === "groups")
    return `/access?view=groups&group=${id}` as Route;
  return null;
}

function rawValues(values: Record<string, unknown> | null): string {
  return values && Object.keys(values).length
    ? JSON.stringify(values, null, 2)
    : "None recorded";
}

const rowClassName =
  "grid min-w-0 gap-x-3 gap-y-0.5 py-2 text-sm sm:grid-cols-[8rem_minmax(0,1fr)] sm:items-baseline";

/**
 * One audit event as a side sheet (MD6): what changed as old → new rows for
 * the changed values only, then the record and where it opens, then
 * Advanced with the raw values. It reads the list row, so a department
 * manager, whose detail read the server refuses, sees the same sheet.
 */
export function AuditEventSheet({
  log,
  person,
  area,
  fieldNames,
  region,
  admin,
  onClose,
  finalFocus,
}: {
  log: ManageAuditLog | null;
  person: string;
  area: string;
  /** Record field names by id; an unread field keeps its short id. */
  fieldNames: AuditFieldNames;
  region: WorkspaceRegion | undefined;
  admin: boolean;
  onClose: () => void;
  finalFocus: () => HTMLElement | null;
}) {
  const sentence = log ? auditSentence(log) : null;
  const changes = log ? auditChanges(log, region, fieldNames) : [];
  const href = log ? recordHref(log, admin) : null;
  const kind = log ? auditKind(log.entity_type) : null;
  const when =
    log && region
      ? formatWorkspaceDateTime(log.created_at, region)
      : (log?.created_at ?? "");
  return (
    <Sheet
      open={log !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        className="slim-ui flex w-full max-w-none flex-col gap-0 overflow-hidden p-0 sm:w-[min(92vw,30rem)]"
        finalFocus={() => finalFocus() ?? true}
      >
        {log && sentence && kind ? (
          <>
            <SheetHeader className="flex shrink-0 flex-row items-start gap-3 border-b p-5 pr-16">
              <PersonAvatar name={person} avatarUrl={null} size="default" />
              <div className="min-w-0 space-y-1">
                <SheetTitle className="text-lg break-words">
                  {`${sentence.verb} ${sentence.target}`}
                </SheetTitle>
                <SheetDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span>{person}</span>
                  <span aria-hidden="true">·</span>
                  <time dateTime={log.created_at}>{when}</time>
                  <Badge variant="secondary">{area}</Badge>
                </SheetDescription>
              </div>
            </SheetHeader>
            <SheetClose
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute top-3 right-3 size-11"
                  aria-label="Close event details"
                />
              }
            >
              <X aria-hidden="true" />
            </SheetClose>
            <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
              <section aria-labelledby={`${log.id}-changed`}>
                <h3
                  id={`${log.id}-changed`}
                  className="mb-2 text-sm font-semibold"
                >
                  What changed
                </h3>
                {changes.length ? (
                  <ul className="divide-border divide-y rounded-md border px-3">
                    {changes.map((change) => (
                      <li key={change.key} className={rowClassName}>
                        <span className="text-muted-foreground">
                          {change.label}
                        </span>{" "}
                        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 break-words">
                          <span
                            className={
                              change.before === "Not set" ||
                              change.before === "Hidden"
                                ? "text-muted-foreground"
                                : "text-muted-foreground line-through"
                            }
                          >
                            {change.before}
                          </span>{" "}
                          <span className="sr-only">to</span>
                          <ArrowRight
                            aria-hidden="true"
                            className="size-3.5 shrink-0"
                          />{" "}
                          <b className="font-semibold">{change.after}</b>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground text-sm">
                    No changed values were recorded.
                  </p>
                )}
              </section>
              <section aria-labelledby={`${log.id}-record`}>
                <h3
                  id={`${log.id}-record`}
                  className="mb-1 text-sm font-semibold"
                >
                  Record
                </h3>
                <dl className="divide-border divide-y">
                  <div className={rowClassName}>
                    <dt className="text-muted-foreground">Record</dt>
                    <dd className="flex min-w-0 flex-wrap items-baseline gap-x-2 break-words">
                      {sentence.target}
                      {href ? (
                        <GuardedWorkspaceLink
                          href={href}
                          className="text-action-text inline-flex min-h-11 items-center underline-offset-4 hover:underline xl:min-h-0"
                        >
                          Open
                          <span className="sr-only"> {sentence.target}</span>
                        </GuardedWorkspaceLink>
                      ) : null}
                    </dd>
                  </div>
                  <div className={rowClassName}>
                    <dt className="text-muted-foreground">Area</dt>
                    <dd>
                      {kind.plural} · {area}
                    </dd>
                  </div>
                  <div className={rowClassName}>
                    <dt className="text-muted-foreground">Event ID</dt>
                    <dd className="font-mono text-xs break-all">{log.id}</dd>
                  </div>
                </dl>
              </section>
              <AdvancedSection
                storageKey="manage-audit-event"
                summary="Raw values"
              >
                <dl className="space-y-3 text-sm">
                  <div>
                    <dt className="text-muted-foreground mb-1">Before</dt>
                    <dd>
                      <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs whitespace-pre-wrap">
                        {rawValues(log.before)}
                      </pre>
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground mb-1">After</dt>
                    <dd>
                      <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs whitespace-pre-wrap">
                        {rawValues(log.after)}
                      </pre>
                    </dd>
                  </div>
                  {log.request_method && log.request_path ? (
                    <div>
                      <dt className="text-muted-foreground mb-1">Request</dt>
                      <dd className="font-mono text-xs break-all">
                        {log.request_method} {log.request_path}
                      </dd>
                    </div>
                  ) : null}
                  {log.request_id ? (
                    <div>
                      <dt className="text-muted-foreground mb-1">Request ID</dt>
                      <dd className="font-mono text-xs break-all">
                        {log.request_id}
                      </dd>
                    </div>
                  ) : null}
                  {log.note ? (
                    <div>
                      <dt className="text-muted-foreground mb-1">Note</dt>
                      <dd>{log.note}</dd>
                    </div>
                  ) : null}
                </dl>
              </AdvancedSection>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
