"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { FieldGroup, FieldSet, FieldLegend } from "@/components/ui/field";
import type { Field } from "@/lib/api";
import {
  queryOperators,
  queryValue,
  type QueryDefinition,
} from "@/lib/record-query";
import { datetimeInputToUtc, datetimeOffsets } from "@/lib/date-time";
const operatorLabels: Record<string, string> = {
  eq: "Equals",
  empty: "Is empty",
  not_empty: "Is not empty",
  contains: "Contains",
  prefix: "Starts with",
  lt: "Less than",
  lte: "At most",
  gt: "Greater than",
  gte: "At least",
  in: "Is one of",
};
export function RecordQueryEditor({
  fields,
  definition,
  onChange,
  timezone,
}: {
  fields: Field[];
  definition: QueryDefinition;
  onChange: (value: QueryDefinition) => void;
  timezone: string;
}) {
  const [draftTimezone, setDraftTimezone] = useState(timezone);
  const [selected, setSelected] = useState("");
  const [operator, setOperator] = useState("eq");
  const [value, setValue] = useState("");
  const [offset, setOffset] = useState("");
  const [error, setError] = useState("");
  const field = fields.find((f) => f.id === selected);
  const primitive = fields.filter((f) => f.type !== "relationship");
  let offsets: string[] = [];
  if (field?.type === "datetime" && value) {
    try {
      offsets = datetimeOffsets(value, draftTimezone);
    } catch {}
  }
  const label = (id: string) => {
    const f = fields.find((item) => item.id === id);
    return f
      ? `${f.name}${f.is_deleted ? " (archived)" : ""}`
      : `Unavailable field ${id}`;
  };
  return (
    <details className="border-border mb-5 rounded-md border p-4">
      <summary className="cursor-pointer font-medium">
        Filters, sorting and columns
      </summary>
      <FieldGroup className="mt-4">
        <FieldSet>
          <FieldLegend>
            All filters must match ({definition.filters.length}/10)
          </FieldLegend>
          {definition.filters.map((filter, index) => (
            <div
              key={`${filter.field_id}-${index}`}
              className="flex flex-wrap items-center gap-2"
            >
              <span>
                {label(filter.field_id)} · {filter.operator} ·{" "}
                {String(filter.value ?? "")}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  onChange({
                    ...definition,
                    filters: definition.filters.filter((_, i) => i !== index),
                  })
                }
              >
                Remove filter {index + 1}
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Select
              aria-label="Filter field"
              value={selected}
              onValueChange={(v) => {
                setSelected(v);
                setOperator("eq");
                setValue("");
                setOffset("");
              }}
            >
              <option value="">Choose field</option>
              {primitive.map((f) => (
                <option key={f.id} value={f.id}>
                  {label(f.id)}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Filter operator"
              value={operator}
              onValueChange={setOperator}
            >
              {queryOperators(field?.type ?? "text").map((op) => (
                <option key={op} value={op}>
                  {operatorLabels[op] ?? op}
                </option>
              ))}
            </Select>
            {!operator.includes("empty") &&
              (field?.type === "boolean" ? (
                <Select
                  aria-label="Filter value"
                  value={value}
                  onValueChange={setValue}
                >
                  <option value="">Choose value</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </Select>
              ) : (
                <Input
                  aria-label="Filter value"
                  type={
                    field?.type === "datetime"
                      ? "datetime-local"
                      : field?.type === "date"
                        ? "date"
                        : "text"
                  }
                  value={value}
                  onChange={(e) => {
                    setValue(e.target.value);
                    setOffset("");
                  }}
                  placeholder={
                    operator === "in" ? "Comma-separated values" : "Value"
                  }
                />
              ))}
            {field?.type === "datetime" && (
              <span className="text-muted-foreground text-sm">
                Timezone: {draftTimezone}
              </span>
            )}
            {offsets.length > 1 && (
              <Select
                aria-label="Filter UTC offset"
                value={offset}
                onValueChange={setOffset}
              >
                <option value="">Choose offset for repeated time</option>
                {offsets.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
            )}
            <Button
              variant="outline"
              disabled={
                !field ||
                definition.filters.length >= 10 ||
                (field.type === "datetime" && draftTimezone !== timezone)
              }
              onClick={() => {
                if (!field) return;
                try {
                  const converted =
                    field.type === "datetime" && !operator.includes("empty")
                      ? datetimeInputToUtc(
                          value,
                          draftTimezone,
                          offset || undefined,
                        )
                      : queryValue(field.type, operator, value);
                  onChange({
                    ...definition,
                    filters: [
                      ...definition.filters,
                      {
                        field_id: field.id,
                        expected_type: field.type,
                        operator,
                        value: converted,
                      },
                    ],
                  });
                  setError("");
                } catch (reason) {
                  setError(
                    reason instanceof Error
                      ? reason.message
                      : "Invalid filter value",
                  );
                }
              }}
            >
              Add filter
            </Button>
          </div>
          {draftTimezone !== timezone && (
            <p role="alert">
              Workspace timezone changed. Your filter input remains in{" "}
              {draftTimezone}.{" "}
              <Button
                variant="outline"
                onClick={() => {
                  setValue("");
                  setOffset("");
                  setDraftTimezone(timezone);
                }}
              >
                Clear input and use {timezone}
              </Button>
            </p>
          )}
          {error && <p role="alert">{error}</p>}
        </FieldSet>
        <FieldSet>
          <FieldLegend>Sort order ({definition.sort.length}/3)</FieldLegend>
          {definition.sort.map((sort, index) => (
            <div key={sort.field_id} className="flex items-center gap-2">
              <span>{label(sort.field_id)}</span>
              <Select
                aria-label={`Sort direction ${index + 1}`}
                value={sort.direction}
                onValueChange={(v) =>
                  onChange({
                    ...definition,
                    sort: definition.sort.map((s, i) =>
                      i === index
                        ? { ...s, direction: v === "desc" ? "desc" : "asc" }
                        : s,
                    ),
                  })
                }
              >
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </Select>
              <Button
                variant="ghost"
                onClick={() =>
                  onChange({
                    ...definition,
                    sort: definition.sort.filter((_, i) => i !== index),
                  })
                }
              >
                Remove sort {index + 1}
              </Button>
            </div>
          ))}
          <Select
            aria-label="Add sort field"
            value=""
            disabled={definition.sort.length >= 3}
            onValueChange={(id) => {
              const f = primitive.find((f) => f.id === id);
              if (f)
                onChange({
                  ...definition,
                  sort: [
                    ...definition.sort,
                    { field_id: id, expected_type: f.type, direction: "asc" },
                  ],
                });
            }}
          >
            <option value="">Add sort field</option>
            {primitive
              .filter((f) => !definition.sort.some((s) => s.field_id === f.id))
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {label(f.id)}
                </option>
              ))}
          </Select>
        </FieldSet>
        <FieldSet>
          <FieldLegend>
            Visible columns ({definition.columns.length}/100)
          </FieldLegend>
          <div className="flex flex-wrap gap-4">
            {primitive.map((f) => (
              <label key={f.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={definition.columns.some((c) => c.field_id === f.id)}
                  disabled={
                    definition.columns.length >= 100 &&
                    !definition.columns.some((c) => c.field_id === f.id)
                  }
                  onChange={(e) =>
                    onChange({
                      ...definition,
                      columns: e.target.checked
                        ? [
                            ...definition.columns,
                            { field_id: f.id, expected_type: f.type },
                          ]
                        : definition.columns.filter((c) => c.field_id !== f.id),
                    })
                  }
                />
                {label(f.id)}
              </label>
            ))}
          </div>
          {definition.columns
            .filter((c) => !fields.some((f) => f.id === c.field_id))
            .map((c) => (
              <Button
                key={c.field_id}
                variant="outline"
                onClick={() =>
                  onChange({
                    ...definition,
                    columns: definition.columns.filter((item) => item !== c),
                  })
                }
              >
                Remove unavailable column {c.field_id}
              </Button>
            ))}
        </FieldSet>
      </FieldGroup>
    </details>
  );
}
