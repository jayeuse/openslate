"use client";

import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CheckCircle2,
  Plus,
} from "lucide-react";
import { useParams } from "next/navigation";
import { LifecycleAction } from "@/components/lifecycle-dialog";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ApiError,
  apiFetch,
  listQuery,
  type Field,
  type FieldType,
  type Department,
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

type SchemaMutation =
  | { kind: "add" }
  | { kind: "reorder" }
  | { kind: "accept" }
  | { kind: "audit-redaction"; fieldId: string };

type SchemaErrorContext = "load" | "add" | "reorder" | "audit" | "accept";

function safeErrorMessage(reason: unknown, context: SchemaErrorContext) {
  if (reason instanceof ApiError) {
    switch (reason.status) {
      case 401:
        return "Your session expired. Sign in again.";
      case 403:
        return "Administrator access is required to manage this schema.";
      case 404:
        return "This module or schema is no longer available. Refresh and try again.";
      case 409:
        return "This schema conflicts with current data. Refresh and try again.";
      case 422:
        if (context === "accept") {
          return "The schema is not ready to be accepted. Complete the required fields and try again.";
        }
        if (context === "reorder") {
          return "The field order was rejected. Refresh and try again.";
        }
        if (context === "audit") {
          return "The audit redaction change was rejected. Refresh and try again.";
        }
        return "The field details were rejected. Check the values and try again.";
      case 502:
      case 503:
        return "The schema service is temporarily unavailable. Try again.";
      default:
        break;
    }
  }
  switch (context) {
    case "load":
      return "Fields could not be loaded. Refresh and try again.";
    case "add":
      return "The field could not be added. Check the values and try again.";
    case "reorder":
      return "Fields could not be reordered. Refresh and try again.";
    case "audit":
      return "Audit redaction could not be updated. Refresh and try again.";
    case "accept":
      return "Schema could not be accepted. Complete the fields and try again.";
  }
}

export default function SchemaPage() {
  const { moduleId, departmentId } = useParams<{
    moduleId: string;
    departmentId?: string;
  }>();
  const modulePath = departmentId
    ? `/departments/${departmentId}/modules/${moduleId}`
    : `/modules/${moduleId}`;
  const [module, setModule] = useState<Module | null>(null);
  const [department, setDepartment] = useState<Department | null>(null);
  const [fields, setFields] = useState<Field[]>([]);
  const [modules, setModules] = useState<Module[]>([]);
  const [name, setName] = useState("");
  const [type, setType] = useState<FieldType>("text");
  const [required, setRequired] = useState(false);
  const [auditRedacted, setAuditRedacted] = useState(false);
  const [options, setOptions] = useState("");
  const [targetModuleId, setTargetModuleId] = useState("");
  const [multipleTargets, setMultipleTargets] = useState(false);
  const [multipleSources, setMultipleSources] = useState(false);
  const [error, setError] = useState("");
  const [mutationBusy, setMutationBusy] = useState<SchemaMutation | null>(null);
  async function load() {
    try {
      const current = await apiFetch<Module>(`/modules/${moduleId}`);
      const [parent, result, moduleResult] = await Promise.all([
        apiFetch<Department>(`/departments/${current.department_id}`),
        apiFetch<ListResponse<Field>>(
          `/fields?${listQuery({ module_id: moduleId, limit: 100, deleted: "include", sort_by: "position", sort_order: "asc" })}`,
        ),
        apiFetch<ListResponse<Module>>(
          `/modules?${listQuery({ department_id: current.department_id, limit: 100, deleted: "exclude", sort_by: "created_at", sort_order: "asc" })}`,
        ),
      ]);
      setModule(current);
      setDepartment(parent);
      setFields(result.items);
      setModules(moduleResult.items);
    } catch (reason) {
      setError(safeErrorMessage(reason, "load"));
    }
  }
  useEffect(() => {
    void load();
  }, [moduleId]);
  async function addField(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutationBusy !== null) return;
    setMutationBusy({ kind: "add" });
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
          audit_redacted: auditRedacted,
          position: fields.filter((field) => !field.is_deleted).length,
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
      setAuditRedacted(false);
      await load();
    } catch (reason) {
      setError(safeErrorMessage(reason, "add"));
    } finally {
      setMutationBusy(null);
    }
  }
  async function toggleAuditRedaction(field: Field) {
    if (mutationBusy !== null) return;
    const nextAuditRedacted = !field.audit_redacted;
    setMutationBusy({ kind: "audit-redaction", fieldId: field.id });
    setError("");
    try {
      await apiFetch<Field>(`/fields/${field.id}`, {
        method: "PATCH",
        body: JSON.stringify({ audit_redacted: nextAuditRedacted }),
      });
    } catch (reason) {
      setError(safeErrorMessage(reason, "audit"));
    } finally {
      await load();
      setMutationBusy(null);
    }
  }
  async function reorder(fieldId: string, direction: -1 | 1) {
    if (mutationBusy !== null) return;
    const activeFields = fields.filter((field) => !field.is_deleted);
    const index = activeFields.findIndex((field) => field.id === fieldId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= activeFields.length) return;
    const nextActiveFields = [...activeFields];
    [nextActiveFields[index], nextActiveFields[target]] = [
      nextActiveFields[target],
      nextActiveFields[index],
    ];
    let activeIndex = 0;
    const next = fields.map((field) =>
      field.is_deleted ? field : nextActiveFields[activeIndex++],
    );
    setMutationBusy({ kind: "reorder" });
    setError("");
    setFields(next);
    try {
      const reorderedFields = await apiFetch<Field[]>(
        `/modules/${moduleId}/fields/reorder`,
        {
          method: "POST",
          body: JSON.stringify({
            field_ids: nextActiveFields.map((field) => field.id),
          }),
        },
      );
      const fieldsById = new Map(
        reorderedFields.map((field) => [field.id, field]),
      );
      setFields((current) =>
        current.map((field) =>
          field.is_deleted ? field : (fieldsById.get(field.id) ?? field),
        ),
      );
    } catch (reason) {
      setError(safeErrorMessage(reason, "reorder"));
      await load();
    } finally {
      setMutationBusy(null);
    }
  }
  async function acceptSchema() {
    if (mutationBusy !== null) return;
    setMutationBusy({ kind: "accept" });
    setError("");
    try {
      const current = await apiFetch<Module>(
        `/modules/${moduleId}/schema/accept`,
        { method: "POST" },
      );
      setModule(current);
    } catch (reason) {
      setError(safeErrorMessage(reason, "accept"));
    } finally {
      setMutationBusy(null);
    }
  }
  const activeFields = fields.filter((field) => !field.is_deleted);
  const readiness =
    activeFields.length > 0 &&
    activeFields.every(
      (field, index) =>
        field.position === index &&
        (field.type !== "select" ||
          (Array.isArray(field.config.options) &&
            field.config.options.length > 0)),
    );
  const mutationsDisabled =
    module?.is_deleted === true || department?.is_deleted === true;
  const schemaMutationBusy = mutationBusy !== null;
  const auditMutationFieldId =
    mutationBusy?.kind === "audit-redaction" ? mutationBusy.fieldId : null;
  return (
    <>
      <PageHeader
        eyebrow="Module / Schema"
        title="Field builder"
        description="Add the fields your records need. Changes that would invalidate active records are rejected by the API."
        actions={
          <>
            <Button
              disabled={
                mutationsDisabled ||
                schemaMutationBusy ||
                activeFields.length === 0 ||
                module?.is_schema_accepted === true
              }
              onClick={() => void acceptSchema()}
            >
              <CheckCircle2 size={16} />
              {mutationBusy?.kind === "accept" ? "Accepting…" : "Accept Schema"}
            </Button>
            <Button asChild variant="ghost">
              <a href={modulePath}>
                <ArrowLeft size={16} /> Back to module
              </a>
            </Button>
          </>
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
              <Badge
                variant={
                  module?.is_deleted
                    ? "warning"
                    : module?.is_schema_accepted
                      ? "success"
                      : "warning"
                }
              >
                {module?.is_deleted
                  ? "Closed"
                  : module
                    ? module.is_schema_accepted
                      ? "Schema accepted"
                      : "Schema unaccepted"
                    : "Loading schema"}
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
                className="border-border flex flex-wrap items-start gap-3 border-b p-4 last:border-b-0"
                data-schema-field-id={field.id}
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
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Badge
                      variant={field.audit_redacted ? "warning" : "outline"}
                    >
                      Audit redaction: {field.audit_redacted ? "On" : "Off"}
                    </Badge>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11"
                      aria-label={`${field.audit_redacted ? "Disable" : "Enable"} audit redaction for ${field.name}`}
                      disabled={
                        mutationsDisabled ||
                        field.is_deleted ||
                        schemaMutationBusy
                      }
                      onClick={() => void toggleAuditRedaction(field)}
                    >
                      {auditMutationFieldId === field.id
                        ? "Saving…"
                        : field.audit_redacted
                          ? "Disable"
                          : "Enable"}{" "}
                      audit redaction
                    </Button>
                  </div>
                </div>
                {field.is_deleted && <Badge variant="warning">Closed</Badge>}
                <div className="ml-auto flex w-full justify-end gap-1 sm:w-auto">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Move ${field.name} up`}
                    disabled={
                      mutationsDisabled ||
                      field.is_deleted ||
                      schemaMutationBusy ||
                      activeFields.findIndex((item) => item.id === field.id) ===
                        0
                    }
                    onClick={() => void reorder(field.id, -1)}
                  >
                    <ArrowUp size={15} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Move ${field.name} down`}
                    disabled={
                      mutationsDisabled ||
                      field.is_deleted ||
                      schemaMutationBusy ||
                      activeFields.findIndex((item) => item.id === field.id) ===
                        activeFields.length - 1
                    }
                    onClick={() => void reorder(field.id, 1)}
                  >
                    <ArrowDown size={15} />
                  </Button>
                  <details
                    className="border-destructive/30 bg-destructive/5 rounded-[var(--radius)] border"
                    data-testid={`field-lifecycle-${field.id}`}
                  >
                    <summary className="text-destructive cursor-pointer px-2 py-1 text-xs font-medium">
                      Danger zone
                    </summary>
                    <div className="border-destructive/20 flex flex-wrap gap-2 border-t p-2">
                      <LifecycleAction
                        targetType="field"
                        targetId={field.id}
                        targetName={field.name}
                        isClosed={field.is_deleted}
                        onComplete={load}
                      />
                    </div>
                  </details>
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
                  disabled={mutationsDisabled || schemaMutationBusy}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. Account owner"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="field-type">Type</Label>
                <select
                  id="field-type"
                  disabled={mutationsDisabled || schemaMutationBusy}
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
                    disabled={mutationsDisabled || schemaMutationBusy}
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
                      disabled={mutationsDisabled || schemaMutationBusy}
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
                            disabled={mutationsDisabled || schemaMutationBusy}
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
                            disabled={mutationsDisabled || schemaMutationBusy}
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
                  disabled={
                    mutationsDisabled ||
                    schemaMutationBusy ||
                    type === "relationship"
                  }
                  onChange={(event) => setRequired(event.target.checked)}
                />{" "}
                Required field
              </label>
              <div className="flex items-start gap-3">
                <input
                  id="field-audit-redacted"
                  type="checkbox"
                  className="mt-1 size-4 shrink-0"
                  checked={auditRedacted}
                  disabled={mutationsDisabled || schemaMutationBusy}
                  aria-describedby="field-audit-redacted-help"
                  onChange={(event) => setAuditRedacted(event.target.checked)}
                />
                <div className="space-y-1">
                  <Label
                    htmlFor="field-audit-redacted"
                    className="cursor-pointer"
                  >
                    Redact values in future audit snapshots
                  </Label>
                  <p
                    id="field-audit-redacted-help"
                    className="text-muted-foreground text-xs leading-5"
                  >
                    When enabled, values remain in records, but future audit
                    snapshots are masked. Stored record values and historical
                    audit logs are unchanged.
                  </p>
                </div>
              </div>
              <Button
                className="w-full"
                disabled={schemaMutationBusy || mutationsDisabled}
              >
                <Plus size={16} />
                {mutationBusy?.kind === "add" ? "Adding…" : "Add field"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
      <Alert
        variant={module?.is_schema_accepted ? "success" : "warning"}
        className="mt-5 flex items-start gap-3"
      >
        <CheckCircle2 size={17} className="mt-0.5 shrink-0" />
        <div>
          <p className="font-semibold">
            {module?.is_schema_accepted
              ? "Schema is accepted"
              : "Schema is unaccepted"}
          </p>
          <p className="mt-1">
            {module?.is_schema_accepted
              ? "The backend has accepted this schema. Records can be created until a schema change invalidates it."
              : readiness
                ? "Preflight hint: the active fields look complete. Accept the schema to enable records."
                : "Preflight hint: complete the active fields, then accept the schema to enable records."}
          </p>
        </div>
      </Alert>
    </>
  );
}
