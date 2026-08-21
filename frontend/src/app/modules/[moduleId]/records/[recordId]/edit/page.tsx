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
  type ListResponse,
  type Module,
  type RecordEntity,
} from "@/lib/api";

function editValue(field: Field, value: unknown): string | boolean {
  if (field.type === "boolean") return value === true;
  if (field.type === "datetime" && typeof value === "string")
    return value.slice(0, 16);
  return value === null || value === undefined ? "" : String(value);
}
function apiValue(field: Field, value: string | boolean): unknown {
  if (field.type === "boolean") return value;
  if (typeof value !== "string" || value === "") return null;
  if (field.type === "number" || field.type === "decimal") return Number(value);
  if (field.type === "int") return Number.parseInt(value, 10);
  return field.type === "datetime" ? new Date(value).toISOString() : value;
}
export default function EditRecordPage() {
  const { moduleId, recordId, departmentId } = useParams<{
    moduleId: string;
    recordId: string;
    departmentId?: string;
  }>();
  const router = useRouter();
  const [module, setModule] = useState<Module | null>(null);
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
        const [current, fieldResult, record] = await Promise.all([
          apiFetch<Module>(`/modules/${moduleId}`),
          apiFetch<ListResponse<Field>>(
            `/fields?${listQuery({ module_id: moduleId, limit: 100, sort_by: "position", sort_order: "asc" })}`,
          ),
          apiFetch<RecordEntity>(`/records/${recordId}`),
        ]);
        setModule(current);
        setFields(fieldResult.items);
        setValues(
          Object.fromEntries(
            fieldResult.items.map((field) => [
              field.id,
              editValue(field, record.data[field.id]),
            ]),
          ),
        );
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Record could not be loaded",
        );
      }
    }
    void load();
  }, [moduleId, recordId]);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const data = Object.fromEntries(
      fields.map((field) => [
        field.id,
        apiValue(field, values[field.id] ?? ""),
      ]),
    );
    try {
      await apiFetch(`/records/${recordId}`, {
        method: "PATCH",
        body: JSON.stringify({ data }),
      });
      router.push(`${modulePath}/records` as Route);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Record could not be saved",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <AppPage>
      <PageHeader
        eyebrow={`Record / ${module?.module_name ?? "Edit"}`}
        title="Edit record"
        description="This saves the complete data object, so every current field is retained when you submit."
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
            {fields.map((field) => (
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
                    value={String(values[field.id] ?? "")}
                    onChange={(event) =>
                      setValues({ ...values, [field.id]: event.target.value })
                    }
                  />
                )}
              </div>
            ))}
            <div className="border-border flex justify-end border-t pt-5">
              <Button disabled={pending}>
                <Save size={16} />
                {pending ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </AppPage>
  );
}
