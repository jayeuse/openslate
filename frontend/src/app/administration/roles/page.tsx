"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { AppPage } from "@/components/app-page";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch, listQuery, type ListResponse, type Role } from "@/lib/api";

export default function RolesPage() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [name, setName] = useState("");
  const [permissions, setPermissions] = useState("{}");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function load() {
    try {
      const result = await apiFetch<ListResponse<Role>>(
        `/roles?${listQuery({ limit: 100, deleted: "include", sort_by: "role", sort_order: "asc" })}`,
      );
      setRoles(result.items);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Roles could not be loaded",
      );
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const parsed: unknown = JSON.parse(permissions);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      )
        throw new Error("Permissions must be a JSON object");
      await apiFetch<Role>("/roles", {
        method: "POST",
        body: JSON.stringify({ role: name, permissions: parsed }),
      });
      setName("");
      setPermissions("{}");
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Role could not be created",
      );
    } finally {
      setSaving(false);
    }
  }
  async function remove(role: Role) {
    if (role.role === "admin" || role.role === "member") return;
    if (
      !window.confirm(
        `Archive ${role.role}? Users assigned to it must be changed first.`,
      )
    )
      return;
    try {
      await apiFetch(`/roles/${role.id}`, { method: "DELETE" });
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Role could not be archived",
      );
    }
  }
  return (
    <AppPage>
      <PageHeader
        eyebrow="Administration"
        title="Roles"
        description="Define role metadata for your organization. The current backend stores permissions but only the literal admin role can access domain APIs."
        actions={<Badge variant="warning">Authorization limitation</Badge>}
      />
      {error && (
        <Alert variant="destructive" className="mb-5">
          {error}
        </Alert>
      )}
      <Alert variant="warning" className="mb-5 flex gap-3">
        <AlertTriangle size={17} className="mt-0.5 shrink-0" />
        <div>
          <p className="font-semibold">Permissions are not enforced yet</p>
          <p className="mt-1">
            Creating a permission entry documents intent, but staff and member
            roles will still receive a 403 from business-data endpoints.
          </p>
        </div>
      </Alert>
      <div className="grid gap-5 lg:grid-cols-[1fr_0.44fr]">
        <Card>
          <CardHeader>
            <CardTitle>Configured roles</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {roles.map((role) => (
              <div
                className="border-border flex items-center gap-4 border-b p-5 last:border-b-0"
                key={role.id}
              >
                <div className="bg-accent text-accent-foreground grid size-9 place-items-center rounded-md">
                  <ShieldCheck size={17} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{role.role}</p>
                  <p className="text-muted-foreground mt-1 text-xs">
                    {Object.keys(role.permissions).length} permission entries
                  </p>
                </div>
                <Badge
                  variant={
                    role.is_deleted
                      ? "warning"
                      : role.role === "admin"
                        ? "default"
                        : "outline"
                  }
                >
                  {role.is_deleted
                    ? "Archived"
                    : role.role === "admin"
                      ? "Administrator"
                      : "Custom"}
                </Badge>
                {role.role !== "admin" &&
                  role.role !== "member" &&
                  !role.is_deleted && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Archive ${role.role}`}
                      onClick={() => void remove(role)}
                    >
                      <Trash2 className="text-destructive" size={15} />
                    </Button>
                  )}
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Create role</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={create}>
              <div className="space-y-2">
                <Label htmlFor="role-name">Role name</Label>
                <Input
                  id="role-name"
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. Operations lead"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="permissions">Permissions JSON</Label>
                <textarea
                  id="permissions"
                  className="border-input bg-card min-h-28 w-full rounded-[var(--radius)] border p-3 font-mono text-xs"
                  value={permissions}
                  onChange={(event) => setPermissions(event.target.value)}
                />
                <p className="text-muted-foreground text-xs">
                  Stored as metadata for future authorization rules.
                </p>
              </div>
              <Button className="w-full" disabled={saving}>
                <Plus size={16} />
                {saving ? "Creating…" : "Create role"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </AppPage>
  );
}
