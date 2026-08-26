"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  apiFetch,
  listQuery,
  type Field,
  type ListResponse,
  type RecordEntity,
  type Relationship,
} from "@/lib/api";

type RelationshipManagerProps = {
  moduleId: string;
  recordId: string;
  fields: Field[];
};

function compactRecordId(recordId: string) {
  return `${recordId.slice(0, 8)}…`;
}

function humanizeHiddenReason(reason: string) {
  return reason
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function RelationshipManager({
  moduleId,
  recordId,
  fields,
}: RelationshipManagerProps) {
  const relationshipFields = fields.filter(
    (field) => field.type === "relationship",
  );
  const [outgoing, setOutgoing] = useState<Relationship[]>([]);
  const [incoming, setIncoming] = useState<Relationship[]>([]);
  const [targetRecords, setTargetRecords] = useState<
    Record<string, RecordEntity[]>
  >({});
  const [selectedTargets, setSelectedTargets] = useState<
    Record<string, string>
  >({});
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [outgoingResult, incomingResult] = await Promise.all([
        apiFetch<ListResponse<Relationship>>(
          `/relationships?${listQuery({ source_record_id: recordId, availability: "all", deleted: "exclude", limit: 100 })}`,
        ),
        apiFetch<ListResponse<Relationship>>(
          `/relationships?${listQuery({ target_record_id: recordId, availability: "all", deleted: "exclude", limit: 100 })}`,
        ),
      ]);
      const targetModuleIds = [
        ...new Set(
          relationshipFields
            .map((field) => field.relationship_target_module_id)
            .filter((targetModuleId): targetModuleId is string =>
              Boolean(targetModuleId),
            ),
        ),
      ];
      const targetResults = await Promise.all(
        targetModuleIds.map(async (targetModuleId) => {
          const result = await apiFetch<ListResponse<RecordEntity>>(
            `/records?${listQuery({ module_id: targetModuleId, deleted: "exclude", limit: 100, sort_by: "created_at", sort_order: "desc" })}`,
          );
          return [targetModuleId, result.items] as const;
        }),
      );
      setOutgoing(outgoingResult.items);
      setIncoming(incomingResult.items);
      setTargetRecords(Object.fromEntries(targetResults));
      setSelectedTargets({});
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Relationships could not be loaded",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
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

  function recordsForField(field: Field) {
    const records =
      targetRecords[field.relationship_target_module_id ?? ""] ?? [];
    const linkedIds = outgoing
      .filter((edge) => edge.field_id === field.id)
      .map((edge) => edge.target_record_id);
    const knownIds = new Set(records.map((record) => record.id));
    return [
      ...records.map((record) => ({
        id: record.id,
        label: compactRecordId(record.id),
      })),
      ...linkedIds
        .filter((targetRecordId) => !knownIds.has(targetRecordId))
        .map((targetRecordId) => ({
          id: targetRecordId,
          label: compactRecordId(targetRecordId),
        })),
    ];
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
      className="space-y-4"
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
      {loading ? (
        <p className="text-muted-foreground text-sm">Loading relationships…</p>
      ) : (
        <div className="space-y-4">
          {relationshipFields.map((field) => {
            const edges = outgoing.filter((edge) => edge.field_id === field.id);
            const current = edges[0]?.target_record_id ?? "";
            const multiple = field.relationship_multiple_targets === true;
            const options = recordsForField(field);
            const selectableOptions = multiple
              ? options.filter(
                  (option) =>
                    !edges.some((edge) => edge.target_record_id === option.id),
                )
              : options;
            return (
              <fieldset
                className="border-border rounded-[var(--radius)] border p-4"
                key={field.id}
              >
                <legend className="px-1 font-medium">{field.name}</legend>
                {multiple ? (
                  <div className="space-y-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                      <div className="min-w-0 flex-1 space-y-2">
                        <label
                          htmlFor={`relationship-target-${field.id}`}
                          className="text-sm"
                        >
                          Add target
                        </label>
                        <select
                          id={`relationship-target-${field.id}`}
                          aria-label={`${field.name} target`}
                          className="border-input bg-card h-10 w-full rounded-[var(--radius)] border px-3 text-sm"
                          value={selectedTargets[field.id] ?? ""}
                          disabled={pending !== null}
                          onChange={(event) =>
                            setSelectedTargets({
                              ...selectedTargets,
                              [field.id]: event.target.value,
                            })
                          }
                        >
                          <option value="">Select a target</option>
                          {selectableOptions.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={
                          !selectedTargets[field.id] || pending !== null
                        }
                        onClick={() => void addMultiple(field)}
                      >
                        Add link
                      </Button>
                    </div>
                    <ul
                      className="space-y-2"
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
                          <span>{compactRecordId(edge.target_record_id)}</span>
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
                            disabled={pending !== null}
                            onClick={() => void unlink(edge)}
                          >
                            Unlink
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <label
                      htmlFor={`relationship-target-${field.id}`}
                      className="text-sm"
                    >
                      Target
                    </label>
                    <select
                      id={`relationship-target-${field.id}`}
                      aria-label={`${field.name} target`}
                      className="border-input bg-card h-10 w-full rounded-[var(--radius)] border px-3 text-sm"
                      value={current}
                      disabled={pending !== null}
                      onChange={(event) =>
                        void assignSingle(field, event.target.value)
                      }
                    >
                      <option value="">No target</option>
                      {options.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                    {edges.some((edge) => edge.visibility === "hidden") && (
                      <div className="text-muted-foreground space-y-1 text-xs">
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
                            disabled={pending !== null}
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
              <ul className="mt-3 space-y-2">
                {unavailableOutgoing.map((edge) => (
                  <li
                    className="flex items-center justify-between gap-3 text-sm"
                    key={edge.id}
                  >
                    <span>
                      {compactRecordId(edge.target_record_id)} · field{" "}
                      {compactRecordId(edge.field_id)}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={pending !== null}
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
      )}
      <section
        aria-label="Incoming links"
        className="border-border rounded-[var(--radius)] border p-4"
      >
        <h3 className="font-medium">Incoming links</h3>
        <p className="text-muted-foreground mt-1 text-sm">
          Other records linking to this record.
        </p>
        {incoming.length === 0 ? (
          <p className="text-muted-foreground mt-3 text-sm">
            No incoming links.
          </p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {incoming.map((edge) => (
              <li key={edge.id}>
                {compactRecordId(edge.source_record_id)}
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
