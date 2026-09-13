"use client";

import { useState } from "react";
import { AlertTriangle, Lock, Search, Unlock } from "lucide-react";

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
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
} from "@/components/ui/pagination";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

import type { AccessController } from "./controller";
import type {
  AccessDecision,
  AccessRule,
  AccessScopeKind,
  AccessScopeRef,
  AccessSubjectRef,
} from "./policy";

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

const PAGE_SIZE = 1;
const subjectKinds: AccessSubjectRef["kind"][] = [
  "everyone",
  "role",
  "group",
  "identity",
];
const scopeKinds: AccessScopeKind[] = [
  "workspace",
  "department",
  "module",
  "field",
  "board",
  "openview",
  "comms-category",
  "comms-channel",
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
          if (decision) onChange({ ...rule, decision });
        }}
        variant="outline"
        spacing={0}
        className="w-full [&>button]:min-h-11 [&>button]:flex-1"
      >
        <ToggleGroupItem value="inherit">Inherit</ToggleGroupItem>
        <ToggleGroupItem value="allow">Allow</ToggleGroupItem>
        <ToggleGroupItem value="deny">Deny</ToggleGroupItem>
      </ToggleGroup>
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
  const [conflictResolutions, setConflictResolutions] = useState<
    Record<string, ConflictResolution>
  >({});
  const [query, setQuery] = useState("");
  const [modifiedOnly, setModifiedOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [impactOpen, setImpactOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<Selection | null>(
    null,
  );
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

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
  const selectedScopeEntry = scopeCatalog.find(
    (scope) =>
      scope.kind === selection.scope.kind && scope.id === selection.scope.id,
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
  const pageCount = Math.max(
    1,
    Math.ceil(filteredPermissions.length / PAGE_SIZE),
  );
  const visiblePermissions = filteredPermissions.slice(
    (Math.min(page, pageCount) - 1) * PAGE_SIZE,
    Math.min(page, pageCount) * PAGE_SIZE,
  );
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
    setBaselines((current) =>
      Object.hasOwn(current, rule.permissionId)
        ? current
        : {
            ...current,
            [rule.permissionId]: structuredClone(
              baseByPermission.get(rule.permissionId) ?? null,
            ),
          },
    );
    setDrafts((current) => ({ ...current, [rule.permissionId]: rule }));
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
    setPage(1);
  }

  function applyChanges() {
    setImpactOpen(false);
    setConfirmOpen(false);
    if (rulesToApply.length) {
      const result = actions.upsertRules(rulesToApply);
      if (!result.ok) {
        setError(result.error);
        return;
      }
    }
    setDrafts({});
    setBaselines({});
    setConflictResolutions({});
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
      identity.roleId === "sample-admin",
  );

  function identitiesAffectedBy(rule: AccessRule) {
    const candidates = state.identities.filter(
      (identity) => identity.roleId !== "sample-admin",
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
      {error ? (
        <Alert role="alert" variant="destructive">
          {error}
        </Alert>
      ) : null}

      <Card>
        <CardContent className="p-3">
          <FieldGroup className="grid gap-3 md:grid-cols-2 xl:grid-cols-[repeat(4,minmax(0,1fr))_minmax(12rem,1.5fr)_auto]">
            <Field>
              <FieldLabel htmlFor="rule-subject-kind">Subject type</FieldLabel>
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
                    {title(kind)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="rule-subject">Subject</FieldLabel>
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
                      {item.name}
                    </NativeSelectOption>
                  ))
                )}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="rule-scope-kind">Scope type</FieldLabel>
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
                {scopeKinds.map((kind) => (
                  <NativeSelectOption key={kind} value={kind}>
                    {title(kind)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="rule-scope">Resource scope</FieldLabel>
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
              <FieldLabel htmlFor="rule-search">Search permissions</FieldLabel>
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
                    setPage(1);
                  }}
                  placeholder="Permission, product, or ID"
                />
              </div>
            </Field>
            <Field className="flex-row items-center justify-between gap-3 rounded-lg border px-3 py-2">
              <div>
                <FieldLabel htmlFor="modified-rules">Modified only</FieldLabel>
                <FieldDescription>Hide inherited</FieldDescription>
              </div>
              <Switch
                id="modified-rules"
                className="after:-inset-y-3.5"
                checked={modifiedOnly}
                onCheckedChange={(checked) => {
                  setModifiedOnly(checked);
                  setPage(1);
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
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Permission</TableHead>
                      <TableHead>Decision and conditions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {entries.map((permission) => {
                      const rule = ruleFor(permission.id);
                      return (
                        <TableRow key={permission.id}>
                          <TableCell className="w-64 p-4 align-top whitespace-normal">
                            <p className="font-medium">{permission.name}</p>
                            <p className="text-muted-foreground mt-1 font-mono text-xs">
                              {permission.id}
                            </p>
                            <Badge variant="secondary" className="mt-2">
                              {product}
                            </Badge>
                          </TableCell>
                          <TableCell className="p-4 whitespace-normal">
                            <RuleControls
                              rule={rule}
                              permissionName={permission.name}
                              idSuffix="desktop"
                              onChange={stage}
                            />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
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
                        <p className="text-muted-foreground mt-1 font-mono text-xs">
                          {permission.id}
                        </p>
                        <Badge variant="secondary" className="mt-2">
                          {product}
                        </Badge>
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
        <Pagination aria-label="Permission pages">
          <PaginationContent>
            {Array.from({ length: pageCount }, (_, index) => index + 1).map(
              (number) => (
                <PaginationItem key={number}>
                  <Button
                    type="button"
                    variant={number === page ? "outline" : "ghost"}
                    className="min-h-11 min-w-11"
                    aria-current={number === page ? "page" : undefined}
                    aria-label={`Page ${number}`}
                    onClick={() => setPage(number)}
                  >
                    {number}
                  </Button>
                </PaginationItem>
              ),
            )}
          </PaginationContent>
        </Pagination>
      ) : null}

      <div className="bg-card/95 sticky bottom-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3 shadow-sm backdrop-blur">
        <p className="text-sm">
          <strong>{pending.length}</strong> staged change
          {pending.length === 1 ? "" : "s"}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={!dirty}
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
            disabled={!dirty}
            onClick={() => setImpactOpen(true)}
          >
            Review impact
          </Button>
        </div>
      </div>

      <Dialog open={impactOpen} onOpenChange={setImpactOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Review policy impact</DialogTitle>
            <DialogDescription>
              Compare the opening baseline, current policy, and staged draft
              before applying it.
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
                    Affected non-protected identities: {affected.length}
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
                        if (choice !== "current" && choice !== "draft") return;
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
                      <ToggleGroupItem value="draft">Use draft</ToggleGroupItem>
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
              disabled={unresolvedConflicts.length > 0}
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
            This updates the policy configuration. Native features retain final
            authorization enforcement.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">Cancel</AlertDialogCancel>
            <Button
              type="button"
              variant={destructive ? "destructive" : "default"}
              className="min-h-11"
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
            Your unapplied rule decisions, time windows, and locks will be lost.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">
              Keep editing
            </AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              className="min-h-11"
              onClick={() => {
                setDrafts({});
                setBaselines({});
                setConflictResolutions({});
                if (pendingSelection) setSelection(pendingSelection);
                setPendingSelection(null);
                setDiscardOpen(false);
                setPage(1);
              }}
            >
              Discard changes
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
