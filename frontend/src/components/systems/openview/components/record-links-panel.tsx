"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import type { OpenViewDataSource, OpenViewRecord } from "../adapters/views-api";
import {
  assignOpenViewRecordLink,
  getOpenViewRecord,
  linkOpenViewRecords,
  listOpenViewFieldLinks,
  listOpenViewRecordLinks,
  listOpenViewRelationshipFields,
  searchOpenViewLinkTargets,
  unlinkOpenViewRecords,
  type OpenViewRelationship,
  type OpenViewRelationshipField,
} from "../adapters/records-api";
import {
  boundedItems,
  fieldsFirstPageOptions,
} from "../adapters/openview-queries";
import { openViewRecordTitle } from "../domain/record-display";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const SEARCHABLE = new Set(["text", "long_text", "email", "url", "select"]);

const linkKeys = {
  fields: (moduleId: string) =>
    ["openview", "record-controls", "link-fields", moduleId] as const,
  links: (recordId: string) =>
    ["openview", "record-controls", "links", recordId] as const,
  record: (recordId: string) =>
    ["openview", "record-controls", "record", recordId] as const,
};

type RecordLinksPanelProps = {
  record: OpenViewRecord;
  dataSources: readonly OpenViewDataSource[];
  canWrite: boolean;
  onChanged: (message: string) => void;
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function LinkedRecordName({
  id,
  recordId,
  dataSources,
}: {
  id?: string;
  recordId: string;
  dataSources: readonly OpenViewDataSource[];
}) {
  const linked = useQuery({
    queryKey: linkKeys.record(recordId),
    queryFn: () => getOpenViewRecord(recordId),
    retry: false,
  });
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
  const source = dataSources.find((item) => item.id === linked.data.moduleId);
  return (
    <span id={id} className="min-w-0">
      <span className="block wrap-anywhere">
        {openViewRecordTitle(linked.data, source?.titleFieldId)}
      </span>
      {source ? (
        <span className="text-muted-foreground block text-xs">
          {source.name}
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
  onLinked,
  onCancel,
}: {
  field: OpenViewRelationshipField & { targetModuleId: string };
  record: OpenViewRecord;
  linkedIds: ReadonlySet<string>;
  dataSources: readonly OpenViewDataSource[];
  onLinked: (message: string) => void;
  onCancel: () => void;
}) {
  const [search, setSearch] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const searchId = `link-search-${field.id}`;
  useEffect(() => {
    document.getElementById(searchId)?.focus();
  }, [searchId]);
  const targetFields = useQuery(fieldsFirstPageOptions(field.targetModuleId));
  const target = dataSources.find((item) => item.id === field.targetModuleId);
  const fields = targetFields.data?.items ?? [];
  const titleField =
    fields.find((item) => item.id === target?.titleFieldId) ??
    fields.find((item) => SEARCHABLE.has(item.type)) ??
    fields[0];
  // In a field where a record has one source, a record linked from elsewhere
  // cannot be chosen, so it is not offered.
  const taken = useQuery({
    queryKey: ["openview", "record-controls", "field-links", field.id],
    enabled: !field.multipleSources,
    retry: false,
    queryFn: () =>
      boundedItems((page) => listOpenViewFieldLinks(field.id, page)),
  });
  const takenIds = new Set(
    (taken.data?.items ?? []).map((link) => link.targetRecordId),
  );
  const results = useQuery({
    queryKey: [
      "openview",
      "record-controls",
      "link-search",
      field.targetModuleId,
      submitted,
    ],
    enabled: submitted !== null && targetFields.isSuccess,
    retry: false,
    queryFn: () =>
      searchOpenViewLinkTargets({
        moduleId: field.targetModuleId,
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

  const choose = async (targetRecordId: string) => {
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
      onLinked(`Linked in ${field.name}.`);
    } catch (caught) {
      const message = errorMessage(caught, "The link could not be saved.");
      setError(
        /already has a relationship source/i.test(message)
          ? "That record is already linked from another record in this field. Remove that link first."
          : message,
      );
    } finally {
      setPendingId(null);
    }
  };

  const rows = (results.data?.items ?? []).filter(
    (row) =>
      row.id !== record.id && !linkedIds.has(row.id) && !takenIds.has(row.id),
  );
  return (
    <div className="bg-muted/40 flex min-w-0 flex-col gap-3 rounded-[var(--radius)] border p-3">
      <form
        className="flex min-w-0 flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(search.trim());
        }}
      >
        <Field className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
          <FieldLabel htmlFor={`link-search-${field.id}`}>
            Find a record in {target?.name ?? "the linked data source"}
          </FieldLabel>
          <Input
            id={searchId}
            className="min-h-11"
            value={search}
            maxLength={240}
            onChange={(event) => setSearch(event.target.value)}
          />
        </Field>
        <Button
          type="submit"
          variant="outline"
          className="min-h-11"
          disabled={!targetFields.isSuccess}
        >
          Search
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="min-h-11"
          onClick={onCancel}
        >
          Cancel
        </Button>
      </form>
      {targetFields.isError ? (
        <p role="alert" className="text-destructive text-sm">
          The linked data source is not available to you.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      {submitted === null ? null : results.isPending ||
        (!field.multipleSources && taken.isPending) ? (
        <p role="status" className="text-muted-foreground text-sm">
          Searching…
        </p>
      ) : results.isError ? (
        <p role="alert" className="text-destructive text-sm">
          {errorMessage(results.error, "Records could not be searched.")}
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
                  aria-label={`Link ${title}`}
                  disabled={pendingId !== null}
                  onClick={() => void choose(row.id)}
                >
                  {pendingId === row.id ? "Linking…" : "Link"}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function FieldLinks({
  field,
  record,
  links,
  dataSources,
  canChange,
  onChanged,
}: {
  field: OpenViewRelationshipField;
  record: OpenViewRecord;
  links: readonly OpenViewRelationship[];
  dataSources: readonly OpenViewDataSource[];
  canChange: boolean;
  onChanged: (message: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const namePrefix = useId();
  const closePicker = () => {
    setPicking(false);
    requestAnimationFrame(() => addRef.current?.focus());
  };
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const targetModuleId = field.targetModuleId;
  const full = !field.multipleTargets && links.length > 0;

  const unlink = async (link: OpenViewRelationship) => {
    setPendingId(link.id);
    setError("");
    try {
      await unlinkOpenViewRecords(link.id);
      onChanged(`Link removed from ${field.name}.`);
    } catch (caught) {
      setError(errorMessage(caught, "The link could not be removed."));
    } finally {
      setPendingId(null);
    }
  };

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
                dataSources={dataSources}
              />
              {canChange ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11 shrink-0"
                  aria-describedby={`${namePrefix}-${link.id}`}
                  disabled={pendingId !== null}
                  onClick={() => void unlink(link)}
                >
                  {pendingId === link.id ? "Removing…" : "Remove link"}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      {picking && targetModuleId ? (
        <LinkPicker
          field={{ ...field, targetModuleId }}
          record={record}
          linkedIds={new Set(links.map((link) => link.targetRecordId))}
          dataSources={dataSources}
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

  const outgoing = links.data.filter(
    (link) => link.sourceRecordId === record.id,
  );
  const incoming = links.data.filter(
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
      {fields.data.length === 0 && incoming.length === 0 ? (
        <p className="text-muted-foreground py-4 text-sm">
          This data source has no link fields, and no records link to this
          record.
        </p>
      ) : null}
      <div className="divide-y">
        {fields.data.map((field) => (
          <FieldLinks
            key={field.id}
            field={field}
            record={record}
            links={outgoing.filter((link) => link.fieldId === field.id)}
            dataSources={dataSources}
            canChange={canChange}
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
                  dataSources={dataSources}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
