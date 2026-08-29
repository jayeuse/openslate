"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, Save } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import type { Route } from "next";
import { AppPage } from "@/components/app-page";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  apiFetch,
  listQuery,
  type Field,
  type Department,
  type ListResponse,
  type Module,
  type RecordEntity,
} from "@/lib/api";

function initialValue(field: Field): string | boolean {
  return field.type === "boolean" ? false : "";
}
function inputValue(field: Field, value: string | boolean): unknown {
  if (field.type === "boolean") return value;
  if (typeof value !== "string" || value === "") return null;
  if (field.type === "number" || field.type === "decimal") return Number(value);
  if (field.type === "int") return Number.parseInt(value, 10);
  return field.type === "datetime" ? new Date(value).toISOString() : value;
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
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const modulePath = departmentId
    ? `/departments/${departmentId}/modules/${moduleId}`
    : `/modules/${moduleId}`;
  useEffect(() => {
    async function load() {
      try {
        const current = await apiFetch<Module>(`/modules/${moduleId}`);
        const [parent, result] = await Promise.all([
          apiFetch<Department>(`/departments/${current.department_id}`),
          apiFetch<ListResponse<Field>>(
            `/fields?${listQuery({ module_id: moduleId, limit: 100, deleted: "include", sort_by: "position", sort_order: "asc" })}`,
          ),
        ]);
        setModule(current);
        setDepartment(parent);
        setFields(result.items);
        setValues(
          Object.fromEntries(
            result.items.map((field) => [field.id, initialValue(field)]),
          ),
        );
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Module schema could not be loaded",
        );
      }
    }
    void load();
  }, [moduleId]);
  const primitiveFields = fields.filter(
    (field) => field.type !== "relationship",
  );
  const sourceReadOnly =
    module?.is_deleted === true || department?.is_deleted === true;
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const data = Object.fromEntries(
      primitiveFields.map((field) => [
        field.id,
        inputValue(field, values[field.id] ?? initialValue(field)),
      ]),
    );
    try {
      const record = await apiFetch<RecordEntity>("/records", {
        method: "POST",
        body: JSON.stringify({ module_id: moduleId, data }),
      });
      router.push(`${modulePath}/records/${record.id}/edit` as Route);
    } catch (reason) {
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
    <AppPage>
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
      {error && (
        <Alert variant="destructive" className="mb-5">
          {error}
        </Alert>
      )}
      <Card className="max-w-3xl">
        <CardContent className="p-6">
          <form className="space-y-6" onSubmit={submit}>
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
                        setValues({
                          ...values,
                          [field.id]: event.target.checked,
                        })
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
                      setValues({ ...values, [field.id]: event.target.value })
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
                          : field.type === "number" ||
                              field.type === "decimal" ||
                              field.type === "int"
                            ? "number"
                            : "text"
                    }
                    step={
                      field.type === "int"
                        ? "1"
                        : field.type === "number" || field.type === "decimal"
                          ? "any"
                          : undefined
                    }
                    value={String(values[field.id] ?? "")}
                    disabled={sourceReadOnly || field.is_deleted}
                    onChange={(event) =>
                      setValues({ ...values, [field.id]: event.target.value })
                    }
                  />
                )}
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
    </AppPage>
  );
}
