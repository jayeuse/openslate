"use client";

import { useEffect, useRef, useState } from "react";
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
  listAllModuleFields,
  type Field,
  type Department,
  type ListResponse,
  type Module,
  type RecordEntity,
} from "@/lib/api";
import { OPENSLADE_INVALIDATION_EVENT } from "@/components/realtime-provider";
import { RecordQueryEditor } from "@/components/record-query-editor";
import { RecordQueryViews } from "@/components/record-query-views";
import { useWorkspace } from "@/components/workspace-provider";
import { formatWorkspaceDateTime, formatWorkspaceDate } from "@/lib/date-time";
import type { QueryDefinition } from "@/lib/record-query";
import { compactId } from "@/lib/utils";

function displayValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}
export default function RecordsPage() {
  const { moduleId } = useParams<{ moduleId: string }>();
  return <ModuleRecords key={moduleId} moduleId={moduleId} />;
}
function ModuleRecords({ moduleId }: { moduleId: string }) {
  const { profile, user, isAdmin, can } = useWorkspace();
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
  const [definition, setDefinition] = useState<QueryDefinition>({
    version: 1,
    columns: [],
    filters: [],
    sort: [],
    deleted: "include",
    search: null,
  });
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [initialized, setInitialized] = useState(false);
  const visibleFields = definition.columns
    .map((c) => fields.find((f) => f.id === c.field_id))
    .filter((f): f is Field => !!f);
  function changeDefinition(value: QueryDefinition) {
    setDefinition(value);
    setOffset(0);
  }

  const [recordId, setRecordId] = useState("");
  const [error, setError] = useState("");
  const [archiveTarget, setArchiveTarget] = useState<RecordEntity | null>(null);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const modulePath = module
    ? `/departments/${module.department_id}/modules/${moduleId}`
    : `/modules/${moduleId}`;
  const requestGeneration = useRef(0);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  useEffect(() => {
    const invalidate = () => setRefreshGeneration((value) => value + 1);
    window.addEventListener(OPENSLADE_INVALIDATION_EVENT, invalidate);
    return () =>
      window.removeEventListener(OPENSLADE_INVALIDATION_EVENT, invalidate);
  }, []);
  async function load() {
    const generation = ++requestGeneration.current;
    setLoading(true);
    setError("");
    try {
      const current = await apiFetch<Module>(`/modules/${moduleId}`);
      const [parent, fieldResult] = await Promise.all([
        apiFetch<Department>(`/departments/${current.department_id}`),
        listAllModuleFields(moduleId),
      ]);
      if (generation !== requestGeneration.current) return;
      setModule(current);
      setDepartment(parent);
      setFields(fieldResult);
      const activeDefinition = initialized
        ? definition
        : {
            ...definition,
            columns: fieldResult
              .filter((f) => f.type !== "relationship")
              .slice(0, 100)
              .map((f) => ({ field_id: f.id, expected_type: f.type })),
          };
      if (!initialized) {
        setDefinition(activeDefinition);
        setInitialized(true);
      }
      const recordResult = await apiFetch<ListResponse<RecordEntity>>(
        "/records/query",
        {
          method: "POST",
          body: JSON.stringify({
            module_id: moduleId,
            definition: activeDefinition,
            limit: 25,
            offset,
          }),
        },
      );
      if (generation !== requestGeneration.current) return;
      setRecords(recordResult.items);
      setHasMore(recordResult.pagination.has_more);
      setTotal(recordResult.pagination.total);
    } catch (reason) {
      if (generation !== requestGeneration.current) return;
      setRecords([]);
      setError(
        reason instanceof Error
          ? reason.message
          : "Records could not be loaded",
      );
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      requestGeneration.current += 1;
    };
  }, [moduleId, definition, offset, refreshGeneration]);
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
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Record could not be archived",
      );
    } finally {
      setPending(false);
      setArchiveTarget(null);
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
            {can("records.write") &&
            module?.is_deleted !== true &&
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
            onKeyDown={(event) => {
              if (event.key === "Enter")
                changeDefinition({ ...definition, search: recordId || null });
            }}
          />
        </div>
        <Button
          variant="outline"
          onClick={() =>
            changeDefinition({ ...definition, search: recordId || null })
          }
        >
          Search records
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            changeDefinition({
              ...definition,
              deleted: definition.deleted === "exclude" ? "include" : "exclude",
            })
          }
        >
          {definition.deleted === "exclude" ? (
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
      <RecordQueryViews
        refreshGeneration={refreshGeneration}
        moduleId={moduleId}
        definition={definition}
        onLoad={(value) => {
          changeDefinition(value);
          setRecordId(value.search ?? "");
        }}
        isAdmin={isAdmin}
        userId={user.id}
      />
      <RecordQueryEditor
        fields={fields}
        definition={definition}
        onChange={changeDefinition}
        timezone={profile.timezone}
      />
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
                {visibleFields.map((field) => (
                  <th className="px-5 py-3 font-medium" key={field.id}>
                    {field.name}
                    {field.is_deleted ? " (archived)" : ""}
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
              {!loading && !error && records.length === 0 && (
                <tr>
                  <td
                    className="text-muted-foreground px-5 py-10 text-center"
                    colSpan={fields.length + 3}
                  >
                    No records match the current view.
                  </td>
                </tr>
              )}
              {records.map((record) => (
                <tr key={record.id} className="hover:bg-muted/30 align-top">
                  <td className="px-5 py-4">
                    <a
                      href={`${modulePath}/records/${record.id}/edit`}
                      className="text-primary font-mono text-xs hover:underline"
                    >
                      {compactId(record.id)}
                    </a>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {formatWorkspaceDateTime(record.created_at, profile)}
                    </p>
                  </td>
                  {visibleFields.map((field) => (
                    <td
                      className="text-muted-foreground px-5 py-4"
                      key={field.id}
                    >
                      {field.type === "relationship"
                        ? "Links are managed from Edit"
                        : field.type === "datetime" &&
                            typeof record.data[field.id] === "string"
                          ? formatWorkspaceDateTime(
                              record.data[field.id] as string,
                              profile,
                            )
                          : field.type === "date" &&
                              typeof record.data[field.id] === "string"
                            ? formatWorkspaceDate(
                                record.data[field.id] as string,
                                profile,
                              )
                            : displayValue(record.data[field.id])}
                    </td>
                  ))}
                  <td className="px-5 py-4">
                    <Badge variant={record.is_deleted ? "warning" : "success"}>
                      {record.is_deleted ? "Archived" : "Active"}
                    </Badge>
                  </td>
                  <td className="px-5 py-4 text-right">
                    {record.is_deleted ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={
                          !can("records.write") ||
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
                          !can("records.write") ||
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
      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-muted-foreground text-sm">
          {total} records · Page {Math.floor(offset / 25) + 1}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={loading || offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 25))}
          >
            Previous page
          </Button>
          <Button
            variant="outline"
            disabled={loading || !hasMore}
            onClick={() => setOffset(offset + 25)}
          >
            Next page
          </Button>
        </div>
      </div>
    </>
  );
}
