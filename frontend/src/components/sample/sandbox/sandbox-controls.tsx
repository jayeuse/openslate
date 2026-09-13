"use client";

import { useRef, useState, type ChangeEvent } from "react";
import {
  Download,
  PackageCheck,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  Upload,
} from "lucide-react";
import { Alert } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { counts, type Design, type Version } from "./model";
import {
  exportSandboxFile,
  parseSandboxFile,
  type SandboxFileV1,
} from "./file-format";
import { SANDBOX_LIMITS, type SandboxValidationIssue } from "./validation";

type SandboxControlsProps = {
  design: Design;
  versions: Version[];
  issues: SandboxValidationIssue[];
  onCreateCheckpoint: (name: string, note: string) => void;
  onCreateRelease: (note: string) => void;
  onImport: (file: SandboxFileV1) => void;
  onCreate: (kind: SandboxCreateKind) => void;
  onResetDesign: () => void;
  onClearData: () => void;
  onSelectIssue: (issue: SandboxValidationIssue) => void;
};

export type SandboxCreateKind =
  "department" | "module" | "field" | "relationship" | "automation-rule";

export type SandboxCreateRequest = {
  id: number;
  kind: SandboxCreateKind;
};

export function SandboxControls({
  design,
  versions,
  issues,
  onCreateCheckpoint,
  onCreateRelease,
  onImport,
  onCreate,
  onResetDesign,
  onClearData,
  onSelectIssue,
}: SandboxControlsProps) {
  const [checkpointOpen, setCheckpointOpen] = useState(false);
  const [checkpointName, setCheckpointName] = useState("");
  const [checkpointNote, setCheckpointNote] = useState("");
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [releaseNote, setReleaseNote] = useState("");
  const [portabilityOpen, setPortabilityOpen] = useState(false);
  const [includeVersions, setIncludeVersions] = useState(false);
  const [staged, setStaged] = useState<SandboxFileV1 | null>(null);
  const [importError, setImportError] = useState("");
  const [exportError, setExportError] = useState("");
  const [importInputKey, setImportInputKey] = useState(0);
  const [resetOpen, setResetOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const resetOpener = useRef<HTMLButtonElement | null>(null);
  const clearOpener = useRef<HTMLButtonElement | null>(null);
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");

  function clearStagedImport() {
    setStaged(null);
    setImportError("");
    setImportInputKey((key) => key + 1);
  }

  async function stageImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > SANDBOX_LIMITS.fileBytes) {
      setStaged(null);
      setImportError("Sandbox file exceeds the 2 MiB limit");
      return;
    }
    const result = parseSandboxFile(await file.text());
    if (!result.ok) {
      setStaged(null);
      setImportError(result.error);
      return;
    }
    setImportError("");
    setStaged(result.file);
  }

  function exportJson() {
    let text: string;
    try {
      text = exportSandboxFile({
        design,
        ...(includeVersions ? { versions } : {}),
      });
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : "Sandbox export failed",
      );
      return;
    }
    setExportError("");
    const url = URL.createObjectURL(
      new Blob([text], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "openslate-sandbox.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button aria-label="Create">
                <Plus />
                Create
              </Button>
            }
          />
          <DropdownMenuContent data-sandbox-portal align="start">
            <DropdownMenuItem
              className="min-h-11 min-w-11 xl:min-h-0 xl:min-w-0"
              onClick={() => onCreate("department")}
            >
              Department
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-11 min-w-11 xl:min-h-0 xl:min-w-0"
              onClick={() => onCreate("module")}
            >
              Module
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-11 min-w-11 xl:min-h-0 xl:min-w-0"
              onClick={() => onCreate("field")}
            >
              Field
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-11 min-w-11 xl:min-h-0 xl:min-w-0"
              onClick={() => onCreate("relationship")}
            >
              Relationship
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-11 min-w-11 xl:min-h-0 xl:min-w-0"
              onClick={() => onCreate("automation-rule")}
            >
              Automation rule
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="outline" onClick={() => setCheckpointOpen(true)}>
          <Save />
          Create checkpoint
        </Button>
        <Button onClick={() => setReleaseOpen(true)}>
          <PackageCheck />
          Create local release
        </Button>
        <Button variant="outline" onClick={() => setPortabilityOpen(true)}>
          <Upload />
          Import or export
        </Button>
        <Button
          ref={resetOpener}
          variant="ghost"
          onClick={() => setResetOpen(true)}
        >
          <RotateCcw />
          Reset design
        </Button>
        <Button
          ref={clearOpener}
          variant="ghost"
          onClick={() => setClearOpen(true)}
        >
          <Trash2 />
          Clear Sandbox data
        </Button>
      </div>

      <Alert
        aria-label="Sandbox validation summary"
        className="p-3 tabular-nums"
      >
        {errors.length} {errors.length === 1 ? "error" : "errors"} ·{" "}
        {warnings.length} {warnings.length === 1 ? "warning" : "warnings"}
      </Alert>

      {issues.length > 0 && (
        <Alert
          role="region"
          aria-label="Sandbox validation issues"
          variant={errors.length > 0 ? "destructive" : "warning"}
          className="p-3"
        >
          <p className="font-medium">
            {errors.length} validation{" "}
            {errors.length === 1 ? "error" : "errors"}
          </p>
          <ul className="mt-2 flex flex-col gap-1">
            {issues.map((issue, index) => (
              <li key={`${issue.code}-${issue.targetId ?? "design"}-${index}`}>
                <Button
                  variant="ghost"
                  className="text-primary h-auto justify-start p-0 text-left whitespace-normal underline-offset-4 hover:underline"
                  onClick={() => onSelectIssue(issue)}
                >
                  {issue.message}
                </Button>
              </li>
            ))}
          </ul>
        </Alert>
      )}

      <Dialog open={checkpointOpen} onOpenChange={setCheckpointOpen}>
        <DialogContent className="max-xl:[&_button]:min-h-11 max-xl:[&_button]:min-w-11 max-xl:[&_input:not([type=checkbox]):not([type=radio])]:min-h-11 max-xl:[&_select]:min-h-11">
          <DialogTitle>Create checkpoint</DialogTitle>
          <DialogDescription>
            Save a named snapshot of the current local design in this tab.
          </DialogDescription>
          <div className="mt-4 space-y-4">
            <Field>
              <FieldLabel htmlFor="sandbox-checkpoint-name">
                Checkpoint name
              </FieldLabel>
              <Input
                id="sandbox-checkpoint-name"
                autoFocus
                required
                maxLength={80}
                value={checkpointName}
                onChange={(event) => setCheckpointName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="sandbox-checkpoint-note">
                Checkpoint note
              </FieldLabel>
              <Textarea
                id="sandbox-checkpoint-note"
                maxLength={500}
                value={checkpointNote}
                onChange={(event) => setCheckpointNote(event.target.value)}
              />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCheckpointOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!checkpointName.trim()}
              onClick={() => {
                onCreateCheckpoint(
                  checkpointName.trim(),
                  checkpointNote.trim(),
                );
                setCheckpointName("");
                setCheckpointNote("");
                setCheckpointOpen(false);
              }}
            >
              Save checkpoint
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={releaseOpen}
        onOpenChange={(open) => {
          setReleaseOpen(open);
          if (!open) setReleaseNote("");
        }}
      >
        <DialogContent className="max-xl:[&_button]:min-h-11 max-xl:[&_button]:min-w-11 max-xl:[&_input:not([type=checkbox]):not([type=radio])]:min-h-11 max-xl:[&_select]:min-h-11">
          <DialogTitle>Review local release</DialogTitle>
          <DialogDescription>
            Review this tab-local snapshot before confirming. No live workspace
            will be changed.
          </DialogDescription>
          <div className="mt-4 space-y-4 text-sm">
            <section
              aria-label="Local release summary"
              className="bg-muted rounded-lg p-4"
            >
              <p className="font-medium">Current design</p>
              <p className="text-muted-foreground mt-1">{counts(design)}</p>
              <p className="mt-3">
                {errors.length} {errors.length === 1 ? "error" : "errors"} ·{" "}
                {warnings.length}{" "}
                {warnings.length === 1 ? "warning" : "warnings"}
              </p>
              {issues.length > 0 && (
                <ul className="mt-2 list-inside list-disc space-y-1">
                  {issues.map((issue, index) => (
                    <li
                      key={`${issue.code}-${issue.targetId ?? "design"}-${index}`}
                    >
                      {issue.message}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <Field>
              <FieldLabel htmlFor="sandbox-release-note">
                Release note
              </FieldLabel>
              <Textarea
                id="sandbox-release-note"
                autoFocus
                maxLength={500}
                value={releaseNote}
                onChange={(event) => setReleaseNote(event.target.value)}
              />
            </Field>
            {errors.length > 0 && (
              <Alert role="alert" variant="destructive">
                Resolve validation errors before creating this local release.
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReleaseOpen(false)}>
              Cancel release
            </Button>
            <Button
              disabled={errors.length > 0}
              onClick={() => {
                onCreateRelease(releaseNote.trim());
                setReleaseOpen(false);
                setReleaseNote("");
              }}
            >
              Confirm local release
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={portabilityOpen}
        onOpenChange={(open) => {
          setPortabilityOpen(open);
          if (!open) {
            clearStagedImport();
            setExportError("");
          }
        }}
      >
        <DialogContent className="max-xl:[&_button:not([data-slot=checkbox])]:min-h-11 max-xl:[&_button:not([data-slot=checkbox])]:min-w-11 max-xl:[&_input:not([type=checkbox]):not([type=radio])]:min-h-11 max-xl:[&_select]:min-h-11">
          <DialogTitle>Sandbox import and export</DialogTitle>
          <DialogDescription>
            JSON files stay on this device. Import replaces the current Sandbox
            only after confirmation.
          </DialogDescription>
          <div className="mt-4 space-y-5">
            <section className="space-y-3" aria-label="Export sandbox">
              <Field className="flex-row items-center gap-2">
                <Checkbox
                  id="sandbox-include-versions"
                  checked={includeVersions}
                  onCheckedChange={setIncludeVersions}
                />
                <FieldLabel
                  htmlFor="sandbox-include-versions"
                  className="flex min-h-11 min-w-11 flex-1 cursor-pointer items-center font-normal xl:min-h-0 xl:min-w-0"
                >
                  Include checkpoints and local releases
                </FieldLabel>
              </Field>
              <Button variant="outline" onClick={exportJson}>
                <Download />
                Export JSON
              </Button>
              {exportError ? (
                <Alert role="alert" variant="destructive">
                  {exportError}
                </Alert>
              ) : null}
            </section>
            <section
              className="border-border space-y-3 border-t pt-4"
              aria-label="Import sandbox"
            >
              <Field>
                <FieldLabel htmlFor="sandbox-import-file">
                  Import sandbox JSON
                </FieldLabel>
                <Input
                  id="sandbox-import-file"
                  key={importInputKey}
                  type="file"
                  accept="application/json,.json"
                  onChange={stageImport}
                />
              </Field>
              {importError && (
                <Alert role="alert" variant="destructive">
                  {importError}
                </Alert>
              )}
              {staged && (
                <div className="bg-muted rounded-md p-3 text-sm">
                  <p className="font-medium">Replace sandbox from file?</p>
                  <p className="text-muted-foreground mt-1">
                    {counts(staged.design)}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      onClick={() => {
                        onImport(staged);
                        clearStagedImport();
                        setPortabilityOpen(false);
                      }}
                    >
                      Replace sandbox
                    </Button>
                    <Button variant="outline" onClick={clearStagedImport}>
                      Cancel import
                    </Button>
                  </div>
                </div>
              )}
            </section>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent
          className="max-xl:[&_button]:min-h-11 max-xl:[&_button]:min-w-11 max-xl:[&_input:not([type=checkbox]):not([type=radio])]:min-h-11 max-xl:[&_select]:min-h-11"
          finalFocus={() => resetOpener.current}
        >
          <AlertDialogTitle>Reset design?</AlertDialogTitle>
          <AlertDialogDescription>
            This replaces only the current Design with the initial sample as one
            undoable action. Versions, Simulation data, and view preferences
            stay in this tab.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setResetOpen(false)}>
              Cancel reset
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                onResetDesign();
                setResetOpen(false);
              }}
            >
              Reset current design
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
        <AlertDialogContent
          className="max-xl:[&_button]:min-h-11 max-xl:[&_button]:min-w-11 max-xl:[&_input:not([type=checkbox]):not([type=radio])]:min-h-11 max-xl:[&_select]:min-h-11"
          finalFocus={() => clearOpener.current}
        >
          <AlertDialogTitle>Clear Sandbox data?</AlertDialogTitle>
          <AlertDialogDescription>
            This clears the Sandbox Design and undo history, Versions,
            Simulation data, and Sandbox view preferences in this tab, then
            loads the defaults. Other sample workspace areas are unchanged.
            Recovery is available until reload or your next Sandbox change.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setClearOpen(false)}>
              Cancel clear
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                onClearData();
                setClearOpen(false);
              }}
            >
              Clear Sandbox data
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
