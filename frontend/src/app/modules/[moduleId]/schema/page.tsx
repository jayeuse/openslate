"use client";

import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CheckCircle2,
  Plus,
  Trash2,
} from "lucide-react";
import { useParams } from "next/navigation";
import { AppPage } from "@/components/app-page";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  apiFetch,
  listQuery,
  type Field,
  type FieldType,
  type ListResponse,
  type Module,
} from "@/lib/api";

const fieldTypes: FieldType[] = [
  "text",
  "number",
  "decimal",
  "int",
  "boolean",
  "date",
  "datetime",
  "select",
  "relationship",
];
export default function SchemaPage() {
  const { moduleId, departmentId } = useParams<{
    moduleId: string;
    departmentId?: string;
  }>();
  const modulePath = departmentId
    ? `/departments/${departmentId}/modules/${moduleId}`
    : `/modules/${moduleId}`;
  const [fields, setFields] = useState<Field[]>([]);
  const [modules, setModules] = useState<Module[]>([]);
  const [name, setName] = useState("");
  const [type, setType] = useState<FieldType>("text");
  const [required, setRequired] = useState(false);
  const [options, setOptions] = useState("");
  const [targetModuleId, setTargetModuleId] = useState("");
  const [multipleTargets, setMultipleTargets] = useState(false);
  const [multipleSources, setMultipleSources] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function load() {
    try {
      const current = await apiFetch<Module>(`/modules/${moduleId}`);
      const [result, moduleResult] = await Promise.all([
        apiFetch<ListResponse<Field>>(
          `/fields?${listQuery({ module_id: moduleId, limit: 100, deleted: "exclude", sort_by: "position", sort_order: "asc" })}`,
        ),
        apiFetch<ListResponse<Module>>(
          `/modules?${listQuery({ department_id: current.department_id, limit: 100, deleted: "exclude", sort_by: "created_at", sort_order: "asc" })}`,
        ),
      ]);
      setFields(result.items);
      setModules(moduleResult.items);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Fields could not be loaded",
      );
    }
  }
  useEffect(() => {
    void load();
  }, [moduleId]);
  async function addField(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    const config =
      type === "select"
        ? {
            options: options
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean),
          }
        : {};
    try {
      await apiFetch<Field>("/fields", {
        method: "POST",
        body: JSON.stringify({
          module_id: moduleId,
          name,
          type,
          required,
          position: fields.length,
          config,
          ...(type === "relationship"
            ? {
                relationship_target_module_id: targetModuleId,
                relationship_multiple_targets: multipleTargets,
                relationship_multiple_sources: multipleSources,
              }
            : {}),
        }),
      });
      setName("");
      setOptions("");
      setTargetModuleId("");
      setMultipleTargets(false);
      setMultipleSources(false);
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Field could not be added",
      );
    } finally {
      setSaving(false);
    }
  }
  async function reorder(index: number, direction: -1 | 1) {
    const next = [...fields];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setFields(next);
    try {
      await apiFetch(`/modules/${moduleId}/fields/reorder`, {
        method: "POST",
        body: JSON.stringify({ field_ids: next.map((field) => field.id) }),
      });
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Fields could not be reordered",
      );
      await load();
    }
  }
  async function removeField(field: Field) {
    if (
      !window.confirm(
        `Archive the ${field.name} field? Active records using it will block this action.`,
      )
    )
      return;
    try {
      await apiFetch(`/fields/${field.id}`, { method: "DELETE" });
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Field could not be archived",
      );
    }
  }
  const readiness =
    fields.length > 0 &&
    fields.every(
      (field, index) =>
        field.position === index &&
        (field.type !== "select" ||
          (Array.isArray(field.config.options) &&
            field.config.options.length > 0)),
    );
  return (
    <AppPage>
      <PageHeader
        eyebrow="Module / Schema"
        title="Field builder"
        description="Add the fields your records need. Changes that would invalidate active records are rejected by the API."
        actions={
          <Button asChild variant="ghost">
            <a href={modulePath}>
              <ArrowLeft size={16} /> Back to module
            </a>
          </Button>
        }
      />
      {error && (
        <Alert variant="destructive" className="mb-5">
          {error}
        </Alert>
      )}
      <div className="grid gap-5 lg:grid-cols-[1fr_0.45fr]">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Active fields</CardTitle>
              <Badge variant={readiness ? "success" : "warning"}>
                {readiness ? "Ready for review" : "Needs attention"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {fields.length === 0 && (
              <div className="text-muted-foreground p-8 text-sm">
                No fields yet. Add the first field using the form.
              </div>
            )}
            {fields.map((field, index) => (
              <div
                className="border-border flex items-center gap-3 border-b p-4 last:border-b-0"
                key={field.id}
              >
                <span className="text-muted-foreground w-5 text-center font-mono text-xs">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {field.name}{" "}
                    {field.required && (
                      <span className="text-destructive">*</span>
                    )}
                  </p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {field.type}
                    {field.type === "select" &&
                    Array.isArray(field.config.options) ? (
                      ` · ${field.config.options.length} options`
                    ) : field.type === "relationship" ? (
                      <>
                        {" · "}
                        <span>
                          {modules.find(
                            (item) =>
                              item.id === field.relationship_target_module_id,
                          )?.module_name ?? "Target module unavailable"}
                        </span>
                        {" · "}
                        <span>
                          {field.relationship_multiple_targets
                            ? "Multiple targets"
                            : "Single target"}
                        </span>
                        {" · "}
                        <span>
                          {field.relationship_multiple_sources
                            ? "Multiple sources"
                            : "Single source"}
                        </span>
                      </>
                    ) : (
                      ""
                    )}
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Move ${field.name} up`}
                    disabled={index === 0}
                    onClick={() => void reorder(index, -1)}
                  >
                    <ArrowUp size={15} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Move ${field.name} down`}
                    disabled={index === fields.length - 1}
                    onClick={() => void reorder(index, 1)}
                  >
                    <ArrowDown size={15} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Archive ${field.name}`}
                    onClick={() => void removeField(field)}
                  >
                    <Trash2 size={15} className="text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Add a field</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={addField}>
              <div className="space-y-2">
                <Label htmlFor="field-name">Field name</Label>
                <Input
                  id="field-name"
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. Account owner"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="field-type">Type</Label>
                <select
                  id="field-type"
                  className="border-input bg-card h-10 w-full rounded-[var(--radius)] border px-3 text-sm"
                  value={type}
                  onChange={(event) => {
                    const nextType = event.target.value as FieldType;
                    setType(nextType);
                    if (nextType === "relationship") setRequired(false);
                  }}
                >
                  {fieldTypes.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </div>
              {type === "select" && (
                <div className="space-y-2">
                  <Label htmlFor="field-options">Options</Label>
                  <Input
                    id="field-options"
                    required
                    placeholder="New, Active, Closed"
                    value={options}
                    onChange={(event) => setOptions(event.target.value)}
                  />
                  <p className="text-muted-foreground text-xs">
                    Enter unique values separated by commas.
                  </p>
                </div>
              )}
              {type === "relationship" && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="target-module">Target module</Label>
                    <select
                      id="target-module"
                      required
                      className="border-input bg-card h-10 w-full rounded-[var(--radius)] border px-3 text-sm"
                      value={targetModuleId}
                      onChange={(event) =>
                        setTargetModuleId(event.target.value)
                      }
                    >
                      <option value="">Select a module</option>
                      {modules.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.module_name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <fieldset
                    className="space-y-2"
                    aria-label="Targets per source"
                  >
                    <legend className="text-sm font-medium">
                      Targets per source
                    </legend>
                    <div className="flex gap-4 text-sm">
                      {[false, true].map((multiple) => (
                        <label
                          className="flex items-center gap-2"
                          key={String(multiple)}
                        >
                          <input
                            type="radio"
                            name="multiple-targets"
                            checked={multipleTargets === multiple}
                            onChange={() => setMultipleTargets(multiple)}
                          />
                          {multiple ? "Multiple" : "Single"}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <fieldset
                    className="space-y-2"
                    aria-label="Sources per target"
                  >
                    <legend className="text-sm font-medium">
                      Sources per target
                    </legend>
                    <div className="flex gap-4 text-sm">
                      {[false, true].map((multiple) => (
                        <label
                          className="flex items-center gap-2"
                          key={String(multiple)}
                        >
                          <input
                            type="radio"
                            name="multiple-sources"
                            checked={multipleSources === multiple}
                            onChange={() => setMultipleSources(multiple)}
                          />
                          {multiple ? "Multiple" : "Single"}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </>
              )}
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={required}
                  disabled={type === "relationship"}
                  onChange={(event) => setRequired(event.target.checked)}
                />{" "}
                Required field
              </label>
              <Button className="w-full" disabled={saving}>
                <Plus size={16} />
                {saving ? "Adding…" : "Add field"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
      <Alert
        variant={readiness ? "success" : "warning"}
        className="mt-5 flex items-start gap-3"
      >
        <CheckCircle2 size={17} className="mt-0.5 shrink-0" />
        <div>
          <p className="font-semibold">
            {readiness
              ? "Schema is ready for a first record"
              : "Complete the schema before adding records"}
          </p>
          <p className="mt-1">
            The readiness review is computed in the frontend. The backend still
            validates every record against active fields.
          </p>
        </div>
      </Alert>
    </AppPage>
  );
}
