"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useMemo,
} from "react";
import { ApiError } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-errors";
import type { OpenViewDataSource, OpenViewRecord } from "../adapters/views-api";
import {
  assignOpenViewRecordLink,
  getOpenViewRecord,
  linkOpenViewRecords,
  listOpenViewLinks,
  listOpenViewRecordLinks,
  listOpenViewRelationshipFields,
  searchOpenViewLinkTargets,
  unlinkOpenViewRecords,
  type OpenViewRelationship,
  type OpenViewRelationshipField,
} from "../adapters/records-api";
import {
  extendsRead,
  readStamp,
  isAuthorizationDenied,
  recordPageDenial,
  fieldsFirstPageOptions,
} from "../adapters/openview-queries";
import { openViewRecordTitle } from "../domain/record-display";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

import {
  useOpenViewDepartmentNames,
  useOpenViewSource,
} from "../hooks/use-openview-catalog";

const SEARCHABLE = new Set(["text", "long_text", "email", "url", "select"]);

const linkKeys = {
  fields: (moduleId: string) =>
    ["openview", "record-controls", "link-fields", moduleId] as const,
  links: (recordId: string) =>
    ["openview", "record-controls", "links", recordId] as const,
  // Keep uncertain writes through tab unmounts in this account's QueryClient.
  writeCheck: (recordId: string) =>
    ["openview", "record-controls", "link-write-check", recordId] as const,
  record: (recordId: string) =>
    ["openview", "record-controls", "record", recordId] as const,
};

type RelationshipWriteCheck = {
  id: string;
  state: "writing" | "unknown" | "retry";
  operation: "link" | "unlink";
  fieldId: string;
  sourceRecordId: string;
  targetRecordId: string;
  relationshipId: string | null;
  search: string;
};

type RelationshipLinkState = {
  writeCheck: RelationshipWriteCheck | null;
  setWriteCheck: (next: RelationshipWriteCheck | null) => void;
  getWriteCheck: () => RelationshipWriteCheck | null;
  readLinks: (check: RelationshipWriteCheck) => Promise<OpenViewRelationship[]>;
  storeLinks: (
    next: OpenViewRelationship[],
    check: RelationshipWriteCheck,
  ) => void;
  invalidateLinks: () => void;
};

type RecordLinksPanelProps = {
  record: OpenViewRecord;
  dataSources: readonly OpenViewDataSource[];
  canWrite: boolean;
  onChanged: (message: string) => void;
};

function isBusyRelationship(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 503 &&
    (error.code === "relationship_busy" ||
      error.details === "Relationship operation is temporarily unavailable")
  );
}

function hasUnresolvedWrite(check: RelationshipWriteCheck | null): boolean {
  return check?.state === "writing" || check?.state === "unknown";
}

function containsRelationship(
  links: readonly OpenViewRelationship[],
  expected: Pick<
    RelationshipWriteCheck,
    "fieldId" | "sourceRecordId" | "targetRecordId"
  >,
): boolean {
  return links.some(
    (link) =>
      link.fieldId === expected.fieldId &&
      link.sourceRecordId === expected.sourceRecordId &&
      link.targetRecordId === expected.targetRecordId,
  );
}

/**
 * The department of a linked data source, named only when it differs from the
 * department of the record being viewed, so a person knows where it lives.
 */
function useOtherDepartmentName(
  dataSources: readonly OpenViewDataSource[],
  homeModuleId: string,
  linkedModuleId: string | undefined,
): string | null {
  const homeSource = useOpenViewSource(dataSources, homeModuleId);
  const linkedSource = useOpenViewSource(dataSources, linkedModuleId);
  const home = homeSource?.departmentId;
  const linked = linkedSource?.departmentId;
  const names = useOpenViewDepartmentNames(
    linked && home !== linked ? [linked] : [],
  );
  return home && linked && home !== linked ? (names.get(linked) ?? null) : null;
}

function LinkedRecordName({
  id,
  recordId,
  homeModuleId,
  dataSources,
}: {
  id?: string;
  recordId: string;
  /** The module of the record whose links are shown. */
  homeModuleId: string;
  dataSources: readonly OpenViewDataSource[];
}) {
  const linked = useQuery({
    queryKey: linkKeys.record(recordId),
    queryFn: () => getOpenViewRecord(recordId),
    retry: false,
  });
  const source = useOpenViewSource(dataSources, linked.data?.moduleId);
  const department = useOtherDepartmentName(
    dataSources,
    homeModuleId,
    linked.data?.moduleId,
  );
  if (linked.isPending)
    return (
      <span id={id} className="text-muted-foreground">
        Loading…
      </span>
    );
  if (!linked.data)
    return (
      <span id={id} className="text-muted-foreground">
        Record unavailable
      </span>
    );
  return (
    <span id={id} className="min-w-0">
      <span className="block wrap-anywhere">
        {openViewRecordTitle(linked.data, source?.titleFieldId)}
      </span>
      {source ? (
        <span className="text-muted-foreground block text-xs">
          {department ? `${source.name} · ${department}` : source.name}
        </span>
      ) : null}
    </span>
  );
}

function LinkPicker({
  field,
  record,
  linkedIds,
  dataSources,
  linkState,
  onLinked,
  onCancel,
}: {
  field: OpenViewRelationshipField & { targetModuleId: string };
  record: OpenViewRecord;
  linkedIds: ReadonlySet<string>;
  dataSources: readonly OpenViewDataSource[];
  linkState: RelationshipLinkState;
  onLinked: (message: string) => void;
  onCancel: () => void;
}) {
  const initialCheck =
    linkState.writeCheck?.operation === "link" &&
    linkState.writeCheck.fieldId === field.id
      ? linkState.writeCheck
      : null;
  const [search, setSearch] = useState(initialCheck?.search ?? "");
  const [submitted, setSubmitted] = useState<string | null>(
    initialCheck?.search ?? null,
  );
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const searchId = `link-search-${field.id}`;
  useEffect(() => {
    mounted.current = true;
    document.getElementById(searchId)?.focus();
    return () => {
      mounted.current = false;
    };
  }, [searchId]);
  const targetFields = useQuery(fieldsFirstPageOptions(field.targetModuleId));
  const target = useOpenViewSource(dataSources, field.targetModuleId);
  const targetDepartment = useOtherDepartmentName(
    dataSources,
    record.moduleId,
    field.targetModuleId,
  );
  const fields = targetFields.data?.items ?? [];
  const titleField =
    fields.find((item) => item.id === target?.titleFieldId) ??
    fields.find((item) => SEARCHABLE.has(item.type)) ??
    fields[0];
  const client = useQueryClient();
  const [resultOffset, setResultOffset] = useState(0);
  const results = useQuery({
    queryKey: [
      "openview",
      "record-controls",
      "link-search",
      field.targetModuleId,
      submitted,
      resultOffset,
      titleField?.id,
      fields.map((item) => item.id),
    ],
    enabled: submitted !== null && targetFields.isSuccess,
    retry: false,
    queryFn: () =>
      searchOpenViewLinkTargets({
        moduleId: field.targetModuleId,
        offset: resultOffset,
        definition: {
          version: 1,
          logic: "and",
          columns: titleField
            ? [{ fieldId: titleField.id, expectedType: titleField.type }]
            : [],
          filters: [],
          sort: [],
          deleted: "exclude",
          search: submitted || null,
          searchFields: fields
            .filter((item) => SEARCHABLE.has(item.type))
            .map((item) => ({ fieldId: item.id, expectedType: item.type })),
        },
      }),
  });
  const [resultPages, setResultPages] = useState<{
    search: string;
    items: OpenViewRecord[];
  } | null>(null);
  const candidates = useMemo(
    () => [
      ...(resultPages?.search === submitted ? resultPages.items : []),
      ...(results.data?.items ?? []),
    ],
    [resultPages, submitted, results.data],
  );
  // Only the current candidate collection needs occupancy checks. Exact target
  // filters cannot miss an edge beyond an unrelated field-link page.
  const taken = useQuery({
    queryKey: [
      "openview",
      "record-controls",
      "candidate-occupancy",
      field.id,
      (results.data?.items ?? []).map((item) => item.id),
    ],
    enabled: !field.multipleSources && results.isSuccess,
    queryFn: async ({ signal }) => {
      const occupied: string[] = [];
      // Bound concurrency to one: these are at most the user-requested search
      // pages, never a crawl of the field's complete relationship collection.
      for (const candidate of results.data?.items ?? []) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        const page = await client.fetchQuery({
          queryKey: [
            "openview",
            "record-controls",
            "target-occupancy",
            field.id,
            candidate.id,
          ],
          queryFn: () =>
            listOpenViewLinks({
              fieldId: field.id,
              targetRecordId: candidate.id,
              limit: 1,
              offset: 0,
              signal,
            }),
          staleTime: 0,
        });
        if (page.pagination.total > 0) occupied.push(candidate.id);
      }
      return occupied;
    },
  });
  const takenIds = new Set(taken.data ?? []);

  const reconcileLink = async (check: RelationshipWriteCheck) => {
    try {
      const refreshed = await linkState.readLinks(check);
      if (linkState.getWriteCheck()?.id !== check.id) return;
      linkState.storeLinks(refreshed, check);
      if (containsRelationship(refreshed, check)) {
        linkState.setWriteCheck(null);
        if (mounted.current) {
          setError("");
          onLinked(`Linked in ${field.name}.`);
        }
        return;
      }
      linkState.setWriteCheck({ ...check, state: "retry" });
    } catch {
      // Keep the unknown result guarded until an authoritative read succeeds.
    }
  };

  const checkAgain = async () => {
    const check = linkState.getWriteCheck();
    if (
      !check ||
      check.operation !== "link" ||
      check.fieldId !== field.id ||
      check.state !== "unknown" ||
      pendingId !== null
    )
      return;
    const nextCheck = { ...check, id: crypto.randomUUID() };
    linkState.setWriteCheck(nextCheck);
    setPendingId(nextCheck.targetRecordId);
    setError("");
    try {
      await reconcileLink(nextCheck);
    } finally {
      setPendingId(null);
    }
  };

  const choose = async (targetRecordId: string) => {
    const unresolved = linkState.getWriteCheck();
    if (pendingId !== null || hasUnresolvedWrite(unresolved)) return;
    const check: RelationshipWriteCheck = {
      id: crypto.randomUUID(),
      state: "writing",
      operation: "link",
      fieldId: field.id,
      sourceRecordId: record.id,
      targetRecordId,
      relationshipId: null,
      search,
    };
    linkState.setWriteCheck(check);
    setPendingId(targetRecordId);
    setError("");
    try {
      if (field.multipleTargets)
        await linkOpenViewRecords({
          fieldId: field.id,
          sourceRecordId: record.id,
          targetRecordId,
        });
      else
        await assignOpenViewRecordLink({
          fieldId: field.id,
          sourceRecordId: record.id,
          targetRecordId,
        });
      linkState.setWriteCheck(null);
      linkState.invalidateLinks();
      if (mounted.current) onLinked(`Linked in ${field.name}.`);
    } catch (caught) {
      if (isBusyRelationship(caught)) {
        const uncertain = { ...check, state: "unknown" as const };
        linkState.setWriteCheck(uncertain);
        await reconcileLink(uncertain);
        return;
      }
      linkState.setWriteCheck(null);
      const message =
        caught instanceof ApiError &&
        typeof caught.details === "string" &&
        /already has a relationship source/i.test(caught.details)
          ? "That record is already linked from another record in this field. Remove that link first."
          : apiErrorMessage(caught, "The link could not be saved.");
      if (mounted.current) setError(message);
    } finally {
      setPendingId(null);
    }
  };

  const currentCheck = linkState.writeCheck;
  const unresolvedCheck = hasUnresolvedWrite(currentCheck);
  const retryTargetId =
    currentCheck?.state === "retry" &&
    currentCheck.operation === "link" &&
    currentCheck.fieldId === field.id
      ? currentCheck.targetRecordId
      : null;
  const resolutionNotice =
    currentCheck?.state === "unknown" &&
    currentCheck.operation === "link" &&
    currentCheck.fieldId === field.id
      ? pendingId === null
        ? "We couldn’t confirm whether the link was saved. Check again before retrying."
        : ""
      : retryTargetId
        ? "The link was not saved. Try again."
        : "";
  const visibleError = error || resolutionNotice;

  const rows = candidates.filter(
    (row) =>
      row.id !== record.id && !linkedIds.has(row.id) && !takenIds.has(row.id),
  );
  return (
    <div className="bg-muted/40 flex min-w-0 flex-col gap-3 rounded-[var(--radius)] border p-3">
      <form
        className="flex min-w-0 flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (submitted === search.trim() && resultOffset === 0) {
            void results.refetch();
            if (!field.multipleSources) void taken.refetch();
          }
          setSubmitted(search.trim());
          setResultOffset(0);
          setResultPages(null);
        }}
      >
        <Field className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
          <FieldLabel htmlFor={`link-search-${field.id}`}>
            Find a record in {target?.name ?? "the linked data source"}
            {targetDepartment ? (
              <span className="text-muted-foreground font-normal">
                {` · ${targetDepartment}`}
              </span>
            ) : null}
          </FieldLabel>
          <Input
            id={searchId}
            className="min-h-11"
            value={search}
            maxLength={240}
            disabled={unresolvedCheck}
            onChange={(event) => {
              const next = event.target.value;
              setSearch(next);
              const check = linkState.getWriteCheck();
              if (
                check?.state === "retry" &&
                check.operation === "link" &&
                check.fieldId === field.id &&
                check.search !== next
              )
                linkState.setWriteCheck(null);
            }}
          />
        </Field>
        <Button
          type="submit"
          variant="outline"
          className="min-h-11"
          disabled={!targetFields.isSuccess || unresolvedCheck}
        >
          Search
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="min-h-11"
          onClick={onCancel}
          disabled={unresolvedCheck}
        >
          Cancel
        </Button>
      </form>
      {targetFields.isError ? (
        <p role="alert" className="text-destructive text-sm">
          The linked data source is not available to you.
        </p>
      ) : null}
      {visibleError ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-destructive text-sm">
            {visibleError}
          </p>
          {currentCheck?.state === "unknown" &&
          currentCheck.operation === "link" &&
          currentCheck.fieldId === field.id &&
          pendingId === null ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={pendingId !== null}
              onClick={() => void checkAgain()}
            >
              Check again
            </Button>
          ) : null}
        </div>
      ) : null}
      {currentCheck?.operation === "link" &&
      currentCheck.fieldId === field.id &&
      currentCheck.state === "writing" ? (
        <p role="status" className="text-muted-foreground text-sm">
          Saving this link…
        </p>
      ) : null}
      {currentCheck?.operation === "link" &&
      currentCheck.fieldId === field.id &&
      currentCheck.state === "unknown" &&
      pendingId !== null ? (
        <p role="status" className="text-muted-foreground text-sm">
          Checking whether the link was saved…
        </p>
      ) : null}
      {submitted === null ? null : results.isPending ||
        (!field.multipleSources && taken.isPending) ? (
        <p role="status" className="text-muted-foreground text-sm">
          Searching…
        </p>
      ) : results.isError || (!field.multipleSources && taken.isError) ? (
        <p role="alert" className="text-destructive text-sm">
          {apiErrorMessage(
            results.error ?? taken.error,
            "Records could not be searched. Retry the search.",
          )}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {field.multipleSources
            ? "No records to link. Try another search."
            : "No records to link. Records already linked from another record are not listed. Try another search."}
        </p>
      ) : (
        <ul
          className="divide-y"
          aria-label={`Records to link in ${field.name}`}
        >
          {rows.map((row) => {
            const title = openViewRecordTitle(row, titleField?.id);
            return (
              <li
                key={row.id}
                className="flex min-w-0 items-center justify-between gap-3 py-2"
              >
                <span className="min-w-0 text-sm wrap-anywhere">{title}</span>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 shrink-0"
                  aria-label={
                    pendingId === row.id && currentCheck?.state === "unknown"
                      ? `Checking whether ${title} was saved`
                      : `${retryTargetId === row.id ? "Try again to link" : "Link"} ${title}`
                  }
                  disabled={pendingId !== null || unresolvedCheck}
                  onClick={() => void choose(row.id)}
                >
                  {pendingId === row.id && currentCheck?.state === "unknown"
                    ? "Checking…"
                    : pendingId === row.id
                      ? "Linking…"
                      : retryTargetId === row.id
                        ? "Try again"
                        : "Link"}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {results.data?.pagination.hasMore ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11 self-start"
          disabled={
            results.isFetching ||
            unresolvedCheck ||
            (!field.multipleSources && !taken.isSuccess)
          }
          onClick={() => {
            if (!results.data || submitted === null) return;
            setResultPages({
              search: submitted,
              items: candidates.filter((item) => !takenIds.has(item.id)),
            });
            setResultOffset(
              results.data.pagination.offset + results.data.pagination.count,
            );
          }}
        >
          Load more records to link
        </Button>
      ) : null}
    </div>
  );
}

function FieldLinks({
  field,
  record,
  links,
  dataSources,
  canChange,
  linkState,
  onChanged,
}: {
  field: OpenViewRelationshipField;
  record: OpenViewRecord;
  links: readonly OpenViewRelationship[];
  dataSources: readonly OpenViewDataSource[];
  canChange: boolean;
  linkState: RelationshipLinkState;
  onChanged: (message: string) => void;
}) {
  const fieldCheck =
    linkState.writeCheck?.fieldId === field.id ? linkState.writeCheck : null;
  const [picking, setPicking] = useState(fieldCheck?.operation === "link");
  const addRef = useRef<HTMLButtonElement>(null);
  const focusAddOnClose = useRef(false);
  const namePrefix = useId();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    if (picking || !focusAddOnClose.current) return;
    focusAddOnClose.current = false;
    // Restore focus before the dialog recovers from the removed Cancel button.
    addRef.current?.focus();
  }, [picking]);
  const closePicker = () => {
    const check = linkState.getWriteCheck();
    if (hasUnresolvedWrite(check)) return;
    if (
      check?.state === "retry" &&
      check.operation === "link" &&
      check.fieldId === field.id
    )
      linkState.setWriteCheck(null);
    focusAddOnClose.current = true;
    setPicking(false);
  };
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  // Linking needs read access to the target; a data source the person cannot
  // read is absent from their catalog, so no Add link is offered for it.
  const targetSource = useOpenViewSource(dataSources, field.targetModuleId);
  const targetModuleId = targetSource?.id ?? null;
  const full = !field.multipleTargets && links.length > 0;

  const reconcileUnlink = async (check: RelationshipWriteCheck) => {
    try {
      const refreshed = await linkState.readLinks(check);
      if (linkState.getWriteCheck()?.id !== check.id) return;
      linkState.storeLinks(refreshed, check);
      const stillPresent = refreshed.some(
        (link) => link.id === check.relationshipId,
      );
      if (!stillPresent) {
        linkState.setWriteCheck(null);
        if (mounted.current) {
          setError("");
          onChanged(`Link removed from ${field.name}.`);
        }
        return;
      }
      linkState.setWriteCheck({ ...check, state: "retry" });
    } catch {
      // Keep the unknown result guarded until an authoritative read succeeds.
    }
  };

  const checkUnlinkAgain = async () => {
    const check = linkState.getWriteCheck();
    if (
      !check ||
      check.operation !== "unlink" ||
      check.fieldId !== field.id ||
      check.state !== "unknown" ||
      check.relationshipId === null ||
      pendingId !== null
    )
      return;
    const nextCheck = { ...check, id: crypto.randomUUID() };
    linkState.setWriteCheck(nextCheck);
    setPendingId(nextCheck.relationshipId);
    setError("");
    try {
      await reconcileUnlink(nextCheck);
    } finally {
      setPendingId(null);
    }
  };

  const unlink = async (link: OpenViewRelationship) => {
    const unresolved = linkState.getWriteCheck();
    if (pendingId !== null || hasUnresolvedWrite(unresolved)) return;
    const check: RelationshipWriteCheck = {
      id: crypto.randomUUID(),
      state: "writing",
      operation: "unlink",
      fieldId: field.id,
      sourceRecordId: link.sourceRecordId,
      targetRecordId: link.targetRecordId,
      relationshipId: link.id,
      search: "",
    };
    linkState.setWriteCheck(check);
    setPendingId(link.id);
    setError("");
    try {
      await unlinkOpenViewRecords(link.id);
      linkState.setWriteCheck(null);
      linkState.invalidateLinks();
      if (mounted.current) onChanged(`Link removed from ${field.name}.`);
    } catch (caught) {
      if (isBusyRelationship(caught)) {
        const uncertain = { ...check, state: "unknown" as const };
        linkState.setWriteCheck(uncertain);
        await reconcileUnlink(uncertain);
      } else {
        linkState.setWriteCheck(null);
        if (mounted.current)
          setError(apiErrorMessage(caught, "The link could not be removed."));
      }
    } finally {
      setPendingId(null);
    }
  };

  const allWritesBlocked = hasUnresolvedWrite(linkState.writeCheck);
  const resolutionNotice =
    fieldCheck?.state === "unknown" && fieldCheck.operation === "unlink"
      ? pendingId === null
        ? "We couldn’t confirm whether the link was removed. Check again before retrying."
        : ""
      : fieldCheck?.state === "retry" && fieldCheck.operation === "unlink"
        ? "The link is still present. Try again."
        : "";
  const visibleError = error || resolutionNotice;

  return (
    <section className="flex min-w-0 flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{field.name}</h3>
        {canChange && targetModuleId && !picking ? (
          <Button
            ref={addRef}
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => setPicking(true)}
            disabled={allWritesBlocked}
          >
            {full ? "Replace link" : "Add link"}
          </Button>
        ) : null}
      </div>
      {links.length === 0 ? (
        <p className="text-muted-foreground text-sm">No linked records.</p>
      ) : (
        <ul className="divide-y">
          {links.map((link) => (
            <li
              key={link.id}
              className="flex min-w-0 items-center justify-between gap-3 py-2 text-sm"
            >
              <LinkedRecordName
                id={`${namePrefix}-${link.id}`}
                recordId={link.targetRecordId}
                homeModuleId={record.moduleId}
                dataSources={dataSources}
              />
              {canChange ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11 shrink-0"
                  aria-describedby={`${namePrefix}-${link.id}`}
                  disabled={pendingId !== null || allWritesBlocked}
                  onClick={() => void unlink(link)}
                >
                  {pendingId === link.id && fieldCheck?.state === "unknown"
                    ? "Checking…"
                    : pendingId === link.id
                      ? "Removing…"
                      : fieldCheck?.state === "retry" &&
                          fieldCheck.operation === "unlink" &&
                          fieldCheck.relationshipId === link.id
                        ? "Try again"
                        : "Remove link"}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {visibleError ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-destructive text-sm">
            {visibleError}
          </p>
          {fieldCheck?.state === "unknown" &&
          fieldCheck.operation === "unlink" &&
          pendingId === null ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={pendingId !== null}
              onClick={() => void checkUnlinkAgain()}
            >
              Check again
            </Button>
          ) : null}
        </div>
      ) : null}
      {fieldCheck?.operation === "unlink" && fieldCheck.state === "writing" ? (
        <p role="status" className="text-muted-foreground text-sm">
          Removing this link…
        </p>
      ) : null}
      {fieldCheck?.operation === "unlink" &&
      fieldCheck.state === "unknown" &&
      pendingId !== null ? (
        <p role="status" className="text-muted-foreground text-sm">
          Checking whether the link was removed…
        </p>
      ) : null}
      {picking && targetModuleId ? (
        <LinkPicker
          field={{ ...field, targetModuleId }}
          record={record}
          linkedIds={new Set(links.map((link) => link.targetRecordId))}
          dataSources={dataSources}
          linkState={linkState}
          onCancel={closePicker}
          onLinked={(message) => {
            closePicker();
            onChanged(message);
          }}
        />
      ) : null}
    </section>
  );
}

/** The Linked records tab: links this record makes, and links to it. */
export function RecordLinksPanel({
  record,
  dataSources,
  canWrite,
  onChanged,
}: RecordLinksPanelProps) {
  const client = useQueryClient();
  const fields = useQuery({
    queryKey: linkKeys.fields(record.moduleId),
    queryFn: () => listOpenViewRelationshipFields(record.moduleId),
    retry: false,
  });
  const links = useQuery({
    queryKey: linkKeys.links(record.id),
    queryFn: () => listOpenViewRecordLinks(record.id),
    retry: false,
  });
  const [moreFields, setMoreFields] = useState<{
    readAt: number;
    items: OpenViewRelationshipField[];
    hasMore: boolean;
    nextOffset: number;
  } | null>(null);
  const [moreLinks, setMoreLinks] = useState<{
    readAt: number;
    items: OpenViewRelationship[];
    hasMore: boolean;
    nextOffset: number;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState("");
  const fieldExtension =
    moreFields && extendsRead(moreFields.readAt, fields) ? moreFields : null;
  const linkExtension =
    moreLinks && extendsRead(moreLinks.readAt, links) ? moreLinks : null;
  const fieldItems = [
    ...(fields.data?.items ?? []),
    ...(fieldExtension?.items ?? []),
  ];
  const linkItems = [
    ...(links.data?.items ?? []),
    ...(linkExtension?.items ?? []),
  ];
  const fieldsHasMore =
    fieldExtension?.hasMore ?? fields.data?.pagination.hasMore ?? false;
  const linksHasMore =
    linkExtension?.hasMore ?? links.data?.pagination.hasMore ?? false;
  const loadMore = async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    setMoreError("");
    const fieldReadAt = readStamp(fields);
    const linkReadAt = readStamp(links);
    try {
      const [fieldPage, linkPage] = await Promise.all([
        fieldsHasMore
          ? listOpenViewRelationshipFields(record.moduleId, {
              limit: 100,
              offset:
                fieldExtension?.nextOffset ??
                fields.data?.pagination.count ??
                0,
            })
          : null,
        linksHasMore
          ? listOpenViewRecordLinks(record.id, {
              limit: 100,
              offset:
                linkExtension?.nextOffset ?? links.data?.pagination.count ?? 0,
            })
          : null,
      ]);
      if (fieldPage)
        setMoreFields({
          readAt: fieldReadAt,
          items: [...(fieldExtension?.items ?? []), ...fieldPage.items],
          hasMore: fieldPage.pagination.hasMore,
          nextOffset: fieldPage.pagination.offset + fieldPage.pagination.count,
        });
      if (linkPage)
        setMoreLinks({
          readAt: linkReadAt,
          items: [...(linkExtension?.items ?? []), ...linkPage.items],
          hasMore: linkPage.pagination.hasMore,
          nextOffset: linkPage.pagination.offset + linkPage.pagination.count,
        });
    } catch (caught) {
      if (isAuthorizationDenied(caught)) {
        recordPageDenial(
          client,
          [linkKeys.fields(record.moduleId), linkKeys.links(record.id)],
          caught,
        );
        return;
      }
      setMoreError(
        apiErrorMessage(
          caught,
          "More linked records could not be loaded. Try again.",
        ),
      );
    } finally {
      setLoadingMore(false);
    }
  };
  const writeCheckKey = linkKeys.writeCheck(record.id);
  const writeCheckQuery = useQuery<RelationshipWriteCheck | null>({
    queryKey: writeCheckKey,
    queryFn: async () => null,
    enabled: false,
    initialData: null,
    gcTime: Infinity,
  });
  useEffect(() => {
    const queryKey = linkKeys.writeCheck(record.id);
    return () => {
      if (client.getQueryData<RelationshipWriteCheck | null>(queryKey) === null)
        client.removeQueries({ queryKey, exact: true });
    };
  }, [client, record.id]);
  const linkState: RelationshipLinkState = {
    writeCheck: writeCheckQuery.data,
    setWriteCheck: (next) => client.setQueryData(writeCheckKey, next),
    getWriteCheck: () =>
      client.getQueryData<RelationshipWriteCheck | null>(writeCheckKey) ?? null,
    readLinks: async (check) =>
      (
        await listOpenViewLinks({
          fieldId: check.fieldId,
          sourceRecordId: check.sourceRecordId,
          targetRecordId: check.targetRecordId,
          limit: 1,
          offset: 0,
        })
      ).items,
    storeLinks: (next, check) => {
      client.setQueryData(
        linkKeys.links(record.id),
        (
          previous:
            Awaited<ReturnType<typeof listOpenViewRecordLinks>> | undefined,
        ) =>
          previous
            ? {
                ...previous,
                items: [
                  ...previous.items.filter(
                    (item) => !containsRelationship([item], check),
                  ),
                  ...next,
                ],
              }
            : previous,
      );
      setMoreLinks(null);
    },
    invalidateLinks: () => {
      void client.invalidateQueries({
        queryKey: linkKeys.links(record.id),
        refetchType: "none",
      });
    },
  };
  const changed = (message: string) => {
    void client.invalidateQueries({ queryKey: linkKeys.links(record.id) });
    onChanged(message);
  };

  if (fields.isPending || links.isPending)
    return (
      <p role="status" className="text-muted-foreground py-4 text-sm">
        Loading linked records…
      </p>
    );
  if (fields.isError || links.isError)
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 py-4">
        <p role="alert" className="text-destructive text-sm">
          Linked records could not be loaded.
        </p>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={() => {
            void fields.refetch();
            void links.refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );

  const outgoing = linkItems.filter(
    (link) => link.sourceRecordId === record.id,
  );
  const incoming = linkItems.filter(
    (link) => link.targetRecordId === record.id,
  );
  const canChange = canWrite && !record.isDeleted;
  return (
    <div className="flex min-w-0 flex-col">
      {record.isDeleted ? (
        <Alert role="note" className="mb-2">
          Links of a deleted record are hidden. Restore the record to see and
          change them.
        </Alert>
      ) : null}
      {fieldItems.length === 0 && incoming.length === 0 ? (
        <p className="text-muted-foreground py-4 text-sm">
          This data source has no link fields, and no records link to this
          record.
        </p>
      ) : null}
      <div className="divide-y">
        {fieldItems.map((field) => (
          <FieldLinks
            key={field.id}
            field={field}
            record={record}
            links={outgoing.filter((link) => link.fieldId === field.id)}
            dataSources={dataSources}
            canChange={canChange}
            linkState={linkState}
            onChanged={changed}
          />
        ))}
      </div>
      {incoming.length > 0 ? (
        <section className="flex min-w-0 flex-col gap-2 border-t py-3">
          <h3 className="text-sm font-medium">Linked from</h3>
          <ul className="divide-y">
            {incoming.map((link) => (
              <li key={link.id} className="py-2 text-sm">
                <LinkedRecordName
                  recordId={link.sourceRecordId}
                  homeModuleId={record.moduleId}
                  dataSources={dataSources}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {moreError ? (
        <p role="alert" className="text-destructive text-sm">
          {moreError}
        </p>
      ) : null}
      {fieldsHasMore || linksHasMore ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11 self-start"
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore ? "Loading linked records…" : "Load more linked records"}
        </Button>
      ) : null}
    </div>
  );
}
