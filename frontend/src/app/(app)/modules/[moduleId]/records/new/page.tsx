"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, Save } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import type { Route } from "next";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

function initialValue(field: Field): string | boolean {
  return field.type === "boolean" ? false : "";
}

export default function NewRecordPage() {
  const { moduleId, departmentId } = useParams<{
    moduleId: string;
    departmentId?: string;
  }>();
  const router = useRouter();
  const [module, setModule] = useState<Module | null>(null);
  const [department, setDepartment] = useState<Department | null>(null);
  const [fields, setFields] = useState<Field[]>([]);
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
        const current = await apiFetch<Module>(`/modules/${moduleId}`);
        const [parent, result] = await Promise.all([
          apiFetch<Department>(`/departments/${current.department_id}`),
          listAllModuleFields(moduleId),
        ]);
        if (!active) return;
        setModule(current);
        setDepartment(parent);
        setFields(result);
        setValues(
          Object.fromEntries(
            result
              .filter(
                (field) => !field.is_deleted && field.type !== "relationship",
              )
              .map((field) => [field.id, initialValue(field)]),
          ),
        );
      } catch (reason) {
        if (!active) return;
        setError(
          reason instanceof Error
            ? reason.message
            : "Module schema could not be loaded",
        );
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [moduleId]);
  const primitiveFields = fields.filter(
    (field) => !field.is_deleted && field.type !== "relationship",
  );
  const sourceReadOnly =
    module?.is_deleted === true || department?.is_deleted === true;
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
      const data = serializeFormValues(primitiveFields, values);
      const validation = buildModuleSchema(primitiveFields).safeParse(data);
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
      const record = await apiFetch<RecordEntity>("/records", {
        method: "POST",
        body: JSON.stringify({ module_id: moduleId, data: validation.data }),
      });
      router.push(`${modulePath}/records/${record.id}/edit` as Route);
    } catch (reason) {
      setFieldErrors(getApiFieldErrors(reason));
      setError(
        reason instanceof Error
          ? reason.message
          : "Record could not be created",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow={`Module / ${module?.module_name ?? "Records"}`}
        title="Add a record"
        description="Complete the primitive fields below. Links are managed after creating the record on its edit page."
        actions={
          <Button asChild variant="ghost">
            <a href={`${modulePath}/records`}>
              <ArrowLeft size={16} /> Records
            </a>
          </Button>
        }
      />
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
                      disabled={sourceReadOnly || field.is_deleted}
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
                    disabled={sourceReadOnly || field.is_deleted}
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
                    step={
                      field.type === "int"
                        ? "1"
                        : field.type === "number"
                          ? "any"
                          : undefined
                    }
                    value={String(values[field.id] ?? "")}
                    disabled={sourceReadOnly || field.is_deleted}
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
                {field.type === "datetime" && (
                  <p className="text-muted-foreground text-xs">
                    Your timezone will be included as an ISO datetime.
                  </p>
                )}
              </div>
            ))}
            {fields.length === 0 && (
              <p className="text-muted-foreground text-sm">
                This module has no active fields. Add fields before creating a
                record.
              </p>
            )}
            {fields.length > 0 && primitiveFields.length === 0 && (
              <p className="text-muted-foreground text-sm">
                This module has no primitive fields. Links are managed after the
                record is created.
              </p>
            )}
            <div className="border-border flex justify-end border-t pt-5">
              <Button
                disabled={pending || fields.length === 0 || sourceReadOnly}
              >
                <Save size={16} />
                {pending ? "Saving…" : "Create record"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </>
  );
}
