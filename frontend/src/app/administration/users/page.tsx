"use client";

import { useEffect, useState } from "react";
import { Mail, Plus, UserRound } from "lucide-react";
import { AppPage } from "@/components/app-page";
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
  type ListResponse,
  type Role,
  type User,
} from "@/lib/api";

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [roleId, setRoleId] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function load() {
    try {
      const [userResult, roleResult] = await Promise.all([
        apiFetch<ListResponse<User>>(
          `/users?${listQuery({ limit: 100, deleted: "include", sort_by: "username", sort_order: "asc" })}`,
        ),
        apiFetch<ListResponse<Role>>(
          `/roles?${listQuery({ limit: 100, deleted: "exclude", sort_by: "role", sort_order: "asc" })}`,
        ),
      ]);
      setUsers(userResult.items);
      setRoles(roleResult.items);
      if (!roleId && roleResult.items[0]) setRoleId(roleResult.items[0].id);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Users could not be loaded",
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
      await apiFetch<User>("/users", {
        method: "POST",
        body: JSON.stringify({ email, username, role_id: roleId }),
      });
      setEmail("");
      setUsername("");
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "User could not be created",
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <AppPage>
      <PageHeader
        eyebrow="Administration"
        title="People"
        description="Invite staff accounts and assign an active role. Invited users finish setup from the secure email link."
      />
      <Alert variant="warning" className="mb-5">
        Staff accounts can authenticate, but the current backend authorizes
        departments, modules, fields, and records for the exact{" "}
        <strong>admin</strong> role only.
      </Alert>
      <div className="grid gap-5 lg:grid-cols-[1fr_0.44fr]">
        <Card>
          <CardHeader>
            <CardTitle>Users</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {users.map((user) => (
              <div
                className="border-border flex items-center gap-4 border-b p-5 last:border-b-0"
                key={user.id}
              >
                <div className="bg-accent text-accent-foreground grid size-9 place-items-center rounded-full">
                  <UserRound size={17} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{user.username}</p>
                  <p className="text-muted-foreground mt-1 font-mono text-[11px]">
                    Role ID · {user.role_id.slice(0, 8)}…
                  </p>
                </div>
                <Badge
                  variant={
                    user.is_deleted || user.status === "disabled"
                      ? "warning"
                      : user.status === "active"
                        ? "success"
                        : "default"
                  }
                >
                  {user.is_deleted
                    ? "Archived"
                    : user.status === "pending"
                      ? "Invitation pending"
                      : user.status === "disabled"
                        ? "Disabled"
                        : "Active"}
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Invite staff user</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={create}>
              <div className="space-y-2">
                <Label htmlFor="staff-email">Email</Label>
                <Input
                  id="staff-email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="staff-username">Username</Label>
                <Input
                  id="staff-username"
                  required
                  pattern="[A-Za-z0-9_-]+"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="staff-role">Role</Label>
                <select
                  id="staff-role"
                  className="border-input bg-card h-10 w-full rounded-[var(--radius)] border px-3 text-sm"
                  value={roleId}
                  onChange={(event) => setRoleId(event.target.value)}
                >
                  {roles.map((role) => (
                    <option value={role.id} key={role.id}>
                      {role.role}
                    </option>
                  ))}
                </select>
              </div>
              <Button className="w-full" disabled={saving || !roleId}>
                <Mail size={16} />
                {saving ? (
                  "Sending…"
                ) : (
                  <>
                    <Plus size={16} /> Send invitation
                  </>
                )}
              </Button>
            </form>
            {error && (
              <Alert variant="destructive" className="mt-4">
                {error}
              </Alert>
            )}
          </CardContent>
        </Card>
      </div>
    </AppPage>
  );
}
