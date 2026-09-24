"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ChevronDown, Lock, Search, Unlock } from "lucide-react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

import {
  completeCollection,
  pageCollection,
} from "../../shared/helpers/sample-collections";
import type { AccessController } from "../state/controller";
import { useAccessDraftRegistration } from "../state/draft-navigation";
import {
  clearAccessRulesDraft,
  readAccessRulesDraft,
  writeAccessRulesDraft,
} from "../state/draft-journal";
import { useVerifiedWorkspaceUserId } from "../../shared/runtime/workspace-identity";
import type {
  AccessDecision,
  AccessRule,
  AccessScopeKind,
  AccessScopeRef,
  AccessSubjectRef,
} from "../domain/policy";

export type RulesViewProps = {
  controller: AccessController;
  initialSubject?: AccessSubjectRef;
};

type Selection = {
  subject: AccessSubjectRef;
  scope: AccessScopeRef;
};
type ConflictResolution = {
  choice: "current" | "draft";
  current: AccessRule | null;
};
type Permission = AccessController["permissionCatalog"][number];

const PAGE_SIZE = 5;
const subjectKinds: AccessSubjectRef["kind"][] = [
  "everyone",
  "role",
  "group",
  "identity",
];
function title(value: string): string {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function sameSubject(left: AccessSubjectRef, right: AccessSubjectRef): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "everyone" ||
      (right.kind !== "everyone" && left.id === right.id))
  );
}

function sameScope(left: AccessScopeRef, right: AccessScopeRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function sameRule(left: AccessRule, right: AccessRule): boolean {
  return (
    left.id === right.id &&
    left.decision === right.decision &&
    Boolean(left.locked) === Boolean(right.locked) &&
    left.startsAt === right.startsAt &&
    left.endsAt === right.endsAt
  );
}

function localDateTime(value?: string): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  const offset = parsed.getTimezoneOffset() * 60_000;
  return new Date(parsed.getTime() - offset).toISOString().slice(0, 16);
}

function dateTimeValue(value: string): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : value;
}

function groupByProduct<T extends { product: string }>(items: readonly T[]) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.product) ?? [];
    group.push(item);
    groups.set(item.product, group);
  }
  return groups;
}

function PermissionDetails({ permission }: { permission: Permission }) {
  return (
    <details className="group mt-2 rounded-md border">
      <summary className="focus-visible:outline-ring flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2">
        Technical details
        <ChevronDown
          aria-hidden="true"
          className="size-4 transition-transform group-open:rotate-180 motion-reduce:transition-none"
        />
      </summary>
      <p className="text-muted-foreground border-t px-3 py-2 text-xs">
        Permission ID: <code className="font-mono">{permission.id}</code>
      </p>
    </details>
  );
}

function permissionColumns(
  ruleFor: (permissionId: string) => AccessRule,
  onChange: (rule: AccessRule) => void,
): DataTableColumn<Permission>[] {
  return [
    {
      id: "permission",
      header: "Permission",
      cell: ({ row }) => {
        const permission = row.original;
        return (
          <div>
            <p className="font-medium">{permission.name}</p>
            <Badge variant="secondary" className="mt-2">
              {permission.product}
            </Badge>
            <PermissionDetails permission={permission} />
          </div>
        );
      },
    },
    {
      id: "decision",
      header: "Decision and conditions",
      cell: ({ row }) => {
        const permission = row.original;
        return (
          <RuleControls
            rule={ruleFor(permission.id)}
            permissionName={permission.name}
            idSuffix="desktop"
            onChange={onChange}
          />
        );
      },
    },
  ];
}

function RuleControls({
  rule,
  permissionName,
  idSuffix,
  onChange,
}: {
  rule: AccessRule;
  permissionName: string;
  idSuffix: "desktop" | "mobile";
  onChange: (rule: AccessRule) => void;
}) {
  const startsId = `${rule.id}-${idSuffix}-starts`;
  const endsId = `${rule.id}-${idSuffix}-ends`;
  return (
    <FieldGroup className="gap-3">
      <ToggleGroup
        aria-label={`${permissionName} decision`}
        value={[rule.decision]}
        onValueChange={(values) => {
          const decision = values[0] as AccessDecision | undefined;
          if (decision)
            onChange({
              ...rule,
              decision,
              locked: decision === "inherit" ? false : rule.locked,
            });
        }}
        variant="outline"
        spacing={0}
        className="w-full [&>button]:min-h-11 [&>button]:flex-1"
      >
        <ToggleGroupItem value="inherit">Use existing access</ToggleGroupItem>
        <ToggleGroupItem value="allow">Allow</ToggleGroupItem>
        <ToggleGroupItem value="deny">Deny</ToggleGroupItem>
      </ToggleGroup>
      <p className="text-muted-foreground text-xs">
        Use existing access follows broader or default access. A scope lock can
        still block more specific rules.
      </p>
      <details className="rounded-md border">
        <summary className="focus-visible:outline-ring flex min-h-11 cursor-pointer list-none items-center px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2">
          Conditions and scope lock
        </summary>
        <div className="space-y-3 border-t p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={startsId}>Starts</FieldLabel>
              <Input
                id={startsId}
                className="min-h-11"
                type="datetime-local"
                value={localDateTime(rule.startsAt)}
                onChange={(event) =>
                  onChange({
                    ...rule,
                    startsAt: dateTimeValue(event.target.value),
                  })
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={endsId}>Ends</FieldLabel>
              <Input
                id={endsId}
                className="min-h-11"
                type="datetime-local"
                value={localDateTime(rule.endsAt)}
                onChange={(event) =>
                  onChange({
                    ...rule,
                    endsAt: dateTimeValue(event.target.value),
                  })
                }
              />
            </Field>
          </div>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-full sm:w-auto"
            aria-pressed={rule.locked === true}
            onClick={() => onChange({ ...rule, locked: !rule.locked })}
          >
            {rule.locked ? (
              <Lock aria-hidden="true" data-icon="inline-start" />
            ) : (
              <Unlock aria-hidden="true" data-icon="inline-start" />
            )}
            {rule.locked ? "Locked at this scope" : "Lock at this scope"}
          </Button>
        </div>
      </details>
    </FieldGroup>
  );
}

export function RulesView({ controller, initialSubject }: RulesViewProps) {
  const userId = useVerifiedWorkspaceUserId();
  const { state, actions, permissionCatalog, scopeCatalog } = controller;
  const firstScope = scopeCatalog[0] ?? {
    kind: "workspace" as const,
    id: "workspace",
    name: "Workspace",
    product: "Workspace",
  };
  const [selection, setSelection] = useState<Selection>({
    subject: initialSubject ?? { kind: "everyone" },
    scope: { kind: firstScope.kind, id: firstScope.id },
  });
  const [drafts, setDrafts] = useState<Record<string, AccessRule>>({});
  const [baselines, setBaselines] = useState<Record<string, AccessRule | null>>(
    {},
  );
  const [journalReady, setJournalReady] = useState(false);
  const [journalIssue, setJournalIssue] = useState("");
  const [conflictResolutions, setConflictResolutions] = useState<
    Record<string, ConflictResolution>
  >({});
  const [query, setQuery] = useState("");
  const [modifiedOnly, setModifiedOnly] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [impactOpen, setImpactOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<Selection | null>(
    null,
  );
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const stored = readAccessRulesDraft(userId);
    if (stored.value) {
      const restoredDrafts = Object.fromEntries(
        stored.value.drafts.map((rule) => [rule.permissionId, rule]),
      );
      setSelection(stored.value.selection);
      setDrafts(restoredDrafts);
      setBaselines(stored.value.baselines);
    }
    if (stored.status === "unavailable")
      setJournalIssue(
        "Browser draft storage is unavailable. Keep this tab open and save your Rules changes; they may not survive reload.",
      );
    else if (stored.status === "invalid")
      setJournalIssue(
        "A saved Rules draft could not be safely restored. It was not applied.",
      );
    setJournalReady(true);
  }, [userId]);

  function clearDraftState(): boolean {
    if (!clearAccessRulesDraft(userId)) {
      setJournalIssue(
        "The browser could not clear your saved Rules draft. Keep editing or clear this site's browser data before leaving.",
      );
      return false;
    }
    setDrafts({});
    setBaselines({});
    setConflictResolutions({});
    setPendingSelection(null);
    setDiscardOpen(false);
    setImpactOpen(false);
    setConfirmOpen(false);
    setJournalIssue("");
    return true;
  }

  const selectedRules = state.rules.filter(
    (rule) =>
      sameSubject(rule.subject, selection.subject) &&
      sameScope(rule.scope, selection.scope),
  );
  const baseByPermission = new Map(
    selectedRules.map((rule) => [rule.permissionId, rule]),
  );
  const pending = Object.values(drafts).filter((rule) => {
    const current = baseByPermission.get(rule.permissionId);
    return !current || !sameRule(current, rule);
  });
  const dirty = pending.length > 0;
  useAccessDraftRegistration("rules-view", dirty, clearDraftState);
  const conflicts = pending.filter((rule) => {
    if (!Object.hasOwn(baselines, rule.permissionId)) return false;
    const baseline = baselines[rule.permissionId];
    const current = baseByPermission.get(rule.permissionId);
    if (baseline === null) return current !== undefined;
    return current === undefined || !sameRule(baseline, current);
  });
  function resolutionIsCurrent(rule: AccessRule): boolean {
    const resolution = conflictResolutions[rule.permissionId];
    if (!resolution) return false;
    const current = baseByPermission.get(rule.permissionId) ?? null;
    return resolution.current === null
      ? current === null
      : current !== null && sameRule(resolution.current, current);
  }
  const unresolvedConflicts = conflicts.filter(
    (rule) => !resolutionIsCurrent(rule),
  );
  const rulesToApply = pending.filter(
    (rule) =>
      !resolutionIsCurrent(rule) ||
      conflictResolutions[rule.permissionId]?.choice !== "current",
  );

  const subjectOptions =
    selection.subject.kind === "role"
      ? state.roles
      : selection.subject.kind === "group"
        ? state.groups
        : selection.subject.kind === "identity"
          ? state.identities
          : [];
  const scopesForKind = scopeCatalog.filter(
    (scope) => scope.kind === selection.scope.kind,
  );
  const availableScopeKinds = [
    ...new Set(scopeCatalog.map((scope) => scope.kind)),
  ];
  const selectedScopeEntry = scopeCatalog.find(
    (scope) =>
      scope.kind === selection.scope.kind && scope.id === selection.scope.id,
  );
  function subjectIsKnown(subject: AccessSubjectRef): boolean {
    switch (subject.kind) {
      case "everyone":
        return true;
      case "role":
        return state.roles.some((role) => role.id === subject.id);
      case "group":
        return state.groups.some((group) => group.id === subject.id);
      case "identity":
        return state.identities.some((identity) => identity.id === subject.id);
    }
  }
  const targetMissing =
    !subjectIsKnown(selection.subject) ||
    !selectedScopeEntry ||
    Object.keys(drafts).some(
      (permissionId) =>
        !permissionCatalog.some((permission) => permission.id === permissionId),
    );
  const normalizedQuery = query.trim().toLowerCase();
  const filteredPermissions = permissionCatalog.filter((permission) => {
    if (
      !selectedScopeEntry ||
      permission.product !== selectedScopeEntry.product
    )
      return false;
    const matches = `${permission.name} ${permission.product} ${permission.id}`
      .toLowerCase()
      .includes(normalizedQuery);
    return (
      matches &&
      (!modifiedOnly ||
        Boolean(drafts[permission.id] || baseByPermission.has(permission.id)))
    );
  });
  const pageResult = pageCollection(
    completeCollection(
      filteredPermissions,
      JSON.stringify([
        "rules",
        selection.subject.kind,
        selection.subject.kind === "everyone"
          ? "everyone"
          : selection.subject.id,
        selection.scope.kind,
        selection.scope.id,
        normalizedQuery,
        modifiedOnly,
      ]),
    ),
    pageIndex * PAGE_SIZE,
    PAGE_SIZE,
  );
  const pageCount = Math.max(1, Math.ceil(pageResult.total / pageResult.limit));
  const safePageIndex = pageResult.offset / pageResult.limit;
  const visiblePermissions = [...pageResult.items];
  const grouped = groupByProduct(visiblePermissions);

  function ruleFor(permissionId: string): AccessRule {
    return (
      drafts[permissionId] ??
      baseByPermission.get(permissionId) ?? {
        id: `rule:${selection.subject.kind}:${selection.subject.kind === "everyone" ? "everyone" : selection.subject.id}:${selection.scope.id}:${permissionId}`,
        subject: selection.subject,
        scope: selection.scope,
        permissionId,
        decision: "inherit",
      }
    );
  }

  function stage(rule: AccessRule) {
    const nextBaselines = Object.hasOwn(baselines, rule.permissionId)
      ? { ...baselines }
      : {
          ...baselines,
          [rule.permissionId]: structuredClone(
            baseByPermission.get(rule.permissionId) ?? null,
          ),
        };
    const nextDrafts = { ...drafts, [rule.permissionId]: rule };
    const current = baseByPermission.get(rule.permissionId);
    if (current && sameRule(current, rule)) {
      delete nextDrafts[rule.permissionId];
      delete nextBaselines[rule.permissionId];
    }
    const persisted = Object.keys(nextDrafts).length
      ? writeAccessRulesDraft(userId, {
          selection,
          drafts: Object.values(nextDrafts),
          baselines: nextBaselines,
        })
      : clearAccessRulesDraft(userId);
    if (!persisted) {
      // An earlier stored value must not masquerade as the latest draft.
      clearAccessRulesDraft(userId);
      setJournalIssue(
        "The browser could not keep your latest Rules change for reload. Keep this tab open and save it before leaving.",
      );
    } else setJournalIssue("");
    setBaselines(nextBaselines);
    setDrafts(nextDrafts);
    setConflictResolutions((current) => {
      const next = { ...current };
      delete next[rule.permissionId];
      return next;
    });
    setNotice("");
    setError("");
  }

  function requestSelection(next: Selection) {
    if (dirty) {
      setPendingSelection(next);
      setDiscardOpen(true);
      return;
    }
    setSelection(next);
    setPageIndex(0);
  }

  async function applyChanges() {
    if (targetMissing) {
      setError(
        "This Rules draft refers to a person, group, role, area, or permission that is no longer available. Discard it and start again.",
      );
      return;
    }
    if (controller.isPending()) {
      setError(
        "Another Access change is already in progress. Try again shortly.",
      );
      return;
    }
    if (rulesToApply.length) {
      const result = await actions.upsertRules(rulesToApply);
      if (!result.ok) {
        setError(result.error);
        return;
      }
    }
    setImpactOpen(false);
    setConfirmOpen(false);
    if (!clearDraftState()) {
      setNotice(
        "The policy change was applied, but this browser could not clear its saved draft.",
      );
      return;
    }
    setNotice(
      rulesToApply.length
        ? `${rulesToApply.length} policy change${rulesToApply.length === 1 ? "" : "s"} applied.`
        : "Current policy was kept for every conflict; no draft rules were applied.",
    );
  }

  const broadGrant =
    selection.subject.kind === "everyone" &&
    rulesToApply.some((rule) => rule.decision === "allow");
  const destructive = rulesToApply.some(
    (rule) =>
      rule.decision === "deny" ||
      (baseByPermission.get(rule.permissionId)?.decision === "allow" &&
        rule.decision !== "allow"),
  );
  const protectedAdministrators = state.identities.filter(
    (identity) =>
      identity.kind === "internal" &&
      identity.status === "active" &&
      identity.roleId === controller.adminRoleId,
  );

  function identitiesAffectedBy(rule: AccessRule) {
    const candidates = state.identities.filter(
      (identity) => identity.roleId !== controller.adminRoleId,
    );
    if (rule.subject.kind === "everyone") return candidates;
    if (rule.subject.kind === "role") {
      const subjectId = rule.subject.id;
      return candidates.filter((identity) => identity.roleId === subjectId);
    }
    if (rule.subject.kind === "group") {
      const subjectId = rule.subject.id;
      return candidates.filter((identity) =>
        identity.groupIds.includes(subjectId),
      );
    }
    const subjectId = rule.subject.id;
    return candidates.filter((identity) => identity.id === subjectId);
  }

  function decisionImpact(
    current: AccessRule | undefined,
    draft: AccessRule,
  ): "Elevates access" | "Removes access" | "Conditions only" {
    if (
      (draft.decision === "allow" && current?.decision !== "allow") ||
      (current?.decision === "deny" && draft.decision !== "deny")
    )
      return "Elevates access";
    if (
      draft.decision === "deny" ||
      (current?.decision === "allow" && draft.decision !== "allow")
    )
      return "Removes access";
    return "Conditions only";
  }

  return (
    <section aria-labelledby="rules-title" className="flex flex-col gap-3">
      <fieldset
        disabled={
          !journalReady ||
          controller.isPending() ||
          !controller.availability.rules
        }
        className="contents"
      >
        <div>
          <h2 id="rules-title" className="text-xl font-semibold tracking-tight">
            Access rules
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Edit one subject and one resource scope at a time. Changes remain
            staged until you review their impact.
          </p>
        </div>

        {notice ? <Alert variant="success">{notice}</Alert> : null}
        <Alert>
          Workspace-wide rules apply to Sandbox data and related files and
          automations. Rules for individual departments are not active yet.
          These rules do not change access in OpenView, Boards, or OpenComms.
          Service identities can store intended rules but cannot sign in yet.
        </Alert>
        {error ? (
          <Alert role="alert" variant="destructive">
            {error}
          </Alert>
        ) : null}
        {journalIssue ? (
          <Alert role="alert" variant="warning">
            {journalIssue}
          </Alert>
        ) : null}
        {dirty && targetMissing ? (
          <Alert role="alert" variant="warning">
            This saved Rules draft refers to a person, group, role, area, or
            permission that is no longer available. It cannot be applied.
            Discard it and start again.
          </Alert>
        ) : null}

        <Card>
          <CardContent className="p-3">
            <FieldGroup className="grid gap-3 md:grid-cols-2 xl:grid-cols-[repeat(4,minmax(0,1fr))_minmax(12rem,1.5fr)_auto]">
              <Field>
                <FieldLabel htmlFor="rule-subject-kind">
                  Who gets this?
                </FieldLabel>
                <FieldDescription>
                  Choose everyone, a role, a group, a person, or a service.
                </FieldDescription>
                <NativeSelect
                  id="rule-subject-kind"
                  className="w-full [&>select]:min-h-11"
                  value={selection.subject.kind}
                  onChange={(event) => {
                    const kind = event.target.value as AccessSubjectRef["kind"];
                    const firstId =
                      kind === "role"
                        ? state.roles[0]?.id
                        : kind === "group"
                          ? state.groups[0]?.id
                          : kind === "identity"
                            ? state.identities[0]?.id
                            : undefined;
                    if (kind !== "everyone" && !firstId) return;
                    if (kind === "everyone") {
                      requestSelection({ ...selection, subject: { kind } });
                    } else if (firstId) {
                      requestSelection({
                        ...selection,
                        subject: { kind, id: firstId },
                      });
                    }
                  }}
                >
                  {subjectKinds.map((kind) => (
                    <NativeSelectOption key={kind} value={kind}>
                      {kind === "identity" ? "Person or service" : title(kind)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="rule-subject">Choose who</FieldLabel>
                <NativeSelect
                  id="rule-subject"
                  className="w-full [&>select]:min-h-11"
                  disabled={selection.subject.kind === "everyone"}
                  value={
                    selection.subject.kind === "everyone"
                      ? "everyone"
                      : selection.subject.id
                  }
                  onChange={(event) => {
                    if (selection.subject.kind === "everyone") return;
                    requestSelection({
                      ...selection,
                      subject: {
                        kind: selection.subject.kind,
                        id: event.target.value,
                      },
                    });
                  }}
                >
                  {selection.subject.kind === "everyone" ? (
                    <NativeSelectOption value="everyone">
                      Everyone
                    </NativeSelectOption>
                  ) : (
                    subjectOptions.map((item) => (
                      <NativeSelectOption key={item.id} value={item.id}>
                        {"kind" in item
                          ? item.kind === "service"
                            ? `Service: ${item.name}`
                            : item.kind === "guest"
                              ? `Guest: ${item.name}`
                              : item.name
                          : item.name}
                      </NativeSelectOption>
                    ))
                  )}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="rule-scope-kind">
                  Where does it apply?
                </FieldLabel>
                <FieldDescription>
                  Choose the type of workspace area.
                </FieldDescription>
                <NativeSelect
                  id="rule-scope-kind"
                  className="w-full [&>select]:min-h-11"
                  value={selection.scope.kind}
                  onChange={(event) => {
                    const kind = event.target.value as AccessScopeKind;
                    const first = scopeCatalog.find(
                      (scope) => scope.kind === kind,
                    );
                    if (!first) return;
                    requestSelection({
                      ...selection,
                      scope: { kind, id: first.id },
                    });
                  }}
                >
                  {availableScopeKinds.map((kind) => (
                    <NativeSelectOption key={kind} value={kind}>
                      {title(kind)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="rule-scope">
                  Choose the specific area
                </FieldLabel>
                <NativeSelect
                  id="rule-scope"
                  className="w-full [&>select]:min-h-11"
                  value={selection.scope.id}
                  onChange={(event) =>
                    requestSelection({
                      ...selection,
                      scope: {
                        kind: selection.scope.kind,
                        id: event.target.value,
                      },
                    })
                  }
                >
                  {scopesForKind.map((scope) => (
                    <NativeSelectOption key={scope.id} value={scope.id}>
                      {scope.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="rule-search">What can they do?</FieldLabel>
                <FieldDescription>Find the action to set.</FieldDescription>
                <div className="relative">
                  <Search
                    aria-hidden="true"
                    className="text-muted-foreground absolute top-3.5 left-3 size-4"
                  />
                  <Input
                    id="rule-search"
                    className="min-h-11 pl-9"
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setPageIndex(0);
                    }}
                    placeholder="Search actions or technical ID"
                  />
                </div>
              </Field>
              <Field className="flex-row items-center justify-between gap-3 rounded-lg border px-3 py-2">
                <div>
                  <FieldLabel htmlFor="modified-rules">
                    Modified only
                  </FieldLabel>
                  <FieldDescription>Hide inherited</FieldDescription>
                </div>
                <Switch
                  id="modified-rules"
                  className="after:-inset-y-3.5"
                  checked={modifiedOnly}
                  onCheckedChange={(checked) => {
                    setModifiedOnly(checked);
                    setPageIndex(0);
                  }}
                />
              </Field>
            </FieldGroup>
          </CardContent>
        </Card>

        {!visiblePermissions.length ? (
          <Card>
            <CardContent className="text-muted-foreground py-10 text-center text-sm">
              No permissions match these filters.
            </CardContent>
          </Card>
        ) : (
          [...grouped.entries()].map(([product, entries]) => (
            <Card key={product}>
              <CardContent className="p-0">
                <div className="hidden lg:block">
                  <DataTable
                    ariaLabel={`${product} permissions`}
                    cellClassName="p-4 whitespace-normal"
                    columns={permissionColumns(ruleFor, stage)}
                    data={entries}
                    getRowId={(permission) => permission.id}
                  />
                </div>
                <div className="divide-y lg:hidden">
                  {entries.map((permission) => {
                    const rule = ruleFor(permission.id);
                    return (
                      <article
                        key={permission.id}
                        className="flex flex-col gap-4 p-4"
                      >
                        <div>
                          <h3 className="font-medium">{permission.name}</h3>
                          <Badge variant="secondary" className="mt-2">
                            {product}
                          </Badge>
                          <PermissionDetails permission={permission} />
                        </div>
                        <RuleControls
                          rule={rule}
                          permissionName={permission.name}
                          idSuffix="mobile"
                          onChange={stage}
                        />
                      </article>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          ))
        )}

        {pageCount > 1 ? (
          <PaginationControls
            ariaLabel="Permission pages"
            pageCount={pageCount}
            pageIndex={safePageIndex}
            onPageIndexChange={setPageIndex}
          />
        ) : null}

        {dirty ? (
          <div className="bg-card/95 flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3 shadow-sm backdrop-blur sm:sticky sm:bottom-3">
            <p className="text-sm">
              <strong>{pending.length}</strong> staged change
              {pending.length === 1 ? "" : "s"}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={!dirty || controller.isPending()}
                onClick={() => {
                  setPendingSelection(null);
                  setDiscardOpen(true);
                }}
              >
                Discard
              </Button>
              <Button
                type="button"
                className="min-h-11"
                disabled={
                  !dirty ||
                  targetMissing ||
                  controller.isPending() ||
                  !controller.availability.rules
                }
                title="Rule editing is not available until enforcement is ready."
                onClick={() => setImpactOpen(true)}
              >
                Review impact
              </Button>
            </div>
          </div>
        ) : null}

        <Dialog open={impactOpen} onOpenChange={setImpactOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Review estimated policy impact</DialogTitle>
              <DialogDescription>
                Compare the opening baseline, current policy, and staged draft
                before applying it. Directory match counts are estimates. The
                server checks current policy again before applying; membership
                changes can alter the impact.
              </DialogDescription>
            </DialogHeader>
            {conflicts.length ? (
              <Alert variant="warning">
                The live policy changed for {conflicts.length} staged permission
                {conflicts.length === 1 ? "" : "s"}. Unrelated live changes are
                preserved. Resolve each same-permission conflict explicitly.
              </Alert>
            ) : null}
            <Alert>
              Protected Administrator access is guarded and unaffected by these
              draft rules. Active protected administrator
              {protectedAdministrators.length === 1 ? "" : "s"}:{" "}
              {protectedAdministrators.length
                ? protectedAdministrators
                    .map((identity) => identity.name)
                    .join(", ")
                : "none — resolve this critical health finding before relying on the policy"}
              .
            </Alert>
            <div className="flex max-h-[52dvh] flex-col gap-2 overflow-y-auto py-2">
              {pending.map((rule) => {
                const permission = permissionCatalog.find(
                  (item) => item.id === rule.permissionId,
                );
                const opened = baselines[rule.permissionId];
                const current = baseByPermission.get(rule.permissionId);
                const isConflict = conflicts.some(
                  (item) => item.permissionId === rule.permissionId,
                );
                const resolution = resolutionIsCurrent(rule)
                  ? conflictResolutions[rule.permissionId]?.choice
                  : undefined;
                const affected = identitiesAffectedBy(rule);
                const effect = decisionImpact(current, rule);
                return (
                  <div
                    key={rule.permissionId}
                    className="flex flex-col gap-3 rounded-lg border p-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-medium">
                          {permission?.name ?? rule.permissionId}
                        </p>
                        <p className="text-muted-foreground text-xs">
                          {permission?.product}
                        </p>
                      </div>
                      {isConflict ? (
                        <Badge variant="warning">Live conflict</Badge>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="outline">
                        Opened: {opened?.decision ?? "inherit"}
                      </Badge>
                      <Badge variant="outline">
                        Current: {current?.decision ?? "inherit"}
                      </Badge>
                      <Badge
                        variant={
                          rule.decision === "deny"
                            ? "destructive"
                            : rule.decision === "allow"
                              ? "success"
                              : "secondary"
                        }
                      >
                        Draft: {rule.decision}
                      </Badge>
                      <Badge
                        variant={
                          effect === "Removes access"
                            ? "destructive"
                            : effect === "Elevates access"
                              ? "warning"
                              : "secondary"
                        }
                      >
                        {effect}
                      </Badge>
                    </div>
                    <p className="text-muted-foreground text-sm">
                      Potential non-protected directory matches:{" "}
                      {affected.length}
                      {affected.length
                        ? ` — ${affected
                            .slice(0, 3)
                            .map((identity) => identity.name)
                            .join(
                              ", ",
                            )}${affected.length > 3 ? ` and ${affected.length - 3} more` : ""}`
                        : " — no current identities match this subject"}
                    </p>
                    {isConflict ? (
                      <ToggleGroup
                        aria-label={`${permission?.name ?? rule.permissionId} conflict resolution`}
                        value={resolution ? [resolution] : []}
                        onValueChange={(values) => {
                          const choice = values[0];
                          if (choice !== "current" && choice !== "draft")
                            return;
                          setConflictResolutions((resolutions) => ({
                            ...resolutions,
                            [rule.permissionId]: {
                              choice,
                              current: structuredClone(current ?? null),
                            },
                          }));
                        }}
                        variant="outline"
                        spacing={0}
                        className="w-full [&>button]:min-h-11 [&>button]:flex-1"
                      >
                        <ToggleGroupItem value="current">
                          Keep current
                        </ToggleGroupItem>
                        <ToggleGroupItem value="draft">
                          Use draft
                        </ToggleGroupItem>
                      </ToggleGroup>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {broadGrant || destructive ? (
              <Alert variant="warning">
                <AlertTriangle aria-hidden="true" className="mr-2 inline" />
                This change includes {broadGrant ? "a broad grant" : ""}
                {broadGrant && destructive ? " and " : ""}
                {destructive ? "a deny that may remove access" : ""}. A separate
                confirmation is required.
              </Alert>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => setImpactOpen(false)}
              >
                Back to editing
              </Button>
              <Button
                type="button"
                className="min-h-11"
                disabled={
                  unresolvedConflicts.length > 0 || controller.isPending()
                }
                onClick={() => {
                  if (broadGrant || destructive) {
                    setImpactOpen(false);
                    setConfirmOpen(true);
                  } else applyChanges();
                }}
              >
                {unresolvedConflicts.length
                  ? `Resolve ${unresolvedConflicts.length} conflict${unresolvedConflicts.length === 1 ? "" : "s"}`
                  : rulesToApply.length
                    ? `Apply ${rulesToApply.length} draft choice${rulesToApply.length === 1 ? "" : "s"}`
                    : "Keep current policy"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogTitle>Confirm sensitive policy change</AlertDialogTitle>
            <AlertDialogDescription>
              {broadGrant
                ? "Everyone will receive one or more explicit permissions. "
                : ""}
              {destructive
                ? "One or more explicit denies may remove access. "
                : ""}
              This updates the policy configuration. Native features retain
              final authorization enforcement.
            </AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogCancel className="min-h-11">Cancel</AlertDialogCancel>
              <Button
                type="button"
                variant={destructive ? "destructive" : "default"}
                className="min-h-11"
                disabled={controller.isPending()}
                onClick={applyChanges}
              >
                Confirm and apply
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
          <AlertDialogContent>
            <AlertDialogTitle>Discard staged changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your unapplied rule decisions, time windows, and locks will be
              lost.
            </AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogCancel className="min-h-11">
                Keep editing
              </AlertDialogCancel>
              <Button
                type="button"
                variant="destructive"
                className="min-h-11"
                disabled={controller.isPending()}
                onClick={() => {
                  if (!clearDraftState()) return;
                  if (pendingSelection) setSelection(pendingSelection);
                  setPageIndex(0);
                }}
              >
                Discard changes
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </fieldset>
    </section>
  );
}
