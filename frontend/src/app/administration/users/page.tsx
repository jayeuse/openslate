"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  Check,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  UserRound,
  UserRoundCheck,
  UserRoundX,
} from "lucide-react";
import { AppPage } from "@/components/app-page";
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
  listQuery,
  type ListResponse,
  type Role,
  type User,
} from "@/lib/api";

const ADMINISTRATION_LIMIT = 100;

type EditDraft = {
  id: string;
  username: string;
  roleId: string;
};

function safeErrorMessage(reason: unknown, context: "load" | "mutation") {
  if (reason instanceof ApiError) {
    switch (reason.status) {
      case 401:
        return "Your session expired. Sign in again.";
      case 403:
        return "Administrator access is required to manage people.";
      case 404:
        return "The requested person or role is no longer available. Refresh and try again.";
      case 409:
        return "The people data changed elsewhere. Refresh and try again.";
      case 422:
        return "The submitted people details were rejected. Check the values and try again.";
      case 502:
      case 503:
        return "The people service is temporarily unavailable. Try again.";
      default:
        break;
    }
  }
  return context === "load"
    ? "People could not be loaded. Try again."
    : "The people action could not be completed. Try again.";
}

function statusLabel(user: User) {
  if (user.is_deleted) return "Deleted";
  if (user.status === "pending") return "Invitation pending";
  if (user.status === "disabled") return "Disabled";
  return "Active";
}

function statusVariant(user: User) {
  if (user.is_deleted || user.status === "disabled") return "warning" as const;
  if (user.status === "active") return "success" as const;
  return "default" as const;
}

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [roleId, setRoleId] = useState("");
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);

  async function refreshLists(): Promise<unknown> {
    setLoading(true);
    try {
      const [userItems, roleItems] = await Promise.all([
        (async () => {
          const items: User[] = [];
          let offset = 0;
          while (true) {
            const result = await apiFetch<ListResponse<User>>(
              `/users?${listQuery({
                limit: ADMINISTRATION_LIMIT,
                offset,
                deleted: "include",
                sort_by: "username",
                sort_order: "asc",
              })}`,
            );
            items.push(...result.items);
            if (!result.pagination.has_more || result.items.length === 0) {
              return items;
            }
            offset += result.items.length;
          }
        })(),
        (async () => {
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
            if (!result.pagination.has_more || result.items.length === 0) {
              return items;
            }
            offset += result.items.length;
          }
        })(),
      ]);
      setUsers(userItems);
      setRoles(roleItems);
      setRoleId((current) => {
        const currentRoleIsActive = roleItems.some(
          (role) => role.id === current && !role.is_deleted,
        );
        return currentRoleIsActive
          ? current
          : (roleItems.find((role) => !role.is_deleted)?.id ?? "");
      });
      return null;
    } catch (reason) {
      return reason;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let mounted = true;
    void refreshLists().then((reason) => {
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
    const reason = await refreshLists();
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
    // replace the rendered lists with an authoritative response.
    const refreshError = await refreshLists();
    if (actionError) {
      const message = safeErrorMessage(actionError, "mutation");
      setError(
        refreshError
          ? `${message} ${safeErrorMessage(refreshError, "load")}`
          : `${message} The lists were refreshed.`,
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

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!roleId) return;
    await runMutation(
      "invite",
      () =>
        apiFetch<User>("/users", {
          method: "POST",
          body: JSON.stringify({ email, username, role_id: roleId }),
        }),
      "Invitation sent.",
      () => {
        setEmail("");
        setUsername("");
      },
    );
  }

  function confirmDisable(user: User) {
    if (
      !window.confirm(
        `Disable ${user.username}? They will lose access immediately.`,
      )
    ) {
      return;
    }
    void runMutation(
      `disable-${user.id}`,
      () =>
        apiFetch<User>(`/users/${user.id}`, {
          method: "PATCH",
          body: JSON.stringify({ status: "disabled" }),
        }),
      `${user.username} was disabled.`,
    );
  }

  function confirmDelete(user: User) {
    if (
      !window.confirm(
        `Delete ${user.username}? This keeps the account for possible restoration.`,
      )
    ) {
      return;
    }
    setEditDraft(null);
    void runMutation(
      `delete-${user.id}`,
      () => apiFetch(`/users/${user.id}`, { method: "DELETE" }),
      `${user.username} was deleted.`,
    );
  }

  function editUser(user: User) {
    setError("");
    setNotice("");
    setEditDraft({
      id: user.id,
      username: user.username,
      roleId: user.role_id,
    });
  }

  async function saveUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editDraft) return;
    const draft = editDraft;
    await runMutation(
      `edit-${draft.id}`,
      () =>
        apiFetch<User>(`/users/${draft.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            username: draft.username,
            role_id: draft.roleId,
          }),
        }),
      "User details updated.",
      () => setEditDraft(null),
    );
  }

  function roleName(user: User) {
    const role = roles.find((item) => item.id === user.role_id);
    if (!role) return "Unknown role";
    return role.is_deleted ? `${role.role} (archived)` : role.role;
  }

  const activeRoles = roles.filter((role) => !role.is_deleted);

  return (
    <AppPage>
      <PageHeader
        eyebrow="Administration"
        title="People"
        description="Invite staff accounts, maintain access, and keep each profile assigned to the right role. Invitation acceptance remains in the secure email setup flow."
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
      <div className="grid gap-5 lg:grid-cols-[1fr_0.44fr]">
        <Card>
          <CardHeader>
            <CardTitle>People</CardTitle>
            <CardDescription>
              All profiles, including deleted accounts, loaded{" "}
              {ADMINISTRATION_LIMIT} at a time.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {loading && users.length === 0 ? (
              <p className="text-muted-foreground p-5 text-sm" role="status">
                Loading people…
              </p>
            ) : users.length === 0 ? (
              <p className="text-muted-foreground p-5 text-sm">
                No people found.
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
                {users.map((user) => (
                  <div
                    key={user.id}
                    data-user-id={user.id}
                    className="border-border flex flex-col gap-4 border-b p-5 last:border-b-0 sm:flex-row sm:items-start"
                  >
                    <div className="flex min-w-0 flex-1 gap-3">
                      <div className="bg-accent text-accent-foreground grid size-9 shrink-0 place-items-center rounded-full">
                        <UserRound size={17} aria-hidden="true" />
                      </div>
                      <div className="min-w-0">
                        <p className="font-medium break-words">
                          {user.username}
                        </p>
                        <p className="text-muted-foreground mt-1 text-sm break-all">
                          {user.email}
                        </p>
                        <p className="text-muted-foreground mt-2 flex items-center gap-1.5 text-xs">
                          <ShieldCheck size={13} aria-hidden="true" />
                          <span>Role: {roleName(user)}</span>
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-col items-start gap-3 sm:items-end">
                      <Badge variant={statusVariant(user)}>
                        {statusLabel(user)}
                      </Badge>
                      <div className="flex flex-wrap gap-2">
                        {user.status === "pending" && !user.is_deleted && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            aria-label={`Resend invitation to ${user.email}`}
                            onClick={() =>
                              void runMutation(
                                `resend-${user.id}`,
                                () =>
                                  apiFetch<User>(
                                    `/auth/invitations/${user.id}/resend`,
                                    { method: "POST" },
                                  ),
                                "Invitation resent.",
                              )
                            }
                            disabled={!!busyAction}
                          >
                            <Mail aria-hidden="true" /> Resend
                          </Button>
                        )}
                        {user.status === "disabled" && !user.is_deleted && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            aria-label={`Activate ${user.username}`}
                            onClick={() =>
                              void runMutation(
                                `activate-${user.id}`,
                                () =>
                                  apiFetch<User>(`/users/${user.id}`, {
                                    method: "PATCH",
                                    body: JSON.stringify({ status: "active" }),
                                  }),
                                `${user.username} was activated.`,
                              )
                            }
                            disabled={!!busyAction}
                          >
                            <UserRoundCheck aria-hidden="true" /> Activate
                          </Button>
                        )}
                        {user.status === "active" && !user.is_deleted && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            aria-label={`Disable ${user.username}`}
                            onClick={() => confirmDisable(user)}
                            disabled={!!busyAction}
                          >
                            <UserRoundX aria-hidden="true" /> Disable
                          </Button>
                        )}
                        {!user.is_deleted && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            aria-label={`Edit username and role for ${user.username}`}
                            onClick={() => editUser(user)}
                            disabled={!!busyAction}
                          >
                            <Pencil aria-hidden="true" /> Edit
                          </Button>
                        )}
                        {!user.is_deleted ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label={`Delete ${user.username}`}
                            onClick={() => confirmDelete(user)}
                            disabled={!!busyAction}
                          >
                            <Trash2
                              className="text-destructive"
                              aria-hidden="true"
                            />{" "}
                            Delete
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            aria-label={`Restore ${user.username}`}
                            onClick={() =>
                              void runMutation(
                                `restore-${user.id}`,
                                () =>
                                  apiFetch<User>(`/users/${user.id}/restore`, {
                                    method: "POST",
                                  }),
                                `${user.username} was restored.`,
                              )
                            }
                            disabled={!!busyAction}
                          >
                            <RotateCcw aria-hidden="true" /> Restore
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Reconcile ${user.username} authentication`}
                          onClick={() =>
                            void runMutation(
                              `reconcile-${user.id}`,
                              () =>
                                apiFetch<User>(
                                  `/users/${user.id}/reconcile-auth`,
                                  {
                                    method: "POST",
                                  },
                                ),
                              `${user.username} authentication reconciled.`,
                            )
                          }
                          disabled={!!busyAction}
                        >
                          <RefreshCw aria-hidden="true" /> Reconcile
                        </Button>
                      </div>
                    </div>
                    {editDraft?.id === user.id && (
                      <form
                        className="bg-muted/40 border-border flex w-full flex-col gap-4 rounded-[var(--radius)] border p-4 sm:ml-12 sm:flex-row sm:flex-wrap sm:items-end"
                        onSubmit={saveUser}
                      >
                        <div className="min-w-52 flex-1 space-y-2">
                          <Label htmlFor={`edit-username-${user.id}`}>
                            Username for {user.username}
                          </Label>
                          <Input
                            id={`edit-username-${user.id}`}
                            required
                            minLength={3}
                            pattern="[A-Za-z0-9_-]+"
                            value={editDraft.username}
                            onChange={(event) =>
                              setEditDraft({
                                ...editDraft,
                                username: event.target.value,
                              })
                            }
                          />
                        </div>
                        <div className="min-w-52 flex-1 space-y-2">
                          <Label htmlFor={`edit-role-${user.id}`}>
                            Role for {user.username}
                          </Label>
                          <select
                            id={`edit-role-${user.id}`}
                            className="border-input bg-card text-foreground focus-visible:border-primary h-10 w-full rounded-[var(--radius)] border px-3 text-sm"
                            required
                            value={editDraft.roleId}
                            onChange={(event) =>
                              setEditDraft({
                                ...editDraft,
                                roleId: event.target.value,
                              })
                            }
                          >
                            {activeRoles.map((role) => (
                              <option value={role.id} key={role.id}>
                                {role.role}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="submit"
                            size="sm"
                            disabled={!!busyAction}
                          >
                            <Check aria-hidden="true" /> Save changes
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditDraft(null)}
                            disabled={!!busyAction}
                          >
                            Cancel
                          </Button>
                        </div>
                      </form>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Invite staff user</CardTitle>
            <CardDescription>
              The invitation email starts the user&apos;s own password setup.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={invite}>
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
                  minLength={3}
                  pattern="[A-Za-z0-9_-]+"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="staff-role">Role</Label>
                <select
                  id="staff-role"
                  className="border-input bg-card text-foreground focus-visible:border-primary h-10 w-full rounded-[var(--radius)] border px-3 text-sm"
                  required
                  value={roleId}
                  onChange={(event) => setRoleId(event.target.value)}
                  disabled={activeRoles.length === 0 || !!busyAction}
                >
                  {activeRoles.length === 0 ? (
                    <option value="">No active roles available</option>
                  ) : (
                    activeRoles.map((role) => (
                      <option value={role.id} key={role.id}>
                        {role.role}
                      </option>
                    ))
                  )}
                </select>
              </div>
              <Button className="w-full" disabled={!!busyAction || !roleId}>
                <Mail aria-hidden="true" />
                {busyAction === "invite" ? (
                  "Sending…"
                ) : (
                  <>
                    <Plus aria-hidden="true" /> Send invitation
                  </>
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </AppPage>
  );
}
