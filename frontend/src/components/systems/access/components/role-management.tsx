"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Check, Minus, Scale } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { PaginationControls } from "@/components/ui/pagination-controls";
import type { AccessController } from "../state/controller";
import type { EditorIntent } from "../helpers/editor-helpers";
import type { Role } from "../domain/model";
import {
  readAccessRoleDraft,
  type AccessRoleDraft,
} from "../state/draft-journal";
import { useVerifiedWorkspaceUserId } from "../../shared/runtime/workspace-identity";
import { RoleEditor } from "./role-group-editors";
import {
  completeCollection,
  pageCollection,
} from "../../shared/helpers/sample-collections";

export type RoleManagementControls = {
  createRole(): void;
  editRole(role: Role): void;
  duplicateRole(role: Role): Promise<void>;
  compareRoles(): void;
  notice: string;
  ready: boolean;
  dialogOpen: boolean;
};

export type RoleManagementProps = {
  controller: AccessController;
  children: (controls: RoleManagementControls) => ReactNode;
};

type ComparisonPermission = { id: string; name: string };
type ComparisonStep = "select" | "results";
const COMPARISON_PAGE_SIZE = 5;

function roleDescription(role: Role): string {
  if (role.description) return role.description;
  if (role.system === "admin")
    return "Full protected administration of the workspace.";
  if (role.system === "member")
    return "Standard access to assigned workspace resources.";
  return "No description";
}

function draftFromTemplate(
  template: AccessController["state"]["templates"][number],
): Role {
  return {
    id: "draft:" + template.id,
    name: template.id === "template:blank" ? "" : template.name,
    description: template.description,
    builtin: false,
    grants: [...template.grants],
  };
}

export function RoleManagement({ controller, children }: RoleManagementProps) {
  const userId = useVerifiedWorkspaceUserId();
  const [draft, setDraft] = useState<Role | null>(null);
  const [draftIntent, setDraftIntent] = useState<EditorIntent>("edit");
  const [restoredValues, setRestoredValues] = useState<
    AccessRoleDraft["values"] | null
  >(null);
  const [restoredUncertain, setRestoredUncertain] = useState(false);
  const [journalIssue, setJournalIssue] = useState("");
  const restoredUserId = useRef<string | null>(null);
  const [journalUserId, setJournalUserId] = useState<string | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareStep, setCompareStep] = useState<ComparisonStep>("select");
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [compareQuery, setCompareQuery] = useState("");
  const [comparePage, setComparePage] = useState(0);
  const [message, setMessage] = useState("");
  const permissionNames = new Map(
    controller.permissionCatalog.map((permission) => [
      permission.id,
      permission.name,
    ]),
  );

  useEffect(() => {
    if (restoredUserId.current === userId) return;
    restoredUserId.current = userId;
    const stored = readAccessRoleDraft(userId);
    if (stored.value) {
      setDraft(stored.value.baseline);
      setDraftIntent(stored.value.intent);
      setRestoredValues(stored.value.values);
    }
    setRestoredUncertain(stored.status === "uncertain");
    if (stored.status === "unavailable")
      setJournalIssue(
        "Browser draft storage is unavailable. Role changes may not survive reload.",
      );
    else if (stored.status === "invalid")
      setJournalIssue(
        "A saved role draft could not be safely restored. It was not applied.",
      );
    setJournalUserId(userId);
  }, [userId]);

  const allComparisonRoles = controller.state.roles
    .filter((role) =>
      (role.name + " " + roleDescription(role))
        .toLowerCase()
        .includes(compareQuery.trim().toLowerCase()),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  const comparePageResult = pageCollection(
    completeCollection(
      allComparisonRoles,
      JSON.stringify(["role-comparison", compareQuery.trim().toLowerCase()]),
    ),
    comparePage * COMPARISON_PAGE_SIZE,
    COMPARISON_PAGE_SIZE,
  );
  const comparePageCount = Math.max(
    1,
    Math.ceil(comparePageResult.total / comparePageResult.limit),
  );
  const compared = compareIds
    .map((id) => controller.state.roles.find((role) => role.id === id))
    .filter((role): role is Role => Boolean(role));
  const comparisonPermissions: ComparisonPermission[] = [
    ...controller.permissionCatalog.map(({ id, name }) => ({ id, name })),
    ...Array.from(new Set(compared.flatMap((role) => role.grants)))
      .filter((grant) => !permissionNames.has(grant))
      .map((id) => ({ id, name: id })),
  ];
  const recommendedTemplateId = controller.state.templates.some(
    (template) => template.id === "template:viewer",
  )
    ? "template:viewer"
    : undefined;
  const comparisonColumns = useMemo<DataTableColumn<ComparisonPermission>[]>(
    () => [
      {
        id: "permission",
        header: "Permission",
        cell: ({ row }) => (
          <span className="font-medium">{row.original.name}</span>
        ),
      },
      ...compared.map((role): DataTableColumn<ComparisonPermission> => ({
        id: role.id,
        header: () => (
          <div className="min-w-40 space-y-1 py-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-foreground font-medium">{role.name}</span>
              {role.builtin && <Badge variant="secondary">Built-in</Badge>}
            </div>
            <span className="text-muted-foreground block text-xs font-normal">
              {
                controller.state.identities.filter(
                  (identity) => identity.roleId === role.id,
                ).length
              }{" "}
              members · {role.grants.length} grants
            </span>
          </div>
        ),
        cell: ({ row }) => {
          const granted = role.grants.includes(row.original.id);
          const StatusIcon = granted ? Check : Minus;
          return (
            <span className="inline-flex min-w-28 items-center gap-2 text-sm">
              <StatusIcon
                aria-hidden="true"
                className="text-muted-foreground size-4 shrink-0"
              />
              {granted ? "Granted" : "Not granted"}
            </span>
          );
        },
      })),
    ],
    [compared, controller.state.identities],
  );

  function startCompare() {
    setMessage("");
    setCompareIds([]);
    setCompareQuery("");
    setComparePage(0);
    setCompareStep("select");
    setCompareOpen(true);
  }

  function toggleCompare(roleId: string, checked: boolean) {
    setMessage("");
    setCompareIds((current) => {
      if (!checked) return current.filter((id) => id !== roleId);
      if (current.length >= 4) {
        setMessage("Compare supports up to four roles.");
        return current;
      }
      return [...current, roleId];
    });
  }

  async function duplicateRole(role: Role) {
    if (controller.isPending()) {
      setMessage("Another Access change is already in progress.");
      return;
    }
    const result = await controller.actions.duplicateRole(role.id);
    setMessage(result.ok ? "Duplicated " + role.name + "." : result.error);
  }

  function openRole(role: Role) {
    if (restoredUncertain) return;
    setRestoredValues(null);
    setDraftIntent("edit");
    setDraft({ ...role, grants: [...role.grants] });
  }

  function editRole(role: Role) {
    openRole(role);
  }

  function createRoleFromTemplate(template: Role) {
    if (restoredUncertain) return;
    setRestoredValues(null);
    setDraftIntent("create");
    setDraft(template);
  }

  function startCreateRole() {
    if (restoredUncertain) return;
    if (controller.state.templates.length) {
      setTemplateOpen(true);
      return;
    }
    createRoleFromTemplate({
      id: "draft:new-role",
      name: "",
      description: "",
      builtin: false,
      grants: [],
    });
  }

  const controls: RoleManagementControls = {
    createRole: startCreateRole,
    editRole,
    duplicateRole,
    compareRoles: startCompare,
    notice: message,
    ready: journalUserId === userId,
    dialogOpen: draft !== null || templateOpen || compareOpen,
  };

  return (
    <>
      {children(controls)}

      {journalIssue ? (
        <Alert role="alert" variant="warning">
          {journalIssue}
        </Alert>
      ) : null}

      <Dialog open={templateOpen} onOpenChange={setTemplateOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Start a role draft</DialogTitle>
            <DialogDescription>
              Choosing a template only opens a draft. Nothing is saved until you
              review and apply it.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            {controller.state.templates.map((template) => (
              <button
                key={template.id}
                className="border-border hover:bg-muted focus-visible:outline-ring min-h-24 rounded-lg border p-4 text-left transition-colors outline-none focus-visible:outline-2 motion-reduce:transition-none"
                onClick={() => {
                  setTemplateOpen(false);
                  createRoleFromTemplate(draftFromTemplate(template));
                }}
              >
                <span className="flex items-center gap-2 font-medium">
                  {template.name}
                  {template.id === recommendedTemplateId && (
                    <Badge variant="secondary">Recommended</Badge>
                  )}
                </span>
                <span className="text-muted-foreground mt-1 block text-sm">
                  {template.description}
                </span>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={compareOpen} onOpenChange={setCompareOpen}>
        <DialogContent className="grid max-h-[90dvh] max-w-5xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden">
          <DialogHeader>
            <DialogTitle>Compare roles</DialogTitle>
            <DialogDescription>
              {compareStep === "select"
                ? "Choose two to four roles to compare their standard permissions."
                : "Compare the standard permissions of these roles. Not granted means the role does not include that permission."}
            </DialogDescription>
          </DialogHeader>

          {compareStep === "select" ? (
            <div className="flex min-h-0 flex-col gap-3 overflow-hidden">
              <Input
                type="search"
                aria-label="Search roles to compare"
                placeholder="Name or description"
                value={compareQuery}
                onChange={(event) => {
                  setCompareQuery(event.target.value);
                  setComparePage(0);
                }}
              />
              {comparePageResult.items.length ? (
                <div
                  role="group"
                  aria-label="Roles to compare"
                  className="min-h-0 flex-1 space-y-2 overflow-auto rounded-md border p-2"
                >
                  {comparePageResult.items.map((role) => {
                    const selected = compareIds.includes(role.id);
                    return (
                      <label
                        key={role.id}
                        className="hover:bg-muted flex min-h-12 cursor-pointer items-center justify-between gap-3 rounded-md px-2"
                      >
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-2 font-medium">
                            {role.name}
                            {role.builtin && (
                              <Badge variant="secondary">Built-in</Badge>
                            )}
                          </span>
                          <span className="text-muted-foreground block truncate text-sm">
                            {roleDescription(role)}
                          </span>
                        </span>
                        <Checkbox
                          aria-label={"Compare " + role.name}
                          checked={selected}
                          disabled={!selected && compareIds.length >= 4}
                          onCheckedChange={(checked) =>
                            toggleCompare(role.id, checked === true)
                          }
                        />
                      </label>
                    );
                  })}
                </div>
              ) : (
                <p className="text-muted-foreground rounded-md border p-4 text-sm">
                  No roles found. Adjust the search.
                </p>
              )}

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-muted-foreground text-sm" aria-live="polite">
                  Showing{" "}
                  {comparePageResult.total === 0
                    ? 0
                    : comparePageResult.offset + 1}
                  –
                  {Math.min(
                    comparePageResult.offset + comparePageResult.limit,
                    comparePageResult.total,
                  )}{" "}
                  of {comparePageResult.total} roles
                </p>
                <PaginationControls
                  ariaLabel="Role comparison pages"
                  className="w-auto"
                  pageCount={comparePageCount}
                  pageIndex={comparePageResult.offset / comparePageResult.limit}
                  onPageIndexChange={setComparePage}
                />
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-col gap-3 overflow-hidden">
              <div
                role="region"
                aria-label="Role permission comparison"
                tabIndex={0}
                className="focus-visible:outline-ring min-h-0 flex-1 overflow-auto rounded-md border focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                {comparisonPermissions.length ? (
                  <div className="min-w-[40rem]">
                    <DataTable
                      ariaLabel="Role permission comparison"
                      columns={comparisonColumns}
                      data={comparisonPermissions}
                      getRowId={(permission) => permission.id}
                      className="min-w-[40rem]"
                    />
                  </div>
                ) : (
                  <p className="text-muted-foreground p-4 text-sm">
                    No permissions are available to compare.
                  </p>
                )}
              </div>
              <div className="space-y-1">
                <p className="text-muted-foreground text-sm">
                  These are standard role permissions. Custom rules can change
                  actual access.
                </p>
                {compared.some((role) => role.system === "admin") && (
                  <p className="text-muted-foreground text-sm">
                    Protected Administrator management access is additional to
                    these data permissions.
                  </p>
                )}
              </div>
            </div>
          )}

          <DialogFooter>
            {compareStep === "select" ? (
              <>
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() => setCompareOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  className="min-h-11"
                  disabled={compareIds.length < 2}
                  onClick={() => setCompareStep("results")}
                >
                  <Scale data-icon="inline-start" />
                  Compare roles ({compareIds.length})
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() => setCompareStep("select")}
                >
                  Change selection
                </Button>
                <Button
                  className="min-h-11"
                  onClick={() => setCompareOpen(false)}
                >
                  Close
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RoleEditor
        key={draft?.id ?? "closed-role"}
        controller={controller}
        draft={draft}
        intent={draftIntent}
        restoredValues={restoredValues}
        restoredUncertain={restoredUncertain}
        onClose={() => {
          setDraft(null);
          setRestoredValues(null);
          setRestoredUncertain(false);
        }}
      />
    </>
  );
}
