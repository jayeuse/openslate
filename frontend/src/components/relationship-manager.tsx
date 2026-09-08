"use client";

import { useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  apiFetch,
  listQuery,
  listAllModuleFields,
  type Field,
  type ListResponse,
  type RecordEntity,
  type Relationship,
} from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Combobox,
  ComboboxTrigger,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
} from "@/components/ui/combobox";
import { compactId } from "@/lib/utils";

type RelationshipManagerProps = {
  moduleId: string;
  recordId: string;
  fields: Field[];
  sourceReadOnly?: boolean;
};

function humanizeHiddenReason(reason: string) {
  return reason
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function RelationshipManager(props: RelationshipManagerProps) {
  return (
    <RelationshipManagerContent
      key={`${props.moduleId}:${props.recordId}`}
      {...props}
    />
  );
}

function RelationshipManagerContent({
  moduleId,
  recordId,
  fields,
  sourceReadOnly = false,
}: RelationshipManagerProps) {
  const relationshipFields = fields.filter(
    (field) => field.type === "relationship",
  );
  const [outgoing, setOutgoing] = useState<Relationship[]>([]);
  const [incoming, setIncoming] = useState<Relationship[]>([]);
  const [selectedTargets, setSelectedTargets] = useState<
    Record<string, string>
  >({});
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");

  const request = useRef<AbortController | null>(null);
  const [loaded, setLoaded] = useState(false);

  async function load() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const [outgoingResult, incomingResult] = await Promise.all([
        apiFetch<ListResponse<Relationship>>(
          `/relationships?${listQuery({ source_record_id: recordId, availability: "all", deleted: "exclude", limit: 100 })}`,
          { signal: controller.signal },
        ),
        apiFetch<ListResponse<Relationship>>(
          `/relationships?${listQuery({ target_record_id: recordId, availability: "all", deleted: "exclude", limit: 100 })}`,
          { signal: controller.signal },
        ),
      ]);
      if (controller.signal.aborted) return;
      setOutgoing(outgoingResult.items);
      setIncoming(incomingResult.items);
      setLoaded(true);
      setSelectedTargets({});
    } catch (reason) {
      if (controller.signal.aborted) return;
      setError(
        reason instanceof Error
          ? reason.message
          : "Relationships could not be loaded",
      );
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, [moduleId, recordId, fields]);

  async function assignSingle(field: Field, targetRecordId: string) {
    const action = `assign-${field.id}`;
    setPending(action);
    setError("");
    try {
      await apiFetch<Relationship | null>(
        `/relationships/fields/${field.id}/sources/${recordId}`,
        {
          method: "PUT",
          body: JSON.stringify({ target_record_id: targetRecordId || null }),
        },
      );
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Link could not be updated",
      );
    } finally {
      setPending(null);
    }
  }

  async function addMultiple(field: Field) {
    const targetRecordId = selectedTargets[field.id];
    if (!targetRecordId) return;
    const action = `add-${field.id}`;
    setPending(action);
    setError("");
    try {
      await apiFetch<Relationship>("/relationships", {
        method: "POST",
        body: JSON.stringify({
          field_id: field.id,
          source_record_id: recordId,
          target_record_id: targetRecordId,
        }),
      });
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Link could not be added",
      );
    } finally {
      setPending(null);
    }
  }

  async function unlink(edge: Relationship) {
    const action = `unlink-${edge.id}`;
    setPending(action);
    setError("");
    try {
      await apiFetch(`/relationships/${edge.id}`, { method: "DELETE" });
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Link could not be removed",
      );
    } finally {
      setPending(null);
    }
  }

  const configuredFieldIds = new Set(
    relationshipFields.map((field) => field.id),
  );
  const unavailableOutgoing = outgoing.filter(
    (edge) => !configuredFieldIds.has(edge.field_id),
  );

  return (
    <section
      aria-labelledby="relationship-manager-heading"
      aria-busy={loading}
      className="flex flex-col gap-4"
    >
      <div>
        <h2 id="relationship-manager-heading" className="text-lg font-semibold">
          Manage relationships
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Links are managed separately from primitive record data.
        </p>
      </div>
      {error && (
        <Alert variant="destructive">
          {error}{" "}
          <button className="ml-2 underline" onClick={() => void load()}>
            Try again
          </button>
        </Alert>
      )}
      {loaded && loading && (
        <p role="status" className="text-muted-foreground text-sm">
          Refreshing relationships…
        </p>
      )}
      {loading && !loaded ? (
        <div role="status" className="flex flex-col gap-3">
          <span className="sr-only">Loading relationships…</span>
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : loaded ? (
        <div className="flex flex-col gap-4">
          {relationshipFields.map((field) => {
            const edges = outgoing.filter((edge) => edge.field_id === field.id);
            const current = edges[0]?.target_record_id ?? "";
            const multiple = field.relationship_multiple_targets === true;
            const fieldReadOnly = sourceReadOnly || field.is_deleted;
            return (
              <fieldset
                className="border-border rounded-[var(--radius)] border p-4"
                key={field.id}
              >
                <legend className="px-1 font-medium">{field.name}</legend>
                {multiple ? (
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                      <div className="flex min-w-0 flex-1 flex-col gap-2">
                        <label
                          htmlFor={`relationship-target-${field.id}`}
                          className="text-sm"
                        >
                          Add target
                        </label>
                        <TargetPicker
                          key={field.relationship_target_module_id}
                          field={field}
                          edges={edges}
                          value={selectedTargets[field.id] ?? ""}
                          disabled={
                            fieldReadOnly || pending !== null || loading
                          }
                          onValueChange={(value) =>
                            setSelectedTargets((previous) => ({
                              ...previous,
                              [field.id]: value,
                            }))
                          }
                        />
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={
                          !selectedTargets[field.id] ||
                          fieldReadOnly ||
                          pending !== null ||
                          loading
                        }
                        onClick={() => void addMultiple(field)}
                      >
                        Add link
                      </Button>
                    </div>
                    <ul
                      className="flex flex-col gap-2"
                      aria-label={`${field.name} current links`}
                    >
                      {edges.length === 0 && (
                        <li className="text-muted-foreground text-sm">
                          No links yet.
                        </li>
                      )}
                      {edges.map((edge) => (
                        <li
                          className="flex items-center justify-between gap-3 text-sm"
                          key={edge.id}
                        >
                          <span title={edge.target_record_id}>
                            {compactId(edge.target_record_id)}
                          </span>
                          {edge.visibility === "hidden" && (
                            <span className="text-muted-foreground mr-auto ml-2">
                              (
                              {edge.hidden_reasons
                                .map(humanizeHiddenReason)
                                .join(", ")}
                              )
                            </span>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={
                              sourceReadOnly || pending !== null || loading
                            }
                            onClick={() => void unlink(edge)}
                          >
                            Unlink
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <label
                      htmlFor={`relationship-target-${field.id}`}
                      className="text-sm"
                    >
                      Target
                    </label>
                    <TargetPicker
                      key={field.relationship_target_module_id}
                      field={field}
                      edges={edges}
                      value={current}
                      disabled={fieldReadOnly || pending !== null || loading}
                      onValueChange={(value) => void assignSingle(field, value)}
                    />
                    {edges.some((edge) => edge.visibility === "hidden") && (
                      <div className="text-muted-foreground flex flex-col gap-1 text-xs">
                        {edges
                          .filter((edge) => edge.visibility === "hidden")
                          .map((edge) => (
                            <p key={edge.id}>
                              Hidden:{" "}
                              {edge.hidden_reasons
                                .map(humanizeHiddenReason)
                                .join(", ")}
                            </p>
                          ))}
                        <p>Clear the selection to unlink a hidden target.</p>
                        {edges[0] && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={
                              sourceReadOnly || pending !== null || loading
                            }
                            onClick={() => void unlink(edges[0])}
                          >
                            Unlink hidden target
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </fieldset>
            );
          })}
          {unavailableOutgoing.length > 0 && (
            <section
              aria-label="Unavailable outgoing links"
              className="border-border rounded-[var(--radius)] border p-4"
            >
              <h3 className="font-medium">Unavailable outgoing links</h3>
              <p className="text-muted-foreground mt-1 text-sm">
                These preserved links use an archived or unavailable field.
              </p>
              <ul className="mt-3 flex flex-col gap-2">
                {unavailableOutgoing.map((edge) => (
                  <li
                    className="flex items-center justify-between gap-3 text-sm"
                    key={edge.id}
                  >
                    <span>
                      {compactId(edge.target_record_id)} · field{" "}
                      {compactId(edge.field_id)}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={sourceReadOnly || pending !== null || loading}
                      onClick={() => void unlink(edge)}
                    >
                      Unlink
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      ) : null}
      <section
        aria-label="Incoming links"
        className="border-border rounded-[var(--radius)] border p-4"
      >
        <h3 className="font-medium">Incoming links</h3>
        <p className="text-muted-foreground mt-1 text-sm">
          Other records linking to this record.
        </p>
        {loading && !loaded ? (
          <Skeleton className="mt-3 h-8 w-full" />
        ) : !loaded ? null : incoming.length === 0 ? (
          <p className="text-muted-foreground mt-3 text-sm">
            No incoming links.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            {incoming.map((edge) => (
              <li key={edge.id}>
                {compactId(edge.source_record_id)}
                {edge.visibility === "hidden" && (
                  <span className="text-muted-foreground ml-2">
                    ({edge.hidden_reasons.map(humanizeHiddenReason).join(", ")})
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

type TargetPickerProps = {
  field: Field;
  edges: Relationship[];
  value: string;
  disabled: boolean;
  onValueChange: (value: string) => void;
};

function targetLabel(
  record: RecordEntity | undefined,
  fields: Field[],
  id: string,
) {
  if (!record) return compactId(id);
  const readable = fields
    .filter(
      (field) =>
        !field.audit_redacted &&
        !field.is_deleted &&
        field.type !== "relationship",
    )
    .sort((a, b) => a.position - b.position);
  const text = readable.find(
    (field) =>
      field.type === "text" &&
      typeof record.data[field.id] === "string" &&
      String(record.data[field.id]).trim(),
  );
  if (text) return String(record.data[text.id]);
  for (const field of readable) {
    const value = record.data[field.id];
    if (
      (typeof value === "string" && value.trim()) ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      return String(value);
  }
  return compactId(id);
}

function TargetPicker({
  field,
  edges,
  value,
  disabled,
  onValueChange,
}: TargetPickerProps) {
  const [records, setRecords] = useState<RecordEntity[]>([]);
  const [metadata, setMetadata] = useState<Field[]>([]);
  const [started, setStarted] = useState(false);
  const [pageLoaded, setPageLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const active = useRef<AbortController | null>(null);
  const metadataRequest = useRef<AbortController | null>(null);
  const fetching = useRef(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(
    () => () => {
      active.current?.abort();
      metadataRequest.current?.abort();
    },
    [],
  );
  const targetModule = field.relationship_target_module_id;
  const multiple = field.relationship_multiple_targets === true;
  const label = (id: string) =>
    targetLabel(
      records.find((record) => record.id === id),
      metadata,
      id,
    );
  const display = (id: string) =>
    label(id) === compactId(id)
      ? compactId(id)
      : `${label(id)} · ${compactId(id)}`;
  const hidden = new Set(
    edges
      .filter((edge) => edge.visibility === "hidden")
      .map((edge) => edge.target_record_id),
  );
  const options = records
    .filter(
      (record) =>
        !hidden.has(record.id) &&
        (!multiple ||
          !edges.some((edge) => edge.target_record_id === record.id)),
    )
    .map((record) => record.id);
  // An existing target outside the page remains selected, but unavailable links cannot be newly selected.
  if (!multiple && value && !options.includes(value)) options.unshift(value);
  if (!multiple) options.unshift("");

  async function loadPage() {
    if (!targetModule || fetching.current) return;
    fetching.current = true;
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    setError("");
    if (!started) {
      setStarted(true);
      metadataRequest.current = controller;
      void listAllModuleFields(targetModule)
        .then((fields) => {
          if (!controller.signal.aborted) setMetadata(fields);
        })
        .catch(() => {
          /* Record IDs remain available when metadata is not authorized. */
        });
    }
    try {
      const result = await apiFetch<ListResponse<RecordEntity>>(
        `/records?${listQuery({ module_id: targetModule, deleted: "exclude", limit: 100, offset, sort_by: "created_at", sort_order: "desc" })}`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setRecords((previous) => [
        ...new Map(
          [...previous, ...result.items].map((record) => [record.id, record]),
        ).values(),
      ]);
      setPageLoaded(true);
      setOffset(result.pagination.offset + result.items.length);
      setHasMore(result.pagination.has_more);
    } catch {
      if (!controller.signal.aborted) setError("Targets could not be loaded.");
    } finally {
      fetching.current = false;
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  return (
    <Combobox<string>
      items={options}
      value={value || null}
      inputValue={query}
      onInputValueChange={setQuery}
      disabled={disabled}
      filter={(id, search) =>
        `${label(id)} ${id}`
          .toLocaleLowerCase()
          .includes(search.toLocaleLowerCase())
      }
      onOpenChange={(open) => {
        if (open && !started) void loadPage();
      }}
      onValueChange={(id) => {
        if (id !== null) onValueChange(id);
      }}
    >
      <ComboboxTrigger
        id={`relationship-target-${field.id}`}
        aria-label={`${field.name} target`}
        title={value || undefined}
      >
        <span className="truncate">
          {value ? display(value) : multiple ? "Select a target" : "No target"}
        </span>
      </ComboboxTrigger>
      <ComboboxContent>
        <ComboboxInput
          ref={searchInputRef}
          aria-label={`Search loaded records for ${field.name}`}
          placeholder="Search loaded records"
        />
        <p role="status" className="text-muted-foreground text-xs">
          {loading
            ? "Loading targets…"
            : !pageLoaded
              ? "Targets unavailable"
              : `${records.length} records loaded${hasMore ? " · More available" : ""}`}
        </p>
        <ComboboxEmpty className="text-muted-foreground text-sm">
          {loading ? (
            <div className="p-2">Loading targets…</div>
          ) : !pageLoaded ? null : hasMore ? (
            <div className="p-2">
              No matches in loaded records. More records may exist; load more to
              continue.
            </div>
          ) : (
            <div className="p-2">No matching records.</div>
          )}
        </ComboboxEmpty>
        <ComboboxList className="max-h-60 overflow-y-auto">
          {(id: string) => (
            <ComboboxItem
              key={id || "none"}
              value={id}
              disabled={hidden.has(id)}
              title={id || undefined}
              aria-label={id ? `${display(id)} · ${id}` : "No target"}
            >
              {id ? display(id) : "No target"}
            </ComboboxItem>
          )}
        </ComboboxList>
        {error && <Alert variant="destructive">{error}</Alert>}
        {(hasMore || error) && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => {
              searchInputRef.current?.focus();
              void loadPage();
            }}
          >
            {error ? "Try loading targets again" : "Load more"}
          </Button>
        )}
      </ComboboxContent>
    </Combobox>
  );
}
