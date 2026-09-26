"use client";

import { useEffect, useRef, useState } from "react";
import { Download, RotateCcw, Settings2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

import type { AccessController } from "../state/controller";
import { useAccessDraftRegistration } from "../state/draft-navigation";
import {
  accessDraftSubmissionNeedsReload,
  beginAccessDefaultsDraftSubmission,
  clearAccessDefaultsDraft,
  completeAccessDefaultsDraftSubmission,
  discardUncertainAccessDefaultsDraft,
  editableAccessDefaults,
  readAccessDefaultsDraft,
  writeAccessDefaultsDraft,
  type EditableAccessDefaults,
} from "../state/draft-journal";
import { useVerifiedWorkspaceUserId } from "../../shared/runtime/workspace-identity";
import type { AccessDefaults, AccessHistoryEntry } from "../domain/policy";

export type GovernanceDialogTarget =
  "defaults" | "export" | "import" | "history";
export type GovernanceDialogsProps = {
  controller: AccessController;
  dialog?: GovernanceDialogTarget | null;
  onDialogChange?: (dialog: GovernanceDialogTarget | null) => void;
  showLauncher?: boolean;
};
type ImportMode = "merge" | "replace";

function historyDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date)
    : value;
}

export function GovernanceDialogs({
  controller,
  dialog: controlledDialog,
  onDialogChange,
  showLauncher = true,
}: GovernanceDialogsProps) {
  const userId = useVerifiedWorkspaceUserId();
  const { state, actions } = controller;
  const [localDialog, setLocalDialog] = useState<GovernanceDialogTarget | null>(
    null,
  );
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
  const [defaultsDraft, setDefaultsDraft] = useState<AccessDefaults | null>(
    null,
  );
  const [defaultsBaseline, setDefaultsBaseline] =
    useState<EditableAccessDefaults | null>(null);
  const [journalIssue, setJournalIssue] = useState("");
  const [uncertainDefaults, setUncertainDefaults] = useState(false);
  const [uncertainDiscardOpen, setUncertainDiscardOpen] = useState(false);
  const restoredUserId = useRef<string | null>(null);
  const [defaultsDiscardOpen, setDefaultsDiscardOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importMode, setImportMode] = useState<ImportMode>("merge");
  const [replaceConfirmation, setReplaceConfirmation] = useState("");
  const [importSummary, setImportSummary] = useState("");
  const [selectedHistory, setSelectedHistory] =
    useState<AccessHistoryEntry | null>(null);
  const [restoreSummary, setRestoreSummary] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (restoredUserId.current === userId) return;
    restoredUserId.current = userId;
    const stored = readAccessDefaultsDraft(userId);
    if (stored.value) {
      setDefaultsBaseline(stored.value.baseline);
      setDefaultsDraft({ ...state.defaults, ...stored.value.draft });
      if (controlledDialog === undefined) setLocalDialog("defaults");
      onDialogChange?.("defaults");
    }
    if (stored.status === "uncertain") {
      setUncertainDefaults(true);
      setJournalIssue(
        "This defaults change may have completed. Review current defaults and the saved values before discarding this locked draft.",
      );
    } else if (stored.status === "unavailable")
      setJournalIssue(
        "Browser draft storage is unavailable. Defaults changes may not survive reload.",
      );
    else if (stored.status === "invalid")
      setJournalIssue(
        "A saved defaults draft could not be safely restored. It was not applied.",
      );
  }, [controlledDialog, onDialogChange, state.defaults, userId]);

  const recentHistory = state.history.slice(-100).reverse();
  const activeDialog =
    controlledDialog === undefined ? localDialog : controlledDialog;
  const displayedDefaults = defaultsDraft ?? state.defaults;
  const recoveryNeedsReload =
    uncertainDefaults && accessDraftSubmissionNeedsReload(userId, "defaults");
  const roleName = (id: string) =>
    state.roles.find((role) => role.id === id)?.name ?? id;
  const groupNames = (ids: string[]) =>
    ids
      .map((id) => state.groups.find((group) => group.id === id)?.name ?? id)
      .join(", ") || "None";
  const departmentNames = (ids: string[]) =>
    ids
      .map(
        (id) =>
          controller.departmentCatalog.find(
            (department) => department.id === id,
          )?.name ?? id,
      )
      .join(", ") || "None";
  const defaultsReviewRows = [
    [
      "Default role",
      roleName(state.defaults.defaultRoleId),
      roleName(displayedDefaults.defaultRoleId),
    ],
    [
      "Default groups",
      groupNames(state.defaults.defaultGroupIds),
      groupNames(displayedDefaults.defaultGroupIds),
    ],
    [
      "Default departments",
      departmentNames(state.defaults.defaultDepartmentIds),
      departmentNames(displayedDefaults.defaultDepartmentIds),
    ],
    [
      "Invitation expiry",
      `${state.defaults.invitationExpiryDays} days`,
      `${displayedDefaults.invitationExpiryDays} days`,
    ],
    [
      "Guest duration",
      `${state.defaults.guestDurationDays} days`,
      `${displayedDefaults.guestDurationDays} days`,
    ],
    [
      "Service duration",
      `${state.defaults.serviceDurationDays} days`,
      `${displayedDefaults.serviceDurationDays} days`,
    ],
  ];
  const defaultsStale =
    defaultsBaseline !== null &&
    JSON.stringify(defaultsBaseline) !==
      JSON.stringify(editableAccessDefaults(state.defaults));
  const defaultsTargetMissing =
    !state.roles.some((role) => role.id === displayedDefaults.defaultRoleId) ||
    displayedDefaults.defaultGroupIds.some(
      (id) => !state.groups.some((group) => group.id === id),
    ) ||
    displayedDefaults.defaultDepartmentIds.some(
      (id) =>
        !controller.departmentCatalog.some(
          (department) => department.id === id,
        ),
    );
  const defaultsDirty =
    defaultsDraft !== null &&
    JSON.stringify(editableAccessDefaults(defaultsDraft)) !==
      JSON.stringify(
        defaultsBaseline ?? editableAccessDefaults(state.defaults),
      );
  const importDirty =
    activeDialog === "import" &&
    (importText.length > 0 ||
      importMode !== "merge" ||
      replaceConfirmation.length > 0);

  useAccessDraftRegistration(
    "governance-dialogs",
    (activeDialog === "defaults" && (defaultsDirty || uncertainDefaults)) ||
      importDirty,
    () => {
      if (uncertainDefaults) {
        setJournalIssue(
          "This defaults change may have completed. Review the current settings before discarding this locked draft.",
        );
        return false;
      }
      if (
        activeDialog === "defaults" &&
        defaultsDirty &&
        !clearAccessDefaultsDraft(userId)
      ) {
        setJournalIssue(
          "The browser could not clear your saved defaults draft. Keep editing or clear this site's browser data.",
        );
        return false;
      }
      setDefaultsDraft(null);
      setDefaultsBaseline(null);
      setDefaultsDiscardOpen(false);
      setImportText("");
      setImportMode("merge");
      setReplaceConfirmation("");
      setImportSummary("");
      setError("");
      setActiveDialog(null);
      return true;
    },
  );

  function setActiveDialog(dialog: GovernanceDialogTarget | null) {
    if (dialog === null && controller.isPending()) {
      setError("Finish the Access change before closing this dialog.");
      return;
    }
    if (controlledDialog === undefined) setLocalDialog(dialog);
    onDialogChange?.(dialog);
  }

  function openDefaults() {
    if (!defaultsDraft) {
      setDefaultsDraft(structuredClone(state.defaults));
      setDefaultsBaseline(editableAccessDefaults(state.defaults));
    }
    setDefaultsDiscardOpen(false);
    setError("");
    setActiveDialog("defaults");
  }

  function updateDefaultsDraft(patch: Partial<EditableAccessDefaults>) {
    if (uncertainDefaults) return;
    const baseline = defaultsBaseline ?? editableAccessDefaults(state.defaults);
    const next = { ...displayedDefaults, ...patch };
    const editable = editableAccessDefaults(next);
    const preserved =
      JSON.stringify(editable) === JSON.stringify(baseline)
        ? clearAccessDefaultsDraft(userId)
        : writeAccessDefaultsDraft(userId, {
            baseline,
            draft: editable,
          });
    if (!preserved) {
      clearAccessDefaultsDraft(userId);
      setJournalIssue(
        "The browser could not keep your latest defaults change for reload. Keep this tab open and save it before leaving.",
      );
    } else setJournalIssue("");
    setDefaultsBaseline(baseline);
    setDefaultsDraft(next);
  }

  function requestDefaultsClose() {
    if (uncertainDefaults) {
      setJournalIssue(
        "Review and discard the uncertain defaults draft before closing this dialog.",
      );
      return;
    }
    if (controller.isPending()) {
      setError("Finish the Access change before closing this dialog.");
      return;
    }
    if (defaultsDirty) {
      setDefaultsDiscardOpen(true);
      return;
    }
    setDefaultsDraft(null);
    setActiveDialog(null);
  }

  function discardDefaultsDraft() {
    if (uncertainDefaults) {
      setJournalIssue(
        "Use Review and discard locked draft after checking current defaults.",
      );
      return;
    }
    if (controller.isPending()) {
      setError("Finish the Access change before discarding this draft.");
      return;
    }
    if (!clearAccessDefaultsDraft(userId)) {
      setJournalIssue(
        "The browser could not clear your saved defaults draft. Keep editing or clear this site's browser data.",
      );
      return;
    }
    setDefaultsDraft(null);
    setDefaultsBaseline(null);
    setDefaultsDiscardOpen(false);
    setError("");
    setActiveDialog(null);
  }

  async function saveDefaults() {
    if (uncertainDefaults) {
      setError(
        "Review the uncertain defaults change before starting another one.",
      );
      return;
    }
    if (defaultsTargetMissing) {
      setError(
        "This defaults draft refers to a role, group, or department that is no longer available. Discard it and review the current settings.",
      );
      return;
    }
    if (defaultsStale) {
      setError(
        "Defaults changed after this draft was opened. Discard it and review the current settings before saving.",
      );
      return;
    }
    if (controller.isPending()) {
      setError(
        "Another Access change is already in progress. Try again shortly.",
      );
      return;
    }
    if (
      !beginAccessDefaultsDraftSubmission(userId, {
        baseline: defaultsBaseline ?? editableAccessDefaults(state.defaults),
        draft: editableAccessDefaults(displayedDefaults),
      })
    ) {
      setError(
        "The browser could not protect your defaults draft before saving. No defaults request was sent; check browser storage and try again.",
      );
      return;
    }
    setUncertainDefaults(true);
    const result = await actions.updateDefaults(displayedDefaults);
    if (!result.ok) {
      setError(result.error);
      setJournalIssue(
        "This defaults change may have completed. Review current defaults before discarding this locked draft.",
      );
      return;
    }
    if (!completeAccessDefaultsDraftSubmission(userId)) {
      setJournalIssue(
        "Defaults were saved, but browser cleanup failed. This draft remains locked until you review current defaults and discard it.",
      );
      setNotice("Access defaults updated.");
      return;
    }
    setUncertainDefaults(false);
    setActiveDialog(null);
    setDefaultsDraft(null);
    setDefaultsBaseline(null);
    setError("");
    setNotice("Access defaults updated.");
  }

  function discardUncertainDefaultsDraft() {
    if (accessDraftSubmissionNeedsReload(userId, "defaults")) {
      setUncertainDiscardOpen(false);
      setJournalIssue(
        "Reload Access and review current defaults before discarding this uncertain draft.",
      );
      return;
    }
    if (
      controller.resource.status !== "ready" ||
      controller.resource.refreshing ||
      controller.resource.error
    ) {
      setJournalIssue(
        "Refresh Access successfully before discarding this uncertain defaults draft.",
      );
      return;
    }
    if (!discardUncertainAccessDefaultsDraft(userId)) {
      setUncertainDiscardOpen(false);
      setJournalIssue(
        "The browser could not clear the uncertain defaults draft. It remains locked; try again when browser storage works.",
      );
      return;
    }
    setUncertainDefaults(false);
    setUncertainDiscardOpen(false);
    setDefaultsDraft(null);
    setDefaultsBaseline(null);
    setJournalIssue("");
    setError("");
    setActiveDialog(null);
  }

  function exportPolicy() {
    const policy = actions.exportPolicyBundle();
    const blob = new Blob([policy], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "openslate-access-policy.json";
    link.click();
    URL.revokeObjectURL(url);
    setActiveDialog(null);
    setNotice(
      "Policy configuration downloaded without identity membership or personal details.",
    );
  }

  function previewImport() {
    const result = actions.parsePolicyImport(importText);
    if (!result.ok) {
      setImportSummary("");
      setError(result.error);
      return;
    }
    setError("");
    setImportSummary(
      `Validated version 1 bundle: ${result.value.roles.length} custom roles, ${result.value.groups.length} groups, ${result.value.rules.length} rules, and ${result.value.templates.length} templates.`,
    );
  }

  async function applyImport() {
    if (controller.isPending()) {
      setError(
        "Another Access change is already in progress. Try again shortly.",
      );
      return;
    }
    const result = await actions.importPolicyBundle(importText, importMode);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setActiveDialog(null);
    setImportText("");
    setImportSummary("");
    setReplaceConfirmation("");
    setError("");
    setNotice(
      `Policy configuration ${importMode === "merge" ? "merged" : "replaced"}.`,
    );
  }

  function previewRestore(entry: AccessHistoryEntry) {
    const result = actions.previewHistoryRestore(entry.id);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSelectedHistory(entry);
    setRestoreSummary(result.summary);
    setError("");
    setActiveDialog(null);
    setRestoreOpen(true);
  }

  async function restoreHistory() {
    if (!selectedHistory) return;
    if (controller.isPending()) {
      setError(
        "Another Access change is already in progress. Try again shortly.",
      );
      return;
    }
    const result = await actions.applyHistoryRestore(selectedHistory.id);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setRestoreConfirmOpen(false);
    setSelectedHistory(null);
    setRestoreSummary("");
    setNotice(
      "Restored policy configuration from policy history. Identity records and membership were not changed.",
    );
  }

  return (
    <>
      <div className="flex flex-col gap-3" aria-live="polite">
        {notice ? <Alert variant="success">{notice}</Alert> : null}
        {error ? (
          <Alert role="alert" variant="destructive">
            {error}
          </Alert>
        ) : null}
      </div>
      {showLauncher && (
        <section
          aria-labelledby="governance-title"
          className="mt-6 flex flex-wrap items-center justify-between gap-4 border-t px-1 pt-5"
        >
          <div className="flex min-w-0 items-start gap-3">
            <Settings2
              aria-hidden="true"
              className="text-muted-foreground mt-0.5 size-5 shrink-0"
            />
            <div>
              <h3 id="governance-title" className="text-sm font-medium">
                Workspace defaults
              </h3>
              <p className="text-muted-foreground mt-1 text-sm">
                {state.roles.find(
                  (role) => role.id === state.defaults.defaultRoleId,
                )?.name ?? "No default role"}{" "}
                role · {state.defaults.invitationExpiryDays}-day invitations ·
                Anything not listed: no access
              </p>
              <p className="text-muted-foreground mt-1 text-xs">
                Defaults apply to new identities. Existing access stays
                unchanged.
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-full sm:w-auto"
            onClick={openDefaults}
          >
            Configure defaults
          </Button>
        </section>
      )}

      <Dialog
        open={activeDialog === "defaults"}
        onOpenChange={(open) => {
          if (open) setActiveDialog("defaults");
          else requestDefaultsClose();
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Access defaults</DialogTitle>
            <DialogDescription>
              Defaults apply to newly prepared identities. Existing access is
              unchanged.
            </DialogDescription>
          </DialogHeader>
          {uncertainDefaults ? (
            <div className="space-y-2 rounded-md border p-3">
              <h3 className="font-semibold">
                Current defaults and saved draft
              </h3>
              <p className="text-muted-foreground text-sm">
                {recoveryNeedsReload
                  ? "Reload Access to compare against the latest defaults."
                  : "Current defaults were loaded from Access."}{" "}
                The saved values have not been submitted again.
              </p>
              <dl className="max-h-44 space-y-2 overflow-y-auto text-sm">
                {defaultsReviewRows.map(([label, current, saved]) => (
                  <div key={label} className="rounded-md border p-2">
                    <dt className="font-medium">{label}</dt>
                    <dd>Current: {current}</dd>
                    <dd>Saved: {saved}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
          <fieldset disabled={uncertainDefaults} className="contents">
            <FieldGroup className="grid gap-4 py-2 sm:grid-cols-2">
              <Field className="sm:col-span-2">
                <FieldLabel htmlFor="default-role">Default role</FieldLabel>
                <NativeSelect
                  id="default-role"
                  className="w-full [&>select]:min-h-11"
                  value={displayedDefaults.defaultRoleId}
                  onChange={(event) =>
                    updateDefaultsDraft({ defaultRoleId: event.target.value })
                  }
                >
                  {state.roles
                    .filter((role) => role.system !== "admin")
                    .map((role) => (
                      <NativeSelectOption key={role.id} value={role.id}>
                        {role.name}
                      </NativeSelectOption>
                    ))}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="invitation-days">
                  Invitation expiry days
                </FieldLabel>
                <Input
                  id="invitation-days"
                  type="number"
                  min={1}
                  max={365}
                  className="min-h-11"
                  value={displayedDefaults.invitationExpiryDays}
                  onChange={(event) =>
                    updateDefaultsDraft({
                      invitationExpiryDays: Number(event.target.value),
                    })
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="guest-days">
                  Guest duration days
                </FieldLabel>
                <Input
                  id="guest-days"
                  type="number"
                  min={1}
                  max={365}
                  className="min-h-11"
                  value={displayedDefaults.guestDurationDays}
                  onChange={(event) =>
                    updateDefaultsDraft({
                      guestDurationDays: Number(event.target.value),
                    })
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="service-days">
                  Service duration days
                </FieldLabel>
                <Input
                  id="service-days"
                  type="number"
                  min={1}
                  max={365}
                  className="min-h-11"
                  value={displayedDefaults.serviceDurationDays}
                  onChange={(event) =>
                    updateDefaultsDraft({
                      serviceDurationDays: Number(event.target.value),
                    })
                  }
                />
              </Field>
              <div className="flex flex-wrap content-end gap-2">
                <Badge variant="outline">Anything not listed: no access</Badge>
                <Badge variant="outline">Guest sponsor · required</Badge>
                <Badge variant="outline">Service owner · required</Badge>
              </div>
              <Field className="sm:col-span-2">
                <FieldLabel>Default departments</FieldLabel>
                <ToggleGroup
                  aria-label="Default departments"
                  multiple
                  value={displayedDefaults.defaultDepartmentIds}
                  onValueChange={(values) =>
                    updateDefaultsDraft({ defaultDepartmentIds: values })
                  }
                  variant="outline"
                  className="flex w-full flex-wrap justify-start"
                >
                  {controller.departmentCatalog.map((department) => (
                    <ToggleGroupItem
                      key={department.id}
                      value={department.id}
                      className="min-h-11"
                    >
                      {department.name}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                <FieldDescription>
                  Choose zero or more starting departments.
                </FieldDescription>
              </Field>
              <Field className="sm:col-span-2">
                <FieldLabel>Default groups</FieldLabel>
                <ToggleGroup
                  aria-label="Default groups"
                  multiple
                  value={displayedDefaults.defaultGroupIds}
                  onValueChange={(values) =>
                    updateDefaultsDraft({ defaultGroupIds: values })
                  }
                  variant="outline"
                  className="flex w-full flex-wrap justify-start"
                >
                  {state.groups.map((group) => (
                    <ToggleGroupItem
                      key={group.id}
                      value={group.id}
                      className="min-h-11"
                    >
                      {group.name}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>
              {error ? (
                <Alert
                  role="alert"
                  className="sm:col-span-2"
                  variant="destructive"
                >
                  {error}
                </Alert>
              ) : null}
              {journalIssue ? (
                <Alert role="alert" variant="warning" className="sm:col-span-2">
                  {journalIssue}
                </Alert>
              ) : null}
              {defaultsStale ? (
                <Alert role="alert" variant="warning" className="sm:col-span-2">
                  Defaults changed after this draft was opened. This draft
                  cannot be saved until you discard it and review the current
                  settings.
                </Alert>
              ) : null}
              {defaultsTargetMissing ? (
                <Alert role="alert" variant="warning" className="sm:col-span-2">
                  This defaults draft refers to a role, group, or department
                  that is no longer available. It cannot be saved.
                </Alert>
              ) : null}
            </FieldGroup>
          </fieldset>
          {uncertainDefaults ? (
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
              Review and discard locked defaults draft
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
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={uncertainDefaults}
              onClick={requestDefaultsClose}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="min-h-11"
              disabled={
                uncertainDefaults ||
                controller.isPending() ||
                defaultsStale ||
                defaultsTargetMissing
              }
              onClick={saveDefaults}
            >
              Save defaults
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={defaultsDiscardOpen}
        onOpenChange={(open) => {
          if (!open) setDefaultsDiscardOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Discard unsaved Access defaults?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Your Access defaults draft has unsaved changes. Discard it?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => setDefaultsDiscardOpen(false)}
            >
              Keep editing
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="min-h-11"
              disabled={controller.isPending()}
              onClick={discardDefaultsDraft}
            >
              Discard changes
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={uncertainDiscardOpen}
        onOpenChange={setUncertainDiscardOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Discard uncertain defaults draft?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The earlier defaults change may have completed. Review the current
              settings and your saved values before starting a new draft.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">
              Keep reviewing
            </AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              className="min-h-11"
              onClick={discardUncertainDefaultsDraft}
            >
              Discard locked draft
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={activeDialog === "export"}
        onOpenChange={(open) => setActiveDialog(open ? "export" : null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Export policy configuration</DialogTitle>
            <DialogDescription>
              Identity names, membership, sponsors, owners, sessions, and
              history are excluded. The JSON bundle contains defaults, custom
              roles, groups without membership, rules without identity-specific
              subjects, and templates.
            </DialogDescription>
          </DialogHeader>
          <Alert variant="warning">
            Review downloaded configuration before sharing it. Resource names
            and access design may still be confidential.
          </Alert>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => setActiveDialog(null)}
            >
              Cancel
            </Button>
            <Button type="button" className="min-h-11" onClick={exportPolicy}>
              <Download aria-hidden="true" data-icon="inline-start" /> Download
              JSON
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={activeDialog === "import"}
        onOpenChange={(open) => setActiveDialog(open ? "import" : null)}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Import policy configuration</DialogTitle>
            <DialogDescription>
              Paste a version 1 JSON policy bundle. Validation is fail-closed
              and does not apply changes.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-2">
            <Field>
              <FieldLabel htmlFor="policy-json">Policy JSON</FieldLabel>
              <Textarea
                id="policy-json"
                className="min-h-48 font-mono text-xs"
                value={importText}
                onChange={(event) => {
                  setImportText(event.target.value);
                  setImportSummary("");
                }}
                placeholder={'{"version":1,...}'}
              />
              <FieldDescription>
                Maximum 1 MiB. Identity-specific rules and identity material are
                rejected.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel>Import behavior</FieldLabel>
              <ToggleGroup
                aria-label="Import behavior"
                value={[importMode]}
                onValueChange={(values) => {
                  const value = values[0];
                  if (value === "merge" || value === "replace") {
                    setImportMode(value);
                    setReplaceConfirmation("");
                  }
                }}
                variant="outline"
                spacing={0}
                className="w-full [&>button]:min-h-11 [&>button]:flex-1"
              >
                <ToggleGroupItem value="merge">Merge</ToggleGroupItem>
                <ToggleGroupItem value="replace">Replace</ToggleGroupItem>
              </ToggleGroup>
            </Field>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={!importText.trim()}
              onClick={previewImport}
            >
              Validate and preview
            </Button>
            {importSummary ? (
              <Alert variant="success">
                {importMode === "merge" ? "Merge" : "Replace"} preview:{" "}
                {importSummary}
              </Alert>
            ) : null}
            {importMode === "replace" && importSummary ? (
              <Field>
                <FieldLabel htmlFor="replace-confirmation">
                  Type REPLACE to confirm
                </FieldLabel>
                <Input
                  id="replace-confirmation"
                  className="min-h-11"
                  autoComplete="off"
                  value={replaceConfirmation}
                  onChange={(event) =>
                    setReplaceConfirmation(event.target.value)
                  }
                />
                <FieldDescription>
                  Replace removes custom policy configuration not present in the
                  bundle. Built-in roles remain protected.
                </FieldDescription>
              </Field>
            ) : null}
            {error ? (
              <Alert role="alert" variant="destructive">
                {error}
              </Alert>
            ) : null}
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => setActiveDialog(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="min-h-11"
              disabled={
                !importSummary ||
                (importMode === "replace" &&
                  replaceConfirmation !== "REPLACE") ||
                controller.isPending()
              }
              onClick={applyImport}
            >
              {importMode === "merge" ? "Merge policy" : "Replace policy"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={activeDialog === "history"}
        onOpenChange={(open) => setActiveDialog(open ? "history" : null)}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Policy history</DialogTitle>
            <DialogDescription>
              Up to 100 recent policy events. This history is not an audit log.
            </DialogDescription>
          </DialogHeader>
          <div className="flex max-h-[60dvh] flex-col gap-2 overflow-y-auto py-2">
            {recentHistory.length ? (
              recentHistory.map((entry) => (
                <div
                  key={entry.id}
                  className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="font-medium">{entry.summary}</p>
                    <p className="text-muted-foreground mt-1 text-xs">
                      {historyDate(entry.occurredAt)} · {entry.target}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={!entry.restorable || controller.isPending()}
                    onClick={() => previewRestore(entry)}
                  >
                    <RotateCcw aria-hidden="true" data-icon="inline-start" />
                    Preview restore
                  </Button>
                </div>
              ))
            ) : (
              <p className="text-muted-foreground rounded-lg border p-6 text-center text-sm">
                No policy history yet.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => setActiveDialog(null)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={restoreOpen}
        onOpenChange={(open) => {
          if (!open && controller.isPending()) {
            setError("Finish the Access change before closing this dialog.");
            return;
          }
          setRestoreOpen(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Preview policy restore</DialogTitle>
            <DialogDescription>
              Only policy configuration will be restored. Identity records,
              membership, sessions, and policy history remain unchanged.
            </DialogDescription>
          </DialogHeader>
          <Alert>{restoreSummary || selectedHistory?.summary}</Alert>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => setRestoreOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="min-h-11"
              onClick={() => {
                setRestoreOpen(false);
                setRestoreConfirmOpen(true);
              }}
            >
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={restoreConfirmOpen}
        onOpenChange={(open) => {
          if (!open && controller.isPending()) {
            setError("Finish the Access change before closing this dialog.");
            return;
          }
          setRestoreConfirmOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>
            Restore this policy configuration?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This replaces the current policy configuration with the selected
            restorable snapshot. Identity and membership data are not restored.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11">Cancel</AlertDialogCancel>
            <Button
              type="button"
              className="min-h-11"
              disabled={controller.isPending()}
              onClick={restoreHistory}
            >
              Restore policy
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
