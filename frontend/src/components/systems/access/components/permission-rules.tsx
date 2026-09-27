"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  ChevronDown,
  Lock,
  Settings2,
  Unlock,
  X,
} from "lucide-react";

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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { AccessSearchToolbar } from "./access-search-toolbar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

import {
  completeCollection,
  pageCollection,
} from "../../shared/helpers/sample-collections";
import type { AccessController } from "../state/controller";
import { useAccessDraftRegistration } from "../state/draft-navigation";
import {
  accessDraftSubmissionNeedsReload,
  beginAccessRulesDraftSubmission,
  clearAccessRulesDraft,
  completeAccessRulesDraftSubmission,
  discardUncertainAccessRulesDraft,
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

export type PermissionRulesProps = {
  controller: AccessController;
  initialSubject?: AccessSubjectRef;
  children: (context: PermissionRulesContext) => ReactNode;
};

export type PermissionRulesContext = {
  subject: AccessSubjectRef;
  editor: ReactNode;
  ready: boolean;
  hasDraft: boolean;
  blocked: boolean;
  requestSubjectChange: (subject: AccessSubjectRef) => void;
  discardDraft: () => boolean;
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

function RuleDecision({
  rule,
  permissionName,
  onChange,
}: {
  rule: AccessRule;
  permissionName: string;
  onChange: (rule: AccessRule) => void;
}) {
  return (
    <ToggleGroup
      aria-label={`${permissionName} decision`}
      value={[rule.decision]}
      onValueChange={(values) => {
        const decision = values[0] as AccessDecision | undefined;
        if (decision) onChange({ ...rule, decision });
      }}
      variant="outline"
      spacing={0}
      className="w-full min-w-0 [&>button]:min-h-11 [&>button]:flex-1 [&>button]:px-2 [&>button]:whitespace-normal [&>button:first-child]:flex-[1.6]"
    >
      <ToggleGroupItem value="inherit">Use existing access</ToggleGroupItem>
      <ToggleGroupItem value="allow">Allow</ToggleGroupItem>
      <ToggleGroupItem value="deny">Deny</ToggleGroupItem>
    </ToggleGroup>
  );
}
function RuleTimeWindow({
  rule,
  permissionName,
  idSuffix,
  onChange,
  onAdvanced,
}: {
  rule: AccessRule;
  permissionName: string;
  idSuffix: string;
  onChange: (rule: AccessRule) => void;
  onAdvanced: (triggerId: string) => void;
}) {
  const id = `rule-${rule.permissionId}-${idSuffix}`;
  return (
    <div
      id={`${id}-options`}
      role="region"
      aria-label={`${permissionName} options`}
      className="bg-muted/20 p-4 text-left sm:p-5"
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-medium">
            Time window{" "}
            <span className="text-muted-foreground font-normal">
              (optional)
            </span>
          </p>
          <Button
            id={`${id}-advanced`}
            variant="outline"
            className="min-h-11"
            onClick={() => onAdvanced(`${id}-advanced`)}
          >
            <Settings2 aria-hidden="true" />
            Advanced rule setup
          </Button>
        </div>
        <div className="grid max-w-3xl gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${id}-starts`}>Starts</FieldLabel>
            <Input
              id={`${id}-starts`}
              className="min-h-11 min-w-0"
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
            <FieldLabel htmlFor={`${id}-ends`}>Ends</FieldLabel>
            <Input
              id={`${id}-ends`}
              className="min-h-11 min-w-0"
              type="datetime-local"
              value={localDateTime(rule.endsAt)}
              onChange={(event) =>
                onChange({ ...rule, endsAt: dateTimeValue(event.target.value) })
              }
            />
          </Field>
        </div>
        <p className="text-muted-foreground text-xs">
          Leave blank for no time limit.
        </p>
      </div>
    </div>
  );
}

export function PermissionRules({
  controller,
  initialSubject,
  children,
}: PermissionRulesProps) {
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
  const [uncertainDraft, setUncertainDraft] = useState(false);
  const [uncertainDiscardOpen, setUncertainDiscardOpen] = useState(false);
  const [conflictResolutions, setConflictResolutions] = useState<
    Record<string, ConflictResolution>
  >({});
  const [query, setQuery] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sort, setSort] = useState<"name" | "name-desc">("name");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupTab, setSetupTab] = useState<"context" | "advanced">("context");
  const [setupPermissionId, setSetupPermissionId] = useState<string | null>(
    null,
  );
  const [resumeSetup, setResumeSetup] = useState(false);
  const setupTriggerId = useRef("rules-title");
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
  const recoveryNeedsReload =
    uncertainDraft && accessDraftSubmissionNeedsReload(userId, "rules");

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
    if (stored.status === "uncertain") {
      setUncertainDraft(true);
      setJournalIssue(
        "This Rules change may have completed. Review the current policy and the saved choices before discarding this locked draft.",
      );
    } else if (stored.status === "unavailable")
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
    if (uncertainDraft) {
      setJournalIssue(
        "This Rules change may have completed. Review the current policy before discarding this locked draft.",
      );
      return false;
    }
    if (!clearAccessRulesDraft(userId)) {
      setJournalIssue(
        "The browser could not clear your saved Rules draft. Keep editing or clear this site's browser data before leaving.",
      );
      return false;
    }
    resetDraftState();
    return true;
  }

  function discardDraft(): boolean {
    if (controller.isPending()) {
      setError(
        "Another Access change is already in progress. Try again shortly.",
      );
      return false;
    }
    return clearDraftState();
  }

  function resetDraftState() {
    setDrafts({});
    setBaselines({});
    setConflictResolutions({});
    setPendingSelection(null);
    setDiscardOpen(false);
    setImpactOpen(false);
    setConfirmOpen(false);
    setJournalIssue("");
    setUncertainDiscardOpen(false);
  }

  function discardUncertainDraft() {
    if (accessDraftSubmissionNeedsReload(userId, "rules")) {
      setUncertainDiscardOpen(false);
      setJournalIssue(
        "Reload Access and review current policy before discarding this uncertain Rules draft.",
      );
      return;
    }
    if (
      controller.resource.status !== "ready" ||
      controller.resource.refreshing ||
      controller.resource.error
    ) {
      setJournalIssue(
        "Refresh Access successfully before discarding this uncertain Rules draft.",
      );
      return;
    }
    if (!discardUncertainAccessRulesDraft(userId)) {
      setUncertainDiscardOpen(false);
      setJournalIssue(
        "The browser could not clear the uncertain Rules draft. It remains locked; try again when browser storage works.",
      );
      return;
    }
    setUncertainDraft(false);
    resetDraftState();
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
  useAccessDraftRegistration(
    "rules-view",
    dirty || uncertainDraft,
    clearDraftState,
  );
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
  const filteredPermissions = permissionCatalog
    .filter((permission) => {
      if (
        !selectedScopeEntry ||
        permission.product !== selectedScopeEntry.product
      )
        return false;
      const matches =
        `${permission.name} ${permission.product} ${permission.id}`
          .toLowerCase()
          .includes(normalizedQuery);
      return (
        matches &&
        (!modifiedOnly ||
          Boolean(drafts[permission.id] || baseByPermission.has(permission.id)))
      );
    })
    .sort(
      (left, right) =>
        (sort === "name" ? 1 : -1) * left.name.localeCompare(right.name),
    );
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
        sort,
      ]),
    ),
    pageIndex * PAGE_SIZE,
    PAGE_SIZE,
  );
  const pageCount = Math.max(1, Math.ceil(pageResult.total / pageResult.limit));
  const safePageIndex = pageResult.offset / pageResult.limit;
  const visiblePermissions = [...pageResult.items];
  const editingDisabled =
    !journalReady ||
    uncertainDraft ||
    controller.isPending() ||
    !controller.availability.rules;
  const subjectName =
    selection.subject.kind === "everyone"
      ? "Everyone"
      : (subjectOptions.find(
          (item) =>
            item.id ===
            (selection.subject.kind !== "everyone" ? selection.subject.id : ""),
        )?.name ?? "Unavailable subject");
  const setupPermission = permissionCatalog.find(
    (item) =>
      item.id === setupPermissionId &&
      item.product === selectedScopeEntry?.product,
  );
  function openSetup(
    tab: "context" | "advanced",
    permissionId: string | null = null,
    triggerId = "rules-title",
  ) {
    setupTriggerId.current = triggerId;
    setSetupPermissionId(permissionId);
    setSetupTab(tab);
    setSetupOpen(true);
  }
  function renderOptions(permission: Permission, suffix: string) {
    return (
      <RuleTimeWindow
        rule={ruleFor(permission.id)}
        permissionName={permission.name}
        idSuffix={suffix}
        onChange={stage}
        onAdvanced={(triggerId) =>
          openSetup("advanced", permission.id, triggerId)
        }
      />
    );
  }
  function optionsButton(permission: Permission, suffix: string) {
    return (
      <Button
        variant="ghost"
        className="min-h-11"
        aria-label={`${permission.name} options`}
        aria-expanded={expandedId === permission.id}
        aria-controls={
          expandedId === permission.id
            ? `rule-${permission.id}-${suffix}-options`
            : undefined
        }
        onClick={() =>
          setExpandedId((current) =>
            current === permission.id ? null : permission.id,
          )
        }
      >
        Options{" "}
        <ChevronDown
          aria-hidden="true"
          className={expandedId === permission.id ? "rotate-180" : ""}
        />
      </Button>
    );
  }
  const columns: DataTableColumn<Permission>[] = [
    {
      id: "permission",
      header: "Permission",
      cell: ({ row }) => (
        <div className="space-y-1">
          <p className="font-medium">{row.original.name}</p>
          <p className="text-muted-foreground text-xs">
            {row.original.product}
          </p>
          {drafts[row.original.id] && <Badge variant="outline">Staged</Badge>}
        </div>
      ),
    },
    {
      id: "decision",
      header: "Decision",
      cell: ({ row }) => (
        <div className="max-w-lg min-w-80">
          <RuleDecision
            rule={ruleFor(row.original.id)}
            permissionName={row.original.name}
            onChange={stage}
          />
        </div>
      ),
    },
    {
      id: "options",
      header: "Options",
      cell: ({ row }) => optionsButton(row.original, "desktop"),
    },
  ];

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
    if (editingDisabled) return;
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
    if (uncertainDraft) {
      setError(
        "Review the uncertain Rules change before starting another one.",
      );
      return;
    }
    if (controller.isPending()) {
      setError(
        "Another Access change is already in progress. Try again shortly.",
      );
      return;
    }
    if (dirty) {
      if (setupOpen) {
        setResumeSetup(true);
        setSetupOpen(false);
      }
      setPendingSelection(next);
      setDiscardOpen(true);
      return;
    }
    setSelection(next);
    setExpandedId(null);
    setSetupPermissionId(null);
    setPageIndex(0);
  }

  function requestSubjectChange(subject: AccessSubjectRef) {
    requestSelection({ ...selection, subject });
  }

  async function applyChanges() {
    if (uncertainDraft) {
      setError(
        "Review the uncertain Rules change before starting another one.",
      );
      return;
    }
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
      if (
        !beginAccessRulesDraftSubmission(userId, {
          selection,
          drafts: Object.values(drafts),
          baselines,
        })
      ) {
        setError(
          "The browser could not protect your Rules draft before saving. No policy request was sent; check browser storage and try again.",
        );
        setImpactOpen(false);
        setConfirmOpen(false);
        return;
      }
      setUncertainDraft(true);
      const result = await actions.upsertRules(rulesToApply);
      if (!result.ok) {
        setError(result.error);
        setJournalIssue(
          "This Rules change may have completed. Review the current policy before discarding this locked draft.",
        );
        setImpactOpen(false);
        setConfirmOpen(false);
        return;
      }
      if (!completeAccessRulesDraftSubmission(userId)) {
        setImpactOpen(false);
        setConfirmOpen(false);
        setJournalIssue(
          "The policy change was applied, but browser cleanup failed. This Rules draft remains locked until you review current policy and discard it.",
        );
        return;
      }
      setUncertainDraft(false);
      resetDraftState();
      setNotice(
        `${rulesToApply.length} policy change${rulesToApply.length === 1 ? "" : "s"} applied.`,
      );
      return;
    }
    setImpactOpen(false);
    setConfirmOpen(false);
    if (!clearDraftState()) return;
    setNotice(
      "Current policy was kept for every conflict; no draft rules were applied.",
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

  const editor = (
    <section
      aria-labelledby="rules-title"
      className="flex min-w-0 flex-col gap-2"
    >
      <fieldset disabled={editingDisabled} className="contents">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2
              data-slot="section-title"
              id="rules-title"
              tabIndex={-1}
              className="text-base font-semibold tracking-tight"
            >
              Workspace rules
            </h2>
            <p className="text-muted-foreground mt-0.5 text-sm">
              Set permissions, then review your changes.
            </p>
          </div>
          <Button
            variant="ghost"
            className="min-h-11"
            aria-expanded={filtersOpen}
            aria-controls="rule-filters"
            onClick={() => setFiltersOpen((open) => !open)}
          >
            Filter rules{" "}
            <ChevronDown
              aria-hidden="true"
              className={filtersOpen ? "rotate-180" : ""}
            />
          </Button>
        </div>

        {notice ? <Alert variant="success">{notice}</Alert> : null}

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

        <div id="rule-filters" hidden={!filtersOpen}>
          <AccessSearchToolbar
            searchLabel="What can they do?"
            placeholder="Search actions or technical ID"
            query={query}
            onQueryChange={(value) => {
              setQuery(value);
              setPageIndex(0);
            }}
            sort={sort}
            sortOptions={[
              { value: "name", label: "Name (A–Z)" },
              { value: "name-desc", label: "Name (Z–A)" },
            ]}
            onSortChange={(value) => {
              setSort(value);
              setPageIndex(0);
            }}
            activeFilterCount={modifiedOnly ? 1 : 0}
          >
            <Field className="flex-row items-center justify-between gap-3">
              <div>
                <FieldLabel htmlFor="modified-rules">Modified only</FieldLabel>
                <FieldDescription>
                  Show explicit rules and staged changes.
                </FieldDescription>
              </div>
              <Switch
                id="modified-rules"
                checked={modifiedOnly}
                onCheckedChange={(checked) => {
                  setModifiedOnly(checked);
                  setPageIndex(0);
                }}
              />
            </Field>
          </AccessSearchToolbar>
        </div>
        <p className="text-muted-foreground text-xs">
          Use existing access follows broader or default access. A scope lock
          can still block more specific rules.
        </p>
        <div className="min-w-0 overflow-x-auto rounded-lg border">
          <div className="hidden lg:block">
            <DataTable
              ariaLabel="Workspace permissions"
              className="w-full min-w-[38rem] table-fixed [&_td:last-child]:text-right [&_th:first-child]:w-[30%] [&_th:last-child]:w-[15%] [&_th:last-child]:text-right [&_th:nth-child(2)]:w-[55%]"
              cellClassName="p-4 whitespace-normal"
              columns={columns}
              data={visiblePermissions}
              getRowId={(permission) => permission.id}
              renderExpandedRow={(permission) =>
                expandedId === permission.id
                  ? renderOptions(permission, "desktop")
                  : null
              }
              emptyState={
                <p className="text-muted-foreground py-8 text-center">
                  No permissions match these filters.
                </p>
              }
            />
          </div>
          <div className="divide-y lg:hidden">
            {!visiblePermissions.length && (
              <p className="text-muted-foreground p-8 text-center">
                No permissions match these filters.
              </p>
            )}
            {visiblePermissions.map((permission) => (
              <article key={permission.id} className="min-w-0">
                <div className="space-y-3 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-medium">{permission.name}</h3>
                    {drafts[permission.id] && (
                      <Badge variant="outline">Staged</Badge>
                    )}
                  </div>
                  <RuleDecision
                    rule={ruleFor(permission.id)}
                    permissionName={permission.name}
                    onChange={stage}
                  />
                  {optionsButton(permission, "mobile")}
                </div>
                {expandedId === permission.id &&
                  renderOptions(permission, "mobile")}
              </article>
            ))}
          </div>
          <div className="bg-card flex flex-wrap items-center justify-between gap-3 border-t p-3">
            <p className="text-muted-foreground text-sm">
              Showing {pageResult.total ? pageResult.offset + 1 : 0}–
              {pageResult.offset + visiblePermissions.length} of{" "}
              {pageResult.total}
            </p>
            <PaginationControls
              ariaLabel="Permission pages"
              className="w-auto justify-end"
              pageCount={pageCount}
              pageIndex={safePageIndex}
              onPageIndexChange={setPageIndex}
            />
          </div>
        </div>
        <Dialog open={setupOpen} onOpenChange={setSetupOpen}>
          <DialogContent
            className="max-w-2xl p-5 sm:p-6"
            finalFocus={() =>
              document.getElementById(setupTriggerId.current) ??
              document.getElementById("rules-title")
            }
          >
            <DialogHeader>
              <div className="flex items-center justify-between gap-3">
                <DialogTitle>Rule setup</DialogTitle>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Close rule setup"
                  onClick={() => setSetupOpen(false)}
                >
                  <X aria-hidden="true" />
                </Button>
              </div>
              <DialogDescription>
                Choose the rule context or adjust a permission’s advanced
                settings. Changes stay staged until Review impact.
              </DialogDescription>
            </DialogHeader>
            <Tabs
              value={setupTab}
              onValueChange={(value) =>
                setSetupTab(value === "advanced" ? "advanced" : "context")
              }
              className="mt-4"
            >
              <TabsList
                aria-label="Rule setup sections"
                className="grid w-full grid-cols-2"
              >
                <TabsTrigger value="context">Context</TabsTrigger>
                <TabsTrigger value="advanced">Advanced</TabsTrigger>
              </TabsList>
              <TabsContent value="context">
                <fieldset disabled={editingDisabled} className="space-y-6">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field>
                      <FieldLabel htmlFor="rule-subject-kind">
                        Who gets this?
                      </FieldLabel>
                      <NativeSelect
                        id="rule-subject-kind"
                        className="w-full [&>select]:min-h-11"
                        value={selection.subject.kind}
                        onChange={(event) => {
                          const kind = event.target
                            .value as AccessSubjectRef["kind"];
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
                            requestSelection({
                              ...selection,
                              subject: { kind },
                            });
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
                            {kind === "identity"
                              ? "Person or service"
                              : title(kind)}
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
                    <p className="text-muted-foreground text-sm sm:col-span-2">
                      Choose everyone, a role, a group, a person, or a service.
                    </p>
                  </div>
                  <div className="grid gap-3 border-t pt-5 sm:grid-cols-2">
                    <Field>
                      <FieldLabel htmlFor="rule-scope-kind">
                        Where does it apply?
                      </FieldLabel>
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
                    <p className="text-muted-foreground text-sm sm:col-span-2">
                      Choose the type of workspace area and its specific scope.
                    </p>
                  </div>
                </fieldset>
              </TabsContent>
              <TabsContent value="advanced">
                <fieldset disabled={editingDisabled} className="space-y-4">
                  {setupPermission ? (
                    <>
                      <div className="space-y-1">
                        <h3 className="text-base font-semibold">
                          {setupPermission.name}
                        </h3>
                        <p className="text-muted-foreground text-sm">
                          {subjectName} ·{" "}
                          {selectedScopeEntry?.name ?? "Unavailable area"}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-3 border-y py-4 text-sm">
                        <span>Decision</span>
                        <Badge variant="outline">
                          {ruleFor(setupPermission.id).decision === "inherit"
                            ? "Use existing access"
                            : title(ruleFor(setupPermission.id).decision)}
                        </Badge>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-4 py-1">
                        <div className="space-y-1">
                          <p className="text-sm font-medium">Scope lock</p>
                          <p className="text-muted-foreground text-sm">
                            Block overrides in more specific areas.
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          className="min-h-11 w-fit"
                          aria-pressed={
                            ruleFor(setupPermission.id).locked === true
                          }
                          onClick={() =>
                            stage({
                              ...ruleFor(setupPermission.id),
                              locked: !ruleFor(setupPermission.id).locked,
                            })
                          }
                        >
                          {ruleFor(setupPermission.id).locked ? (
                            <Lock aria-hidden="true" />
                          ) : (
                            <Unlock aria-hidden="true" />
                          )}
                          {ruleFor(setupPermission.id).locked
                            ? "Locked at this scope"
                            : "Lock at this scope"}
                        </Button>
                      </div>
                      <details className="border-t">
                        <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">
                          Technical details
                        </summary>
                        <p className="text-muted-foreground bg-muted/30 rounded-md px-3 py-3 text-sm break-all">
                          Permission ID: <code>{setupPermission.id}</code>
                        </p>
                      </details>
                    </>
                  ) : (
                    <p className="text-muted-foreground text-sm">
                      Open a permission’s Options, then choose Advanced rule
                      setup to adjust its scope lock and view technical details.
                    </p>
                  )}
                </fieldset>
              </TabsContent>
            </Tabs>
            <details className="mt-5 border-t">
              <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">
                About rule coverage
              </summary>
              <div
                className="text-muted-foreground space-y-3 pb-2 text-sm leading-relaxed"
                role="status"
              >
                <p>
                  Workspace-wide rules apply to Sandbox data and related files
                  and automations, including Record values queried through
                  OpenView or Boards and delivered in Report output.
                </p>
                <ul className="list-disc space-y-2 pl-4">
                  <li>Rules for individual departments are not active yet.</li>
                  <li>Board grants and content audiences remain separate.</li>
                  <li>
                    Service identities can store intended rules but cannot sign
                    in yet.
                  </li>
                </ul>
              </div>
            </details>
            <DialogFooter className="mt-5 items-center border-t pt-4">
              <p className="text-muted-foreground mr-auto text-xs">
                Changes are not applied yet.
              </p>
              <Button onClick={() => setSetupOpen(false)} className="min-h-11">
                Done
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {dirty ? (
          <div className="bg-card flex flex-col gap-3 border-t p-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm">
              <strong>{pending.length}</strong> staged change
              {pending.length === 1 ? "" : "s"}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
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
                        className="w-full [&>button]:min-h-11 [&>button]:flex-1 [&>button]:px-2 [&>button]:whitespace-normal [&>button:first-child]:flex-[1.6]"
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

        <AlertDialog
          open={discardOpen}
          onOpenChange={(open) => {
            setDiscardOpen(open);
            if (!open && resumeSetup) {
              setResumeSetup(false);
              setSetupOpen(true);
            }
          }}
        >
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
                  if (pendingSelection) {
                    setSelection(pendingSelection);
                    setExpandedId(null);
                    setSetupPermissionId(null);
                  }
                  setPageIndex(0);
                  if (resumeSetup) {
                    setResumeSetup(false);
                    setSetupTab("context");
                    setSetupOpen(true);
                  }
                }}
              >
                Discard changes
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </fieldset>
      {uncertainDraft ? (
        <Card>
          <CardContent className="space-y-3 p-3">
            <h3 data-slot="section-title" className="font-semibold">
              Current policy and saved Rules choices
            </h3>
            <p className="text-muted-foreground text-sm">
              {recoveryNeedsReload
                ? "Reload Access to compare against the latest policy."
                : "Current policy was loaded from Access."}{" "}
              The saved choices have not been submitted again.
            </p>
            <ul className="max-h-64 space-y-2 overflow-y-auto">
              {Object.values(drafts).map((rule) => {
                const current = baseByPermission.get(rule.permissionId);
                const permission = permissionCatalog.find(
                  (item) => item.id === rule.permissionId,
                );
                return (
                  <li
                    key={rule.permissionId}
                    className="rounded-md border p-2 text-sm"
                  >
                    <p className="font-medium">
                      {permission?.name ?? rule.permissionId}
                    </p>
                    <p>Current: {current?.decision ?? "inherit"}</p>
                    <p>Saved: {rule.decision}</p>
                    <p className="text-muted-foreground">
                      Current scope lock: {current?.locked ? "On" : "Off"}.
                      Current window: {current?.startsAt ?? "Any start"} to{" "}
                      {current?.endsAt ?? "Any end"}.
                    </p>
                    <p className="text-muted-foreground">
                      Saved scope lock: {rule.locked ? "On" : "Off"}. Saved
                      window: {rule.startsAt ?? "Any start"} to{" "}
                      {rule.endsAt ?? "Any end"}.
                    </p>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      ) : null}
      {uncertainDraft ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11 self-start"
          disabled={
            recoveryNeedsReload ||
            controller.resource.status !== "ready" ||
            controller.resource.refreshing ||
            Boolean(controller.resource.error)
          }
          onClick={() => setUncertainDiscardOpen(true)}
        >
          Review and discard locked Rules draft
        </Button>
      ) : null}
      {recoveryNeedsReload ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11 self-start"
          onClick={() => window.location.reload()}
        >
          Reload Access before recovery
        </Button>
      ) : null}
      <AlertDialog
        open={uncertainDiscardOpen}
        onOpenChange={setUncertainDiscardOpen}
      >
        <AlertDialogContent>
          <AlertDialogTitle>Discard uncertain Rules draft?</AlertDialogTitle>
          <AlertDialogDescription>
            The earlier policy change may have completed. Review the current
            policy and your saved choices before starting a new draft.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">
              Keep reviewing
            </AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              className="min-h-11"
              onClick={discardUncertainDraft}
            >
              Discard locked draft
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );

  return children({
    subject: selection.subject,
    editor,
    ready: journalReady,
    hasDraft: dirty || uncertainDraft,
    blocked: controller.isPending() || uncertainDraft,
    requestSubjectChange,
    discardDraft,
  });
}
