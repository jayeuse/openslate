"use client";

import { createElement } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { BoardGrant } from "../adapters/board-grants-api";
import {
  PAGE_SIZE,
  useServerBoardGrants,
  type PrincipalType,
  type Permission,
  type Effect,
} from "../hooks/use-server-board-grants";
export {
  emptyBoardGrantsState,
  transitionBoardGrantsState,
} from "../hooks/use-server-board-grants";
import { ConfirmAction } from "./ui";

function labelForGrant(grant: BoardGrant): string {
  switch (grant.principalType) {
    case "everyone":
      return "Everyone";
    case "user":
      return `Person: ${grant.principalLabel}`;
    case "role":
      return `Role: ${grant.principalLabel}`;
  }
}

export function grantRuleReference(
  grant: BoardGrant,
  grants: BoardGrant[],
): string {
  for (let length = 8; length < grant.id.length; length += 4) {
    const suffix = grant.id.slice(-length);
    if (
      grants.every(
        (candidate) =>
          candidate.id === grant.id || !candidate.id.endsWith(suffix),
      )
    )
      return `Rule ${suffix}`;
  }
  return `Rule ${grant.id}`;
}

export function revokeConfirmationText(
  grant: BoardGrant,
  grants: BoardGrant[],
): string {
  return `Revoke ${grant.effect} ${grant.permission} for ${labelForGrant(grant)} (${grantRuleReference(grant, grants)})?`;
}

export function BoardGrantsDisplay({
  grants,
  total,
  pending,
  canMutate,
  onRevoke,
}: {
  grants: BoardGrant[];
  total: number;
  pending: boolean;
  canMutate: boolean;
  onRevoke?: (grantId: string) => void;
}) {
  return createElement(
    "section",
    { "aria-label": "Board grant rules", className: "min-w-0 space-y-3" },
    createElement(
      "div",
      null,
      createElement(
        "h2",
        { className: "text-lg font-semibold" },
        "Board grant rules",
      ),
      createElement(
        "p",
        { className: "text-muted-foreground mt-1 text-sm" },
        "These are explicit rules, not a person's effective access. Use Preview Board access to check the result for an active person. Event and announcement audiences may narrow content visibility further.",
      ),
    ),
    createElement(
      "p",
      { role: "status", className: "text-muted-foreground text-sm" },
      `${total} grant rules`,
    ),
    grants.length === 0
      ? createElement(
          "p",
          {
            className:
              "border-border text-muted-foreground rounded-md border border-dashed p-4 text-sm",
          },
          "No grant rules on this page.",
        )
      : createElement(
          "ul",
          { className: "space-y-2" },
          ...grants.map((grant) =>
            createElement(
              "li",
              {
                key: grant.id,
                className:
                  "border-border bg-card flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-md border p-3",
              },
              createElement(
                "div",
                { className: "min-w-0 text-sm" },
                createElement(
                  "p",
                  { className: "font-medium" },
                  labelForGrant(grant),
                ),
                createElement(
                  "p",
                  { className: "text-muted-foreground" },
                  `${grant.effect === "allow" ? "Allow" : "Deny"} · ${grant.permission === "view" ? "View" : grant.permission === "edit" ? "Edit" : "Manage"}`,
                ),
                createElement(
                  "p",
                  { className: "text-muted-foreground text-xs" },
                  grantRuleReference(grant, grants),
                ),
              ),
              canMutate
                ? createElement(
                    "button",
                    {
                      type: "button",
                      className:
                        "border-border bg-card text-foreground focus-visible:outline-ring min-h-11 rounded-md border px-4 text-sm focus-visible:outline-2 focus-visible:outline-offset-2",
                      disabled: pending,
                      onClick: () => onRevoke?.(grant.id),
                      "aria-label": `Revoke ${grant.effect} ${grant.permission} ${labelForGrant(grant)} ${grantRuleReference(grant, grants)}`,
                    },
                    "Revoke",
                  )
                : null,
            ),
          ),
        ),
  );
}

function BoardGrantsForBoard({
  boardId,
  boardActive,
  refreshKey,
  onAccessDenied,
}: {
  boardId: string;
  boardActive: boolean;
  refreshKey: number;
  onAccessDenied?: (boardId: string) => void;
}) {
  const {
    id,
    key,
    visible,
    visibleUsers,
    grantOffset,
    setGrantOffset,
    roleOffset,
    setRoleOffset,
    roleSearchInput,
    setRoleSearchInput,
    userOffset,
    setUserOffset,
    userSearchInput,
    setUserSearchInput,
    setUserReload,
    setReload,
    principalType,
    setPrincipalType,
    setPrincipalId,
    permission,
    setPermission,
    effect,
    setEffect,
    pending,
    error,
    notice,
    setNotice,
    conflict,
    setConflict,
    accessDenied,
    choiceValid,
    canMutate,
    selectedRole,
    selectedUser,
    revokeTarget,
    setRevokeChoice,
    saveGrant,
    revokeGrant,
    searchRoles,
    searchUsers,
  } = useServerBoardGrants({
    boardId,
    boardActive,
    refreshKey,
    onAccessDenied,
  });

  if (!boardActive)
    return (
      <p role="status" className="text-muted-foreground text-sm">
        Restore this Board before changing its grant rules.
      </p>
    );
  if (accessDenied)
    return (
      <Alert variant="destructive">
        Board grant access is unavailable with your current permissions.
      </Alert>
    );

  return (
    <section aria-label="Manage Board grants" className="min-w-0 space-y-5">
      {visible.status === "loading" || visible.status === "idle" ? (
        <p role="status" className="text-muted-foreground text-sm">
          Checking Board grant access…
        </p>
      ) : null}
      {visible.status === "error" && (
        <Alert variant="destructive">
          <p>{visible.error}</p>
          {!conflict && (
            <Button
              type="button"
              variant="outline"
              className="mt-3 min-h-11"
              onClick={() => setReload((value) => value + 1)}
            >
              Retry Board grants
            </Button>
          )}
        </Alert>
      )}
      {error && <Alert variant="destructive">{error}</Alert>}
      {notice && (
        <p role="status" className="text-muted-foreground text-sm">
          {notice}
        </p>
      )}
      {conflict && (
        <Alert>
          <p>
            Board rules changed elsewhere. Your choice is kept, but it will not
            be applied until you review the latest rules.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {conflict.phase === "reload" ? (
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={pending}
                onClick={() => setReload((value) => value + 1)}
              >
                Reload latest grant rules
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={pending}
                  onClick={() => setConflict(null)}
                >
                  Keep latest rules
                </Button>
                {conflict.kind === "create" ? (
                  <Button
                    type="button"
                    className="min-h-11"
                    disabled={pending || !choiceValid}
                    onClick={() => {
                      setConflict(null);
                      setNotice(
                        "Review your choice, then select Add rule to apply it.",
                      );
                    }}
                  >
                    Review my choice
                  </Button>
                ) : visible.page?.items.some(
                    (item) => item.id === conflict.grantId,
                  ) ? (
                  <Button
                    type="button"
                    className="min-h-11"
                    disabled={pending}
                    onClick={() => setConflict(null)}
                  >
                    Review rule to revoke
                  </Button>
                ) : (
                  <p className="text-sm">The rule is no longer on this page.</p>
                )}
              </>
            )}
          </div>
        </Alert>
      )}
      {canMutate && visible.page && visible.roles && (
        <>
          <BoardGrantsDisplay
            grants={visible.page.items}
            total={visible.page.pagination.total}
            pending={pending || conflict !== null}
            canMutate={conflict === null}
            onRevoke={(grantId) => setRevokeChoice({ key, grantId })}
          />
          <ConfirmAction
            open={revokeTarget !== null}
            title="Revoke Board grant rule?"
            description={
              revokeTarget
                ? revokeConfirmationText(revokeTarget, visible.page.items)
                : ""
            }
            action="Revoke rule"
            onConfirm={() => {
              if (revokeTarget) void revokeGrant(revokeTarget.id);
            }}
            onCancel={() => setRevokeChoice(null)}
            disabled={pending}
          />
          {(visible.page.pagination.total > PAGE_SIZE || grantOffset > 0) && (
            <nav
              aria-label="Grant rule pages"
              className="flex flex-wrap items-center gap-2"
            >
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={pending || conflict !== null || grantOffset === 0}
                onClick={() =>
                  setGrantOffset((value) => Math.max(0, value - PAGE_SIZE))
                }
              >
                Previous
              </Button>
              <span className="text-muted-foreground text-sm">
                Page {Math.floor(grantOffset / PAGE_SIZE) + 1}
              </span>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={
                  pending ||
                  conflict !== null ||
                  !visible.page.pagination.hasMore
                }
                onClick={() => setGrantOffset((value) => value + PAGE_SIZE)}
              >
                Next
              </Button>
            </nav>
          )}
          <form
            className="border-border space-y-4 border-t pt-5"
            onSubmit={(event) => {
              event.preventDefault();
              void saveGrant();
            }}
          >
            <h3 className="font-semibold">Add grant rule</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label
                  htmlFor={`${id}-principal`}
                  className="mb-1 block text-sm font-medium"
                >
                  Who
                </label>
                <select
                  id={`${id}-principal`}
                  className="border-input bg-card min-h-11 w-full rounded-md border px-3"
                  value={principalType}
                  disabled={pending || conflict !== null}
                  onChange={(event) => {
                    setPrincipalType(event.target.value as PrincipalType);
                    setPrincipalId("");
                  }}
                >
                  <option value="everyone">Everyone</option>
                  <option value="user">Person</option>
                  <option value="role">Role</option>
                </select>
              </div>
              <div>
                <label
                  htmlFor={`${id}-effect`}
                  className="mb-1 block text-sm font-medium"
                >
                  Decision
                </label>
                <select
                  id={`${id}-effect`}
                  className="border-input bg-card min-h-11 w-full rounded-md border px-3"
                  value={effect}
                  disabled={pending || conflict !== null}
                  onChange={(event) => setEffect(event.target.value as Effect)}
                >
                  <option value="allow">Allow</option>
                  <option value="deny">Deny</option>
                </select>
              </div>
              <div>
                <label
                  htmlFor={`${id}-permission`}
                  className="mb-1 block text-sm font-medium"
                >
                  Board permission
                </label>
                <select
                  id={`${id}-permission`}
                  className="border-input bg-card min-h-11 w-full rounded-md border px-3"
                  value={permission}
                  disabled={pending || conflict !== null}
                  onChange={(event) =>
                    setPermission(event.target.value as Permission)
                  }
                >
                  <option value="view">View</option>
                  <option value="edit">Edit</option>
                  <option value="manage">Manage</option>
                </select>
              </div>
            </div>
            {principalType === "role" && (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <Input
                    aria-label="Find a role"
                    className="min-h-11 max-w-sm"
                    maxLength={100}
                    value={roleSearchInput}
                    disabled={pending || conflict !== null}
                    onChange={(event) => setRoleSearchInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        searchRoles();
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={pending || conflict !== null}
                    onClick={searchRoles}
                  >
                    Search roles
                  </Button>
                </div>
                <label
                  htmlFor={`${id}-role`}
                  className="block text-sm font-medium"
                >
                  Role
                </label>
                <select
                  id={`${id}-role`}
                  className="border-input bg-card min-h-11 w-full max-w-md rounded-md border px-3"
                  value={selectedRole?.id ?? ""}
                  disabled={pending || conflict !== null}
                  onChange={(event) => setPrincipalId(event.target.value)}
                >
                  <option value="">Choose an active role</option>
                  {visible.roles.items.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.role}
                    </option>
                  ))}
                </select>
                <nav
                  aria-label="Role choices pages"
                  className="flex flex-wrap items-center gap-2"
                >
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={pending || conflict !== null || roleOffset === 0}
                    onClick={() => {
                      setPrincipalId("");
                      setRoleOffset((value) => Math.max(0, value - PAGE_SIZE));
                    }}
                  >
                    Previous roles
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={
                      pending ||
                      conflict !== null ||
                      !visible.roles.pagination.hasMore
                    }
                    onClick={() => {
                      setPrincipalId("");
                      setRoleOffset((value) => value + PAGE_SIZE);
                    }}
                  >
                    Next roles
                  </Button>
                </nav>
              </div>
            )}
            {principalType === "user" && (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <Input
                    aria-label="Find a person"
                    className="min-h-11 max-w-sm"
                    maxLength={100}
                    value={userSearchInput}
                    disabled={pending || conflict !== null}
                    onChange={(event) => setUserSearchInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        searchUsers();
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={pending || conflict !== null}
                    onClick={searchUsers}
                  >
                    Search people
                  </Button>
                </div>
                {visibleUsers?.status === "loading" || !visibleUsers ? (
                  <p role="status">Loading active people…</p>
                ) : null}
                {visibleUsers?.status === "error" && (
                  <Alert variant="destructive">
                    <p>{visibleUsers.error}</p>
                    <Button
                      type="button"
                      variant="outline"
                      className="mt-3 min-h-11"
                      onClick={() => setUserReload((value) => value + 1)}
                    >
                      Retry people
                    </Button>
                  </Alert>
                )}
                {visibleUsers?.page && (
                  <>
                    <label
                      htmlFor={`${id}-user`}
                      className="block text-sm font-medium"
                    >
                      Person
                    </label>
                    <select
                      id={`${id}-user`}
                      className="border-input bg-card min-h-11 w-full max-w-md rounded-md border px-3"
                      value={selectedUser?.id ?? ""}
                      disabled={pending || conflict !== null}
                      onChange={(event) => setPrincipalId(event.target.value)}
                    >
                      <option value="">Choose an active person</option>
                      {visibleUsers.page.items.map((user) => (
                        <option key={user.id} value={user.id}>
                          {user.username}
                        </option>
                      ))}
                    </select>
                    <nav
                      aria-label="Person choices pages"
                      className="flex flex-wrap items-center gap-2"
                    >
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11"
                        disabled={
                          pending || conflict !== null || userOffset === 0
                        }
                        onClick={() => {
                          setPrincipalId("");
                          setUserOffset((value) =>
                            Math.max(0, value - PAGE_SIZE),
                          );
                        }}
                      >
                        Previous people
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11"
                        disabled={
                          pending ||
                          conflict !== null ||
                          !visibleUsers.page?.pagination.hasMore
                        }
                        onClick={() => {
                          setPrincipalId("");
                          setUserOffset((value) => value + PAGE_SIZE);
                        }}
                      >
                        Next people
                      </Button>
                    </nav>
                  </>
                )}
              </div>
            )}
            <Button
              type="submit"
              className="min-h-11"
              disabled={pending || conflict !== null || !choiceValid}
            >
              {pending ? "Saving…" : "Add rule"}
            </Button>
          </form>
        </>
      )}
    </section>
  );
}

export function ServerBackedBoardGrants({
  boardId,
  boardActive,
  refreshKey,
  onAccessDenied,
}: {
  boardId: string;
  boardActive: boolean;
  refreshKey: number;
  onAccessDenied?: (boardId: string) => void;
}) {
  return (
    <BoardGrantsForBoard
      key={boardId}
      boardId={boardId}
      boardActive={boardActive}
      refreshKey={refreshKey}
      onAccessDenied={onAccessDenied}
    />
  );
}
