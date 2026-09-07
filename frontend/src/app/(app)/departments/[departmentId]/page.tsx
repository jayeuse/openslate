"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Boxes, Plus } from "lucide-react";
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
  apiFetch,
  listQuery,
  type Department,
  type ListResponse,
  type Module,
} from "@/lib/api";

export default function DepartmentDetailPage() {
  const { departmentId } = useParams<{ departmentId: string }>();
  const [department, setDepartment] = useState<Department | null>(null);
  const [modules, setModules] = useState<Module[]>([]);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    try {
      const [parent, children] = await Promise.all([
        apiFetch<Department>(`/departments/${departmentId}`),
        apiFetch<ListResponse<Module>>(
          `/modules?${listQuery({ department_id: departmentId, limit: 100, deleted: "include", sort_by: "module_name", sort_order: "asc" })}`,
        ),
      ]);
      setDepartment(parent);
      setModules(children.items);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Department could not be loaded",
      );
    }
  }
  useEffect(() => {
    void load();
  }, [departmentId]);
  async function createModule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreating(true);
    setError("");
    try {
      await apiFetch<Module>("/modules", {
        method: "POST",
        body: JSON.stringify({
          department_id: departmentId,
          module_name: name,
        }),
      });
      setName("");
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Module could not be created",
      );
    } finally {
      setCreating(false);
    }
  }
  const departmentClosed = department?.is_deleted === true;
  return (
    <>
      <PageHeader
        eyebrow="Workspace / Department"
        title={department?.department_name ?? "Department"}
        description="Modules belong to this department and cannot be moved after creation."
        actions={
          <Button asChild variant="ghost">
            <a href="/departments">
              <ArrowLeft size={16} /> Departments
            </a>
          </Button>
        }
      />
      {department?.is_deleted && (
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
      <div className="grid gap-5 lg:grid-cols-[1fr_0.42fr]">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Modules</CardTitle>
                <p className="text-muted-foreground mt-1 text-sm">
                  Create a module for each collection your team needs to
                  operate.
                </p>
              </div>
              <Badge variant="outline">
                {modules.filter((module) => !module.is_deleted).length} active
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {modules.length === 0 && (
              <div className="text-muted-foreground p-8 text-sm">
                No modules yet. Use the form to create the first one.
              </div>
            )}
            {modules.map((module) => (
              <div
                className="border-border flex items-center gap-4 border-b p-5 last:border-b-0"
                key={module.id}
              >
                <div className="bg-accent text-accent-foreground grid size-9 place-items-center rounded-md">
                  <Boxes size={17} />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="font-medium">{module.module_name}</h3>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {module.is_deleted ? "Closed module" : "Active module"}
                  </p>
                </div>
                <Badge variant={module.is_deleted ? "warning" : "success"}>
                  {module.is_deleted ? "Closed" : "Active"}
                </Badge>
                <Button
                  asChild
                  variant="ghost"
                  size="icon"
                  aria-label={`Open ${module.module_name}`}
                >
                  <a href={`/departments/${departmentId}/modules/${module.id}`}>
                    <ArrowRight />
                  </a>
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Next action</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={createModule}>
              <div className="space-y-2">
                <Label htmlFor="module-name">Module name</Label>
                <Input
                  id="module-name"
                  required
                  maxLength={150}
                  placeholder="e.g. Customers"
                  value={name}
                  disabled={departmentClosed}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <Button
                className="w-full"
                disabled={creating || departmentClosed}
              >
                <Plus size={16} />
                {creating ? "Creating…" : "Create module"}
              </Button>
            </form>
            <p className="text-muted-foreground mt-4 text-xs leading-5">
              {departmentClosed
                ? "This department is closed. Reopen it before creating modules."
                : "After creating a module, add fields before attempting your first record."}
            </p>
          </CardContent>
        </Card>
      </div>
      {department && (
        <Card
          className="border-destructive/40 mt-5"
          data-testid="department-danger-zone"
        >
          <CardHeader>
            <CardTitle>Danger zone</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-muted-foreground max-w-2xl text-sm leading-6">
              Closing this department also closes its modules. Closed data
              remains available for review and can be reopened here.
            </p>
            <LifecycleAction
              targetType="department"
              targetId={department.id}
              targetName={department.department_name}
              isClosed={department.is_deleted}
              onComplete={load}
            />
          </CardContent>
        </Card>
      )}
    </>
  );
}
