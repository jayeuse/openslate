"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  Archive,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ApiError,
  apiFetch,
  CAPABILITIES,
  listQuery,
  type Capability,
  type ListResponse,
  type Role,
  type RolePermissions,
} from "@/lib/api";

const ADMINISTRATION_LIMIT = 100;
const BUILT_IN_ROLES = new Set(["admin", "member"]);

type PermissionState = Record<Capability, boolean>;

function emptyPermissions(): PermissionState {
  return CAPABILITIES.reduce((permissions, capability) => {
    permissions[capability] = false;
    return permissions;
  }, {} as PermissionState);
}

function permissionsFor(rolePermissions: RolePermissions): PermissionState {
  return CAPABILITIES.reduce((permissions, capability) => {
    permissions[capability] = rolePermissions[capability] === true;
    return permissions;
  }, {} as PermissionState);
}

function safeErrorMessage(
  reason: unknown,
  context: "load" | "mutation" | "archive",
) {
  if (reason instanceof ApiError) {
    switch (reason.status) {
      case 401:
        return "Your session expired. Sign in again.";
      case 403:
        return "Administrator access is required to manage roles.";
      case 404:
        return "This role is no longer available. Refresh and try again.";
      case 409:
        return context === "archive"
          ? "This role cannot be archived while users are assigned to it. Move those users to another role, then try again."
          : "The role data changed elsewhere. Refresh and try again.";
      case 422:
        return "The submitted role details were rejected. Check the values and try again.";
      case 502:
      case 503:
        return "The roles service is temporarily unavailable. Try again.";
      default:
        break;
    }
  }
  return context === "load"
    ? "Roles could not be loaded. Try again."
    : "The role action could not be completed. Try again.";
}

function permissionCount(permissions: RolePermissions) {
  return CAPABILITIES.filter((capability) => permissions[capability] === true)
    .length;
}

function capabilityId(prefix: string, capability: Capability) {
  return `${prefix}-${capability.replace(".", "-")}`;
}

export default function RolesPage() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [name, setName] = useState("");
  const [permissions, setPermissions] = useState<PermissionState>(() =>
    emptyPermissions(),
  );
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editPermissions, setEditPermissions] = useState<PermissionState>(() =>
    emptyPermissions(),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);

  async function refreshRoles(): Promise<unknown> {
    setLoading(true);
    try {
      const items: Role[] = [];
      let offset = 0;
      while (true) {
        const result = await apiFetch<ListResponse<Role>>(
          `/roles?${listQuery({
            limit: ADMINISTRATION_LIMIT,
            offset,
            deleted: "include",
            sort_by: "role",
            sort_order: "asc",
          })}`,
        );
        items.push(...result.items);
        if (!result.pagination.has_more || result.items.length === 0) break;
        offset += result.items.length;
      }
      setRoles(items);
      return null;
    } catch (reason) {
      return reason;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let mounted = true;
    void refreshRoles().then((reason) => {
      if (mounted && reason) {
        setError(safeErrorMessage(reason, "load"));
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  async function retryLoad() {
    setError("");
    setNotice("");
    const reason = await refreshRoles();
    if (reason) setError(safeErrorMessage(reason, "load"));
  }

  async function runMutation(
    actionKey: string,
    action: () => Promise<unknown>,
    successMessage: string,
    onSuccess?: () => void,
  ) {
    if (busyAction) return;
    setBusyAction(actionKey);
    setError("");
    setNotice("");
    let actionError: unknown;
    try {
      await action();
      onSuccess?.();
    } catch (reason) {
      actionError = reason;
    }

    // A failed response can still follow a committed backend mutation. Always
    // replace the rendered roles with an authoritative response.
    const refreshError = await refreshRoles();
    if (actionError) {
      const message = safeErrorMessage(
        actionError,
        actionKey.startsWith("archive-") ? "archive" : "mutation",
      );
      setError(
        refreshError
          ? `${message} ${safeErrorMessage(refreshError, "load")}`
          : `${message} The roles were refreshed.`,
      );
    } else if (refreshError) {
      setError(
        `The action completed, but ${safeErrorMessage(refreshError, "load").toLowerCase()}`,
      );
    } else {
      setNotice(successMessage);
    }
    setBusyAction(null);
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const roleName = name.trim();
    if (!roleName) return;
    await runMutation(
      "create",
      () =>
        apiFetch<Role>("/roles", {
          method: "POST",
          body: JSON.stringify({ role: roleName, permissions }),
        }),
      "Role created.",
      () => {
        setName("");
        setPermissions(emptyPermissions());
      },
    );
  }

  function startEdit(role: Role) {
    setError("");
    setNotice("");
    setEditingRoleId(role.id);
    setEditName(role.role);
    setEditPermissions(permissionsFor(role.permissions));
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingRoleId) return;
    const roleId = editingRoleId;
    const roleName = editName.trim();
    if (!roleName) return;
    await runMutation(
      `edit-${roleId}`,
      () =>
        apiFetch<Role>(`/roles/${roleId}`, {
          method: "PATCH",
          body: JSON.stringify({
            role: roleName,
            permissions: editPermissions,
          }),
        }),
      "Role updated.",
      () => setEditingRoleId(null),
    );
  }

  function archive(role: Role) {
    if (
      !window.confirm(
        `Archive ${role.role}? Assigned users must be moved to another role first.`,
      )
    ) {
      return;
    }
    setEditingRoleId(null);
    void runMutation(
      `archive-${role.id}`,
      () => apiFetch(`/roles/${role.id}`, { method: "DELETE" }),
      `${role.role} was archived.`,
    );
  }

  function isBuiltIn(role: Role) {
    return BUILT_IN_ROLES.has(role.role);
  }

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Roles"
        description="Define the domain capabilities granted to each custom role in this deployment."
        actions={<Badge variant="default">Backend enforced</Badge>}
      />
      {error && (
        <Alert
          variant="destructive"
          className="mb-5 flex flex-wrap items-center justify-between gap-3"
        >
          <span>{error}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void retryLoad()}
            disabled={loading || !!busyAction}
          >
            <RefreshCw aria-hidden="true" /> Try again
          </Button>
        </Alert>
      )}
      {notice && (
        <Alert variant="success" className="mb-5">
          {notice}
        </Alert>
      )}
      <Alert className="mb-5 flex gap-3">
        <ShieldCheck size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
        <div>
          <p className="font-semibold">Exactly ten flat capabilities</p>
          <p className="mt-1">
            Custom roles use the fixed read/write capabilities below. Built-in
            <code className="mx-1">admin</code> and
            <code className="mx-1">member</code> role names and lifecycle are
            protected; user, role, invitation, audit, and purge operations
            remain administrator-only.
          </p>
        </div>
      </Alert>
      <div className="grid gap-5 lg:grid-cols-[1fr_0.44fr]">
        <Card>
          <CardHeader>
            <CardTitle>Configured roles</CardTitle>
            <CardDescription>
              All roles, including archived custom roles, loaded{" "}
              {ADMINISTRATION_LIMIT} at a time.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {loading && roles.length === 0 ? (
              <p className="text-muted-foreground p-5 text-sm" role="status">
                Loading roles…
              </p>
            ) : roles.length === 0 ? (
              <p className="text-muted-foreground p-5 text-sm">
                No roles found.
              </p>
            ) : (
              <div>
                {loading && (
                  <p
                    className="text-muted-foreground border-border border-b px-5 py-3 text-xs"
                    role="status"
                  >
                    Refreshing authoritative list…
                  </p>
                )}
                {roles.map((role) => {
                  const builtIn = isBuiltIn(role);
                  const count = permissionCount(role.permissions);
                  return (
                    <div
                      key={role.id}
                      data-role-id={role.id}
                      className="border-border flex flex-col gap-4 border-b p-5 last:border-b-0"
                    >
                      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                        <div className="flex min-w-0 flex-1 gap-3">
                          <div className="bg-accent text-accent-foreground grid size-9 shrink-0 place-items-center rounded-md">
                            <ShieldCheck size={17} aria-hidden="true" />
                          </div>
                          <div className="min-w-0">
                            <p className="font-medium break-words">
                              {role.role}
                            </p>
                            <p className="text-muted-foreground mt-1 text-xs">
                              {role.role === "admin"
                                ? "All ten capabilities are always effective."
                                : `${count} of ${CAPABILITIES.length} capabilities enabled.`}
                            </p>
                            {builtIn ? (
                              <>
                                <p className="mt-2 text-xs font-medium">
                                  Built-in role
                                </p>
                                <p className="text-muted-foreground text-xs">
                                  Name and lifecycle are protected.
                                </p>
                              </>
                            ) : (
                              <p className="text-muted-foreground mt-2 text-xs">
                                Custom role
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                          <Badge
                            variant={
                              role.is_deleted
                                ? "warning"
                                : builtIn
                                  ? "default"
                                  : "outline"
                            }
                          >
                            {role.is_deleted
                              ? "Archived"
                              : builtIn
                                ? "Built-in"
                                : "Custom"}
                          </Badge>
                          {!builtIn && role.is_deleted && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              aria-label={`Restore ${role.role}`}
                              onClick={() =>
                                void runMutation(
                                  `restore-${role.id}`,
                                  () =>
                                    apiFetch<Role>(
                                      `/roles/${role.id}/restore`,
                                      {
                                        method: "POST",
                                      },
                                    ),
                                  `${role.role} was restored.`,
                                )
                              }
                              disabled={!!busyAction}
                            >
                              <RotateCcw aria-hidden="true" /> Restore
                            </Button>
                          )}
                          {!builtIn && !role.is_deleted && (
                            <>
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                aria-label={`Edit ${role.role}`}
                                onClick={() => startEdit(role)}
                                disabled={!!busyAction}
                              >
                                <Pencil aria-hidden="true" /> Edit
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                aria-label={`Archive ${role.role}`}
                                onClick={() => archive(role)}
                                disabled={!!busyAction}
                              >
                                <Archive
                                  className="text-destructive"
                                  aria-hidden="true"
                                />{" "}
                                Archive
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                      {editingRoleId === role.id && (
                        <form
                          className="bg-muted/40 border-border rounded-[var(--radius)] border p-4"
                          onSubmit={saveEdit}
                        >
                          <div className="space-y-2">
                            <Label htmlFor={`edit-role-name-${role.id}`}>
                              Role name for {role.role}
                            </Label>
                            <Input
                              id={`edit-role-name-${role.id}`}
                              required
                              value={editName}
                              onChange={(event) =>
                                setEditName(event.target.value)
                              }
                            />
                          </div>
                          <fieldset className="mt-4">
                            <legend className="text-foreground text-sm font-medium">
                              Capabilities for {role.role}
                            </legend>
                            <div className="mt-3 grid gap-2 sm:grid-cols-2">
                              {CAPABILITIES.map((capability) => {
                                const id = capabilityId(
                                  `edit-${role.id}`,
                                  capability,
                                );
                                return (
                                  <div
                                    className="flex min-h-11 items-center gap-2"
                                    key={capability}
                                  >
                                    <input
                                      id={id}
                                      type="checkbox"
                                      className="accent-primary size-4"
                                      checked={editPermissions[capability]}
                                      onChange={(event) =>
                                        setEditPermissions({
                                          ...editPermissions,
                                          [capability]: event.target.checked,
                                        })
                                      }
                                    />
                                    <Label htmlFor={id}>{capability}</Label>
                                  </div>
                                );
                              })}
                            </div>
                          </fieldset>
                          <div className="mt-4 flex flex-wrap gap-2">
                            <Button
                              type="submit"
                              size="sm"
                              disabled={!!busyAction}
                            >
                              <Save aria-hidden="true" /> Save role {role.role}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => setEditingRoleId(null)}
                              disabled={!!busyAction}
                            >
                              Cancel
                            </Button>
                          </div>
                        </form>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Create role</CardTitle>
            <CardDescription>
              Custom roles can be renamed, edited, archived, and restored.
            </CardDescription>
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
              <fieldset>
                <legend className="text-foreground text-sm font-medium">
                  Capabilities
                </legend>
                <div className="mt-3 grid gap-2">
                  {CAPABILITIES.map((capability) => {
                    const id = capabilityId("create", capability);
                    return (
                      <div
                        className="flex min-h-11 items-center gap-2"
                        key={capability}
                      >
                        <input
                          id={id}
                          type="checkbox"
                          className="accent-primary size-4"
                          checked={permissions[capability]}
                          onChange={(event) =>
                            setPermissions({
                              ...permissions,
                              [capability]: event.target.checked,
                            })
                          }
                        />
                        <Label htmlFor={id}>{capability}</Label>
                      </div>
                    );
                  })}
                </div>
              </fieldset>
              <Button className="w-full" type="submit" disabled={!!busyAction}>
                <Plus aria-hidden="true" />
                {busyAction === "create" ? "Creating…" : "Create role"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
