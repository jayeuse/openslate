"use client";

import { useEffect, useState } from "react";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Plus,
  RotateCcw,
  Search,
} from "lucide-react";
import { useParams } from "next/navigation";
import { LifecycleAction } from "@/components/lifecycle-dialog";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useBreadcrumbLabels } from "@/components/app-breadcrumbs";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  apiFetch,
  listQuery,
  type Field,
  type Department,
  type ListResponse,
  type Module,
  type RecordEntity,
} from "@/lib/api";
import { compactId } from "@/lib/utils";

function displayValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}
export default function RecordsPage() {
  const { moduleId } = useParams<{ moduleId: string }>();
  const [module, setModule] = useState<Module | null>(null);
  const [department, setDepartment] = useState<Department | null>(null);
  useBreadcrumbLabels({
    department: department
      ? { id: department.id, name: department.department_name }
      : undefined,
    module: module ? { id: module.id, name: module.module_name } : undefined,
  });
  const [fields, setFields] = useState<Field[]>([]);
  const [records, setRecords] = useState<RecordEntity[]>([]);
  const [deleted, setDeleted] = useState("include");
  const [recordId, setRecordId] = useState("");
  const [error, setError] = useState("");
  const [archiveTarget, setArchiveTarget] = useState<RecordEntity | null>(null);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const modulePath = module
    ? `/departments/${module.department_id}/modules/${moduleId}`
    : `/modules/${moduleId}`;
  async function load() {
    setLoading(true);
    setError("");
    try {
      const current = await apiFetch<Module>(`/modules/${moduleId}`);
      const [parent, fieldResult, recordResult] = await Promise.all([
        apiFetch<Department>(`/departments/${current.department_id}`),
        apiFetch<ListResponse<Field>>(
          `/fields?${listQuery({ module_id: moduleId, limit: 100, deleted: "include", sort_by: "position", sort_order: "asc" })}`,
        ),
        apiFetch<ListResponse<RecordEntity>>(
          `/records?${listQuery({ module_id: moduleId, limit: 100, deleted, sort_by: "created_at", sort_order: "desc" })}`,
        ),
      ]);
      setModule(current);
      setDepartment(parent);
      setFields(fieldResult.items);
      setRecords(recordResult.items);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Records could not be loaded",
      );
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, [moduleId, deleted]);
  async function restore(record: RecordEntity) {
    try {
      await apiFetch(`/records/${record.id}/restore`, { method: "POST" });
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Record could not be restored",
      );
    }
  }
  async function archive(record: RecordEntity) {
    if (pending) return;
    setPending(true);
    try {
      await apiFetch(`/records/${record.id}`, { method: "DELETE" });
      await load();
      setArchiveTarget(null);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Record could not be archived",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <ConfirmationDialog
        open={!!archiveTarget}
        onOpenChange={(open) => {
          if (!open) setArchiveTarget(null);
        }}
        title="Archive this record?"
        description="You can restore it later if its data still matches the active schema."
        confirmLabel="Archive"
        pending={pending}
        onConfirm={() => (archiveTarget ? archive(archiveTarget) : undefined)}
      />
      <PageHeader
        eyebrow="Module / Records"
        title={module?.module_name ?? "Records"}
        description="Search by record ID, view the current schema, and manage the complete record lifecycle."
        actions={
          <>
            <Button asChild variant="ghost">
              <a href={modulePath}>
                <ArrowLeft size={16} /> Module
              </a>
            </Button>
            {module?.is_deleted !== true &&
            department?.is_deleted !== true &&
            module?.is_schema_accepted === true &&
            fields.some((field) => !field.is_deleted) ? (
              <Button asChild>
                <a href={`${modulePath}/records/new`}>
                  <Plus size={16} /> Add record
                </a>
              </Button>
            ) : (
              <Button disabled>
                <Plus size={16} /> Add record
              </Button>
            )}
          </>
        }
      />
      {module?.is_deleted && (
        <Badge variant="warning" className="mb-5">
          Closed
        </Badge>
      )}
      {error && (
        <Alert variant="destructive" className="mb-5">
          {error}{" "}
          <button
            className="ml-2 font-medium underline"
            onClick={() => void load()}
          >
            Try again
          </button>
        </Alert>
      )}
      <div className="mb-5 flex flex-col gap-3 sm:flex-row">
        <div className="relative max-w-md flex-1">
          <Search
            size={16}
            className="text-muted-foreground absolute top-3 left-3"
          />
          <Input
            className="pl-9"
            placeholder="Record ID"
            aria-label="Record ID"
            value={recordId}
            onChange={(event) => setRecordId(event.target.value)}
          />
        </div>
        <Button
          variant="outline"
          onClick={() =>
            setDeleted(deleted === "exclude" ? "include" : "exclude")
          }
        >
          {deleted === "exclude" ? (
            <>
              <Archive size={16} /> Active records
            </>
          ) : (
            <>
              <RotateCcw size={16} /> Include archived
            </>
          )}
        </Button>
      </div>
      {module && !module.is_schema_accepted && !loading && (
        <Alert variant="warning" className="mb-5">
          {fields.length
            ? "Accept the schema before creating a record."
            : "Add fields and accept the schema before creating a record."}{" "}
          <a className="font-medium underline" href={`${modulePath}/schema`}>
            Open schema builder
          </a>
        </Alert>
      )}
      {loading && records.length > 0 && (
        <p role="status" className="text-muted-foreground mb-3 text-xs">
          Refreshing records…
        </p>
      )}
      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-muted/60 text-muted-foreground text-xs tracking-wide uppercase">
              <tr>
                <th className="px-5 py-3 font-medium">Record</th>
                {fields.map((field) => (
                  <th className="px-5 py-3 font-medium" key={field.id}>
                    {field.name}
                  </th>
                ))}
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-border divide-y" aria-busy={loading}>
              {loading && records.length === 0 && (
                <tr>
                  <td
                    className="text-muted-foreground px-5 py-8"
                    colSpan={fields.length + 3}
                  >
                    <span className="sr-only" role="status">
                      Loading records…
                    </span>
                    <Skeleton className="h-12 w-full" />
                  </td>
                </tr>
              )}
              {!loading &&
                !error &&
                records.filter(
                  (record) =>
                    !recordId ||
                    record.id.toLowerCase().includes(recordId.toLowerCase()),
                ).length === 0 && (
                  <tr>
                    <td
                      className="text-muted-foreground px-5 py-10 text-center"
                      colSpan={fields.length + 3}
                    >
                      No records match the current view.
                    </td>
                  </tr>
                )}
              {records
                .filter(
                  (record) =>
                    !recordId ||
                    record.id.toLowerCase().includes(recordId.toLowerCase()),
                )
                .map((record) => (
                  <tr key={record.id} className="hover:bg-muted/30 align-top">
                    <td className="px-5 py-4">
                      <a
                        href={`${modulePath}/records/${record.id}/edit`}
                        className="text-primary font-mono text-xs hover:underline"
                      >
                        {compactId(record.id)}
                      </a>
                      <p className="text-muted-foreground mt-1 text-xs">
                        {new Date(record.created_at).toLocaleDateString()}
                      </p>
                    </td>
                    {fields.map((field) => (
                      <td
                        className="text-muted-foreground px-5 py-4"
                        key={field.id}
                      >
                        {field.type === "relationship"
                          ? "Links are managed from Edit"
                          : displayValue(record.data[field.id])}
                      </td>
                    ))}
                    <td className="px-5 py-4">
                      <Badge
                        variant={record.is_deleted ? "warning" : "success"}
                      >
                        {record.is_deleted ? "Archived" : "Active"}
                      </Badge>
                    </td>
                    <td className="px-5 py-4 text-right">
                      {record.is_deleted ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={
                            module?.is_deleted === true ||
                            department?.is_deleted === true
                          }
                          onClick={() => void restore(record)}
                        >
                          <RotateCcw size={14} /> Restore
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={
                            module?.is_deleted === true ||
                            department?.is_deleted === true
                          }
                          onClick={() => setArchiveTarget(record)}
                        >
                          Archive <ArrowRight size={14} />
                        </Button>
                      )}
                      {record.is_deleted && (
                        <LifecycleAction
                          targetType="record"
                          targetId={record.id}
                          targetName={record.id}
                          isClosed
                          allowClose={false}
                          allowReopen={false}
                          onComplete={load}
                        />
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </>
  );
}
