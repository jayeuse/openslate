"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, Save } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import type { Route } from "next";
import { PageHeader } from "@/components/page-header";
import { RelationshipManager } from "@/components/relationship-manager";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTimeLocal } from "@/lib/date-time";
import {
  apiFetch,
  getApiFieldErrors,
  listAllModuleFields,
  type Field,
  type Department,
  type Module,
  type RecordEntity,
} from "@/lib/api";
import {
  buildModuleSchema,
  collectZodFieldErrors,
  serializeFormValues,
  type FieldErrorMap,
} from "@/lib/field-schema";

function editValue(field: Field, value: unknown): string | boolean {
  if (field.type === "boolean") return value === true;
  if (field.type === "datetime") return formatDateTimeLocal(value);
  return value === null || value === undefined ? "" : String(value);
}
export default function EditRecordPage() {
  const { moduleId, recordId, departmentId } = useParams<{
    moduleId: string;
    recordId: string;
    departmentId?: string;
  }>();
  const router = useRouter();
  const [module, setModule] = useState<Module | null>(null);
  const [department, setDepartment] = useState<Department | null>(null);
  const [fields, setFields] = useState<Field[]>([]);
  const [record, setRecord] = useState<RecordEntity | null>(null);
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [fieldErrors, setFieldErrors] = useState<FieldErrorMap>({});
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const modulePath = departmentId
    ? `/departments/${departmentId}/modules/${moduleId}`
    : `/modules/${moduleId}`;
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const [current, fieldResult, currentRecord] = await Promise.all([
          apiFetch<Module>(`/modules/${moduleId}`),
          listAllModuleFields(moduleId),
          apiFetch<RecordEntity>(`/records/${recordId}`),
        ]);
        const parent = await apiFetch<Department>(
          `/departments/${current.department_id}`,
        );
        if (!active) return;
        setModule(current);
        setDepartment(parent);
        setFields(fieldResult);
        setRecord(currentRecord);
        setValues(
          Object.fromEntries(
            fieldResult
              .filter((field) => field.type !== "relationship")
              .map((field) => [
                field.id,
                editValue(field, currentRecord.data[field.id]),
              ]),
          ),
        );
      } catch (reason) {
        if (!active) return;
        setError(
          reason instanceof Error
            ? reason.message
            : "Record could not be loaded",
        );
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [moduleId, recordId]);
  const primitiveFields = fields.filter(
    (field) => field.type !== "relationship",
  );
  const activePrimitiveFields = primitiveFields.filter(
    (field) => !field.is_deleted,
  );
  const relationshipFields = fields.filter(
    (field) => field.type === "relationship",
  );
  const sourceClosed =
    module?.is_deleted === true ||
    department?.is_deleted === true ||
    record?.is_deleted === true;
  const unassignedErrors = Object.entries(fieldErrors)
    .filter(
      ([fieldId]) => !primitiveFields.some((field) => field.id === fieldId),
    )
    .flatMap(([, messages]) => messages);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setFieldErrors({});
    try {
      const data = serializeFormValues(activePrimitiveFields, values);
      const validation = buildModuleSchema(activePrimitiveFields).safeParse(
        data,
      );
      if (!validation.success) {
        const validationErrors = collectZodFieldErrors(validation.error);
        setFieldErrors(validationErrors.fieldErrors);
        setError(
          validationErrors.formErrors.length > 0
            ? validationErrors.formErrors.join(" ")
            : "Please correct the highlighted fields.",
        );
        return;
      }
      await apiFetch(`/records/${recordId}`, {
        method: "PATCH",
        body: JSON.stringify({ data: validation.data }),
      });
      router.push(`${modulePath}/records` as Route);
    } catch (reason) {
      setFieldErrors(getApiFieldErrors(reason));
      setError(
        reason instanceof Error ? reason.message : "Record could not be saved",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow={`Record / ${module?.module_name ?? "Edit"}`}
        title="Edit record"
        description="Update primitive fields here. Relationship links are managed separately below."
        actions={
          <Button asChild variant="ghost">
            <a href={`${modulePath}/records`}>
              <ArrowLeft size={16} /> Records
            </a>
          </Button>
        }
      />
      {record?.is_deleted && (
        <Badge variant="warning" className="mb-5">
          Archived
        </Badge>
      )}
      {module?.is_deleted && (
        <Badge variant="warning" className="mb-5">
          Module closed
        </Badge>
      )}
      {(error || unassignedErrors.length > 0) && (
        <Alert variant="destructive" className="mb-5">
          {error && <p>{error}</p>}
          {unassignedErrors.map((message, index) => (
            <p key={`${message}-${index}`}>{message}</p>
          ))}
        </Alert>
      )}
      <Card className="max-w-3xl">
        <CardContent className="p-6">
          <form className="space-y-6" noValidate onSubmit={submit}>
            {primitiveFields.map((field) => (
              <div className="space-y-2" key={field.id}>
                <Label htmlFor={field.id}>
                  {field.name}{" "}
                  {field.required && (
                    <span className="text-destructive">*</span>
                  )}
                </Label>
                {field.type === "boolean" ? (
                  <label className="flex h-10 items-center gap-2 text-sm">
                    <input
                      id={field.id}
                      type="checkbox"
                      checked={Boolean(values[field.id])}
                      disabled={sourceClosed || field.is_deleted}
                      onChange={(event) =>
                        setValues((current) => ({
                          ...current,
                          [field.id]: event.target.checked,
                        }))
                      }
                    />{" "}
                    Yes
                  </label>
                ) : field.type === "select" ? (
                  <select
                    id={field.id}
                    required={field.required}
                    disabled={sourceClosed || field.is_deleted}
                    className="border-input bg-card h-10 w-full rounded-[var(--radius)] border px-3 text-sm"
                    value={String(values[field.id] ?? "")}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        [field.id]: event.target.value,
                      }))
                    }
                  >
                    <option value="">Select an option</option>
                    {Array.isArray(field.config.options) &&
                      field.config.options.map((option) => (
                        <option key={String(option)} value={String(option)}>
                          {String(option)}
                        </option>
                      ))}
                  </select>
                ) : (
                  <Input
                    id={field.id}
                    required={field.required}
                    type={
                      field.type === "date"
                        ? "date"
                        : field.type === "datetime"
                          ? "datetime-local"
                          : field.type === "number" || field.type === "int"
                            ? "number"
                            : field.type === "decimal"
                              ? "text"
                              : "text"
                    }
                    inputMode={field.type === "decimal" ? "decimal" : undefined}
                    maxLength={field.type === "decimal" ? 58 : undefined}
                    value={String(values[field.id] ?? "")}
                    disabled={sourceClosed || field.is_deleted}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        [field.id]: event.target.value,
                      }))
                    }
                  />
                )}
                {fieldErrors[field.id]?.map((message, index) => (
                  <p
                    className="text-destructive text-xs"
                    key={`${message}-${index}`}
                    role="alert"
                  >
                    {message}
                  </p>
                ))}
              </div>
            ))}
            <div className="border-border flex justify-end border-t pt-5">
              <Button disabled={pending || sourceClosed}>
                <Save size={16} />
                {pending ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
      <Card className="mt-5 max-w-3xl">
        <CardContent className="p-6">
          <RelationshipManager
            moduleId={moduleId}
            recordId={recordId}
            fields={relationshipFields}
            sourceReadOnly={sourceClosed}
          />
        </CardContent>
      </Card>
    </>
  );
}
