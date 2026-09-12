"use client";

import { useState } from "react";
import { Download, History, RotateCcw, Settings2, Upload } from "lucide-react";

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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

import type { AccessController } from "./controller";
import type { AccessDefaults, AccessHistoryEntry } from "./policy";

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
  const { state, actions } = controller;
  const [localDialog, setLocalDialog] = useState<GovernanceDialogTarget | null>(
    null,
  );
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreConfirmOpen, setRestoreConfirmOpen] = useState(false);
  const [defaultsDraft, setDefaultsDraft] = useState<AccessDefaults | null>(
    null,
  );
  const [importText, setImportText] = useState("");
  const [importMode, setImportMode] = useState<ImportMode>("merge");
  const [replaceConfirmation, setReplaceConfirmation] = useState("");
  const [importSummary, setImportSummary] = useState("");
  const [selectedHistory, setSelectedHistory] =
    useState<AccessHistoryEntry | null>(null);
  const [restoreSummary, setRestoreSummary] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const recentHistory = state.history.slice(-100).reverse();
  const activeDialog =
    controlledDialog === undefined ? localDialog : controlledDialog;
  const displayedDefaults = defaultsDraft ?? state.defaults;

  function setActiveDialog(dialog: GovernanceDialogTarget | null) {
    if (controlledDialog === undefined) setLocalDialog(dialog);
    onDialogChange?.(dialog);
  }

  function openDefaults() {
    setDefaultsDraft(structuredClone(state.defaults));
    setError("");
    setActiveDialog("defaults");
  }

  function saveDefaults() {
    const result = actions.updateDefaults(displayedDefaults);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setActiveDialog(null);
    setDefaultsDraft(null);
    setError("");
    setNotice("Access defaults updated.");
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

  function applyImport() {
    const result = actions.importPolicyBundle(importText, importMode);
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
      `Policy configuration ${importMode === "merge" ? "merged" : "replaced"} locally.`,
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

  function restoreHistory() {
    if (!selectedHistory) return;
    const result = actions.applyHistoryRestore(selectedHistory.id);
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
      {showLauncher ? (
        <section
          aria-labelledby="governance-title"
          className="flex flex-col gap-3"
        >
          <div>
            <h2
              id="governance-title"
              className="text-xl font-semibold tracking-tight"
            >
              Governance
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Manage policy defaults, portable configuration, and restorable
              policy history.
            </p>
          </div>
          {notice ? <Alert variant="success">{notice}</Alert> : null}
          {error ? (
            <Alert role="alert" variant="destructive">
              {error}
            </Alert>
          ) : null}

          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader className="p-3">
                <Settings2 aria-hidden="true" />
                <CardTitle>Access defaults</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 p-3">
                <p className="text-muted-foreground text-sm">
                  Set default membership and bounded expiry periods.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  onClick={openDefaults}
                >
                  Configure defaults
                </Button>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="p-3">
                <Download aria-hidden="true" />
                <CardTitle>Policy export</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 p-3">
                <p className="text-muted-foreground text-sm">
                  Download policy configuration without identity data.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  onClick={() => setActiveDialog("export")}
                >
                  Review export
                </Button>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="p-3">
                <Upload aria-hidden="true" />
                <CardTitle>Policy import</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 p-3">
                <p className="text-muted-foreground text-sm">
                  Validate, merge, or replace versioned policy JSON.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  onClick={() => {
                    setError("");
                    setActiveDialog("import");
                  }}
                >
                  Import JSON
                </Button>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="p-3">
                <History aria-hidden="true" />
                <CardTitle>Policy history</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 p-3">
                <p className="text-muted-foreground text-sm">
                  Review and restore policy-only history.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  onClick={() => setActiveDialog("history")}
                >
                  View policy history
                </Button>
              </CardContent>
            </Card>
          </div>
        </section>
      ) : (
        <div className="flex flex-col gap-3" aria-live="polite">
          {notice ? <Alert variant="success">{notice}</Alert> : null}
          {error ? (
            <Alert role="alert" variant="destructive">
              {error}
            </Alert>
          ) : null}
        </div>
      )}

      <Dialog
        open={activeDialog === "defaults"}
        onOpenChange={(open) => {
          setActiveDialog(open ? "defaults" : null);
          if (!open) setDefaultsDraft(null);
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
          <FieldGroup className="grid gap-4 py-2 sm:grid-cols-2">
            <Field className="sm:col-span-2">
              <FieldLabel htmlFor="default-role">Default role</FieldLabel>
              <NativeSelect
                id="default-role"
                className="w-full [&>select]:min-h-11"
                value={displayedDefaults.defaultRoleId}
                onChange={(event) =>
                  setDefaultsDraft((current) => ({
                    ...(current ?? state.defaults),
                    defaultRoleId: event.target.value,
                  }))
                }
              >
                {state.roles.map((role) => (
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
                  setDefaultsDraft((current) => ({
                    ...(current ?? state.defaults),
                    invitationExpiryDays: Number(event.target.value),
                  }))
                }
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="guest-days">Guest duration days</FieldLabel>
              <Input
                id="guest-days"
                type="number"
                min={1}
                max={365}
                className="min-h-11"
                value={displayedDefaults.guestDurationDays}
                onChange={(event) =>
                  setDefaultsDraft((current) => ({
                    ...(current ?? state.defaults),
                    guestDurationDays: Number(event.target.value),
                  }))
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
                  setDefaultsDraft((current) => ({
                    ...(current ?? state.defaults),
                    serviceDurationDays: Number(event.target.value),
                  }))
                }
              />
            </Field>
            <div className="flex flex-wrap content-end gap-2">
              <Badge variant="outline">Default deny · required</Badge>
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
                  setDefaultsDraft((current) => ({
                    ...(current ?? state.defaults),
                    defaultDepartmentIds: values,
                  }))
                }
                variant="outline"
                className="flex w-full flex-wrap justify-start"
              >
                {controller.scopeCatalog
                  .filter((scope) => scope.kind === "department")
                  .map((scope) => (
                    <ToggleGroupItem
                      key={scope.id}
                      value={scope.id}
                      className="min-h-11"
                    >
                      {scope.name}
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
                  setDefaultsDraft((current) => ({
                    ...(current ?? state.defaults),
                    defaultGroupIds: values,
                  }))
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
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => {
                setDefaultsDraft(null);
                setActiveDialog(null);
              }}
            >
              Cancel
            </Button>
            <Button type="button" className="min-h-11" onClick={saveDefaults}>
              Save defaults
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
                (importMode === "replace" && replaceConfirmation !== "REPLACE")
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
                    disabled={!entry.restorable}
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

      <Dialog open={restoreOpen} onOpenChange={setRestoreOpen}>
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
        onOpenChange={setRestoreConfirmOpen}
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
            <Button type="button" className="min-h-11" onClick={restoreHistory}>
              Restore policy
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
