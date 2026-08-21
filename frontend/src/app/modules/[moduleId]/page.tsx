"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, Database, Settings2, Table2 } from "lucide-react";
import { useParams } from "next/navigation";
import { AppPage } from "@/components/app-page";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
            `/fields?${listQuery({ module_id: moduleId, limit: 100, sort_by: "position", sort_order: "asc" })}`,
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
              <Badge variant={fields.length ? "success" : "warning"}>
                {fields.length ? `${fields.length} fields` : "Needs fields"}
              </Badge>
            </div>
            <h2 className="mt-5 font-semibold">Module schema</h2>
            <p className="text-muted-foreground mt-2 text-sm leading-6">
              Define names, types, required values, and validation
              configuration.
            </p>
            <Button asChild className="mt-5">
              <a href={`${modulePath}/schema`}>Open schema builder</a>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-start justify-between">
              <div className="bg-accent text-accent-foreground grid size-10 place-items-center rounded-md">
                <Table2 />
              </div>
              <Badge variant={fields.length ? "default" : "warning"}>
                {fields.length ? "Ready to review" : "Blocked"}
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
            <h2 className="font-medium">Readiness review</h2>
            <p className="text-muted-foreground mt-1 text-sm leading-6">
              {fields.length
                ? "This module has fields. Open the schema builder to run the complete frontend readiness review before adding a first record."
                : "Add at least one field before the module can produce a valid record form."}
            </p>
          </div>
        </CardContent>
      </Card>
    </AppPage>
  );
}
