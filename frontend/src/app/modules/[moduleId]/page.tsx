"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, Database, Settings2, Table2 } from "lucide-react";
import { useParams } from "next/navigation";
import { AppPage } from "@/components/app-page";
import { LifecycleAction } from "@/components/lifecycle-dialog";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  apiFetch,
  listQuery,
  type Department,
  type Field,
  type ListResponse,
  type Module,
} from "@/lib/api";

export default function ModulePage() {
  const { moduleId } = useParams<{ moduleId: string }>();
  const [module, setModule] = useState<Module | null>(null);
  const [department, setDepartment] = useState<Department | null>(null);
  const [fields, setFields] = useState<Field[]>([]);
  const [error, setError] = useState("");
  const modulePath = department
    ? `/departments/${department.id}/modules/${moduleId}`
    : `/modules/${moduleId}`;
  useEffect(() => {
    async function load() {
      try {
        const current = await apiFetch<Module>(`/modules/${moduleId}`);
        const [parent, fieldList] = await Promise.all([
          apiFetch<Department>(`/departments/${current.department_id}`),
          apiFetch<ListResponse<Field>>(
            `/fields?${listQuery({ module_id: moduleId, limit: 100, deleted: "include", sort_by: "position", sort_order: "asc" })}`,
          ),
        ]);
        setModule(current);
        setDepartment(parent);
        setFields(fieldList.items);
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Module could not be loaded",
        );
      }
    }
    void load();
  }, [moduleId]);
  return (
    <AppPage>
      <PageHeader
        eyebrow={department?.department_name ?? "Module"}
        title={module?.module_name ?? "Loading module"}
        description="Review the schema before you add records. Every active record must match the current field definition."
        actions={
          <Button asChild variant="ghost">
            <a
              href={
                department ? `/departments/${department.id}` : "/departments"
              }
            >
              <ArrowLeft size={16} /> Back
            </a>
          </Button>
        }
      />
      {error && <Alert variant="destructive">{error}</Alert>}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-start justify-between">
              <div className="bg-accent text-accent-foreground grid size-10 place-items-center rounded-md">
                <Settings2 />
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                {module?.is_deleted && <Badge variant="warning">Closed</Badge>}
                <Badge
                  variant={module?.is_schema_accepted ? "success" : "warning"}
                >
                  {module
                    ? module.is_schema_accepted
                      ? "Schema accepted"
                      : "Schema unaccepted"
                    : "Loading schema"}
                </Badge>
              </div>
            </div>
            <h2 className="mt-5 font-semibold">Module schema</h2>
            <p className="text-muted-foreground mt-2 text-sm leading-6">
              Define names, types, required values, and validation
              configuration.
            </p>
            {module?.is_deleted || department?.is_deleted ? (
              <Button className="mt-5" disabled>
                Schema changes disabled while closed
              </Button>
            ) : (
              <Button asChild className="mt-5">
                <a href={`${modulePath}/schema`}>Open schema builder</a>
              </Button>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-start justify-between">
              <div className="bg-accent text-accent-foreground grid size-10 place-items-center rounded-md">
                <Table2 />
              </div>
              <Badge
                variant={module?.is_schema_accepted ? "default" : "warning"}
              >
                {module?.is_schema_accepted
                  ? "Ready for records"
                  : "Records blocked"}
              </Badge>
            </div>
            <h2 className="mt-5 font-semibold">Module records</h2>
            <p className="text-muted-foreground mt-2 text-sm leading-6">
              Browse, sort, archive, and restore records after the schema is
              ready.
            </p>
            <Button asChild variant="outline" className="mt-5">
              <a href={`${modulePath}/records`}>Open records</a>
            </Button>
          </CardContent>
        </Card>
      </div>
      <Card className="mt-5">
        <CardContent className="flex items-start gap-4 p-5">
          <Database className="text-primary mt-0.5" size={18} />
          <div>
            <h2 className="font-medium">Schema status</h2>
            <p className="text-muted-foreground mt-1 text-sm leading-6">
              {module?.is_schema_accepted
                ? "The backend has accepted this schema. Records can be created until a schema change invalidates it."
                : fields.length
                  ? "Accept the schema before adding records."
                  : "Add at least one field, then accept the schema before adding records."}
            </p>
          </div>
        </CardContent>
      </Card>
      {module && (
        <Card
          className="border-destructive/40 mt-5"
          data-testid="module-danger-zone"
        >
          <CardHeader>
            <CardTitle>Danger zone</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-muted-foreground max-w-2xl text-sm leading-6">
              Closing this module makes its schema and records read-only while
              keeping closed data available for review and reopening here.
            </p>
            <LifecycleAction
              targetType="module"
              targetId={module.id}
              targetName={module.module_name}
              isClosed={module.is_deleted}
              onComplete={() => window.location.reload()}
            />
          </CardContent>
        </Card>
      )}
    </AppPage>
  );
}
