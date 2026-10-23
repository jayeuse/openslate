"use client";

import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Download,
  FileDown,
  MoreHorizontal,
  RotateCcw,
  Save,
  Upload,
} from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { reportDone } from "@/lib/feedback";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  parseSandboxDocument,
  type SandboxDocumentV4,
} from "../domain/document";
import type { SandboxOrganizationTemplate } from "../domain/templates";
import { exportSandboxBundle } from "../state/api";
import { sandboxVersionPageOptions } from "../state/sandbox-queries";
import { useSandboxHistoryAccess } from "../state/sandbox-history-access";
import { useWorkspaceInteractionSuspended } from "../../shared/runtime/workspace-identity";
import type { SandboxCommandResult } from "../state/commands";
import { OrganizationTemplateDialog } from "./organization-template-dialog";
import {
  VersionCapacityBanner,
  type VersionCapacityActions,
} from "./version-capacity-banner";

type Props = {
  versionsRefreshKey: number;
  versionCapacity: VersionCapacityActions;
  pending: boolean;
  /** The page owns the template dialog so the empty canvas can open it too. */
  templatesOpen: boolean;
  onTemplatesOpenChange: (open: boolean) => void;
  /** The page owns the checkpoint dialog so History can open it too. */
  checkpointOpen: boolean;
  onCheckpointOpenChange: (open: boolean) => void;
  /** A checkpoint of an empty design would save nothing. */
  canCheckpoint: boolean;
  /** Discard only acts when the draft differs from what was published. */
  canDiscard: boolean;
  /** With a publish, Discard returns to it; without one, it clears the draft. */
  hasPublish: boolean;
  onCreateCheckpoint: (
    label: string,
    note: string,
  ) => Promise<SandboxCommandResult<unknown>>;
  onImport: (
    document: SandboxDocumentV4,
  ) => Promise<SandboxCommandResult<unknown>>;
  onApplyTemplate: (
    template: SandboxOrganizationTemplate,
  ) => Promise<SandboxCommandResult<unknown>>;
  onDiscard: () => Promise<SandboxCommandResult<unknown>>;
};

function download(name: string, document: SandboxDocumentV4) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(document, null, 2)], { type: "application/json" }),
  );
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  window.document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function SandboxHeaderActions({
  versionsRefreshKey,
  versionCapacity,
  pending,
  templatesOpen,
  onTemplatesOpenChange,
  checkpointOpen,
  onCheckpointOpenChange: setCheckpointOpen,
  canCheckpoint,
  canDiscard,
  hasPublish,
  onCreateCheckpoint,
  onImport,
  onApplyTemplate,
  onDiscard,
}: Props) {
  const input = useRef<HTMLInputElement | null>(null);
  const menuId = useId();
  // A disabled menu item says why on a muted second line.
  const checkpointReason = canCheckpoint
    ? null
    : "Add a department or module first.";
  const discardReason = canDiscard
    ? null
    : hasPublish
      ? "The draft matches the last publish."
      : "Nothing to discard yet.";
  const [importOpen, setImportOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [staged, setStaged] = useState<SandboxDocumentV4 | null>(null);
  const [stagedName, setStagedName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [includeVersions, setIncludeVersions] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const exportController = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const suspended = useWorkspaceInteractionSuspended();
  const historyAccess = useSandboxHistoryAccess();
  // Observe the same unfiltered first page as capacity and History. The
  // filtered total, mutable count and visible row count are not export totals.
  const versionCount = useQuery({
    ...sandboxVersionPageOptions(
      { limit: 25, offset: 0, search: undefined, kind: undefined },
      versionsRefreshKey,
    ),
    select: (page) => page.total,
    enabled: importOpen && !historyAccess.denied && !suspended,
  });
  const countUnavailable = historyAccess.denied || versionCount.isError;
  const countLoading = versionCount.isPending || versionCount.isFetching;
  const countReady =
    !countUnavailable && !countLoading && !suspended && versionCount.isSuccess;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      exportController.current?.abort();
      exportController.current = null;
    };
  }, []);
  useEffect(() => {
    if (suspended) {
      exportController.current?.abort();
      exportController.current = null;
      setExportBusy(false);
    }
  }, [suspended]);
  function cancelExport() {
    exportController.current?.abort();
    exportController.current = null;
    setExportBusy(false);
  }
  async function checkpoint() {
    if (!label.trim()) {
      setError("Give this checkpoint a short name.");
      return;
    }
    setBusy(true);
    setError("");
    const result = await onCreateCheckpoint(label.trim(), note.trim());
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setCheckpointOpen(false);
    setLabel("");
    setNote("");
  }
  async function stageImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const result = parseSandboxDocument(await file.text());
    setStaged(result.ok ? result.document : null);
    setStagedName(result.ok ? file.name : "");
    setError(result.ok ? "" : result.error);
  }
  async function importDocument() {
    if (!staged) return;
    setBusy(true);
    setError("");
    const result = await onImport(staged);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setImportOpen(false);
    setStaged(null);
  }
  async function exportDocument() {
    if (pending || busy || suspended || !countReady || exportController.current)
      return;
    const controller = new AbortController();
    exportController.current = controller;
    setExportBusy(true);
    setError("");
    try {
      const bundle = await exportSandboxBundle({
        includeVersions,
        signal: controller.signal,
      });
      if (
        mounted.current &&
        !controller.signal.aborted &&
        exportController.current === controller
      ) {
        download(bundle.filename, bundle.document);
        reportDone("Backup downloaded");
      }
    } catch {
      if (
        mounted.current &&
        !controller.signal.aborted &&
        exportController.current === controller
      )
        setError("Export could not be completed. Try again.");
    } finally {
      if (mounted.current && exportController.current === controller) {
        exportController.current = null;
        setExportBusy(false);
      }
    }
  }
  async function discard() {
    setBusy(true);
    setError("");
    try {
      const result = await onDiscard();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDiscardOpen(false);
    } catch {
      setError("Draft changes could not be discarded. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="max-xl:size-11"
              aria-label="More Sandbox actions"
            >
              <MoreHorizontal />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="slim-ui">
          <DropdownMenuItem
            className="min-h-11 flex-col items-start justify-center gap-0 data-disabled:opacity-100"
            disabled={!canCheckpoint}
            aria-labelledby={`${menuId}-checkpoint`}
            aria-describedby={
              checkpointReason ? `${menuId}-checkpoint-reason` : undefined
            }
            onClick={() => setCheckpointOpen(true)}
          >
            <span
              id={`${menuId}-checkpoint`}
              className={checkpointReason ? "opacity-50" : undefined}
            >
              Save checkpoint
            </span>
            {checkpointReason ? (
              <span
                id={`${menuId}-checkpoint-reason`}
                className="text-muted-foreground text-xs"
              >
                {checkpointReason}
              </span>
            ) : null}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="min-h-11"
            onClick={() => onTemplatesOpenChange(true)}
          >
            Start from a template
          </DropdownMenuItem>
          <DropdownMenuItem
            className="min-h-11"
            onClick={() => setImportOpen(true)}
          >
            Import or export
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-danger-text data-highlighted:bg-danger-tint data-highlighted:text-danger-text min-h-11 flex-col items-start justify-center gap-0 data-disabled:opacity-100"
            disabled={!canDiscard}
            aria-labelledby={`${menuId}-discard`}
            aria-describedby={
              discardReason ? `${menuId}-discard-reason` : undefined
            }
            onClick={() => setDiscardOpen(true)}
          >
            <span
              id={`${menuId}-discard`}
              className={discardReason ? "opacity-50" : undefined}
            >
              Discard draft changes
            </span>
            {discardReason ? (
              <span
                id={`${menuId}-discard-reason`}
                className="text-muted-foreground text-xs"
              >
                {discardReason}
              </span>
            ) : null}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <OrganizationTemplateDialog
        open={templatesOpen}
        pending={pending || busy}
        onOpenChange={onTemplatesOpenChange}
        onApply={onApplyTemplate}
      />
      <Dialog
        open={checkpointOpen}
        onOpenChange={(open) => !busy && setCheckpointOpen(open)}
      >
        <DialogContent className="slim-ui grid gap-4">
          <DialogHeader>
            <DialogTitle>Save checkpoint</DialogTitle>
          </DialogHeader>
          <VersionCapacityBanner
            {...versionCapacity}
            pending={versionCapacity.pending || busy}
          />
          {error ? <Alert variant="destructive">{error}</Alert> : null}
          <Field>
            <FieldLabel htmlFor="sandbox-checkpoint-label">
              Checkpoint name
            </FieldLabel>
            <Input
              id="sandbox-checkpoint-label"
              value={label}
              maxLength={80}
              onChange={(event) => setLabel(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="sandbox-checkpoint-note">
              Note (optional)
            </FieldLabel>
            <Textarea
              id="sandbox-checkpoint-note"
              value={note}
              maxLength={1000}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
          <DialogFooter className="mt-1">
            <Button
              variant="outline"
              className="min-h-11"
              disabled={busy}
              onClick={() => setCheckpointOpen(false)}
            >
              Cancel
            </Button>
            <Button
              className="min-h-11"
              disabled={pending}
              pending={busy}
              pendingLabel="Saving…"
              onClick={() => void checkpoint()}
            >
              <Save />
              Save checkpoint
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={importOpen}
        onOpenChange={(open) => {
          if (busy) return;
          if (!open) cancelExport();
          setImportOpen(open);
        }}
      >
        <DialogContent className="slim-ui">
          <DialogHeader>
            <DialogTitle>Import or export</DialogTitle>
            <DialogDescription>
              Download a backup file of this draft, or replace the draft with a
              backup you downloaded before.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Field>
              <FieldLabel
                htmlFor="sandbox-export-history"
                className="flex min-h-11 items-center gap-3"
              >
                <Checkbox
                  id="sandbox-export-history"
                  checked={includeVersions}
                  onCheckedChange={setIncludeVersions}
                  disabled={pending || busy || exportBusy || !countReady}
                />
                Include version history
              </FieldLabel>
            </Field>
            {countUnavailable ? (
              <Alert variant="destructive" className="space-y-3">
                <p>Version count is unavailable.</p>
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={
                    pending ||
                    busy ||
                    exportBusy ||
                    versionCount.isFetching ||
                    suspended
                  }
                  onClick={() => void versionCount.refetch()}
                >
                  Retry version count
                </Button>
              </Alert>
            ) : countLoading ? (
              <p role="status" className="text-muted-foreground text-sm">
                Loading version count…
              </p>
            ) : countReady ? (
              <p className="text-sm">
                {versionCount.data} saved version
                {versionCount.data === 1 ? "" : "s"}
              </p>
            ) : null}
            <p className="text-muted-foreground text-sm">
              Imported versions count toward the 50-version limit.
            </p>
          </div>
          {error ? <Alert variant="destructive">{error}</Alert> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              className="min-h-11"
              disabled={pending || busy || exportBusy || !countReady}
              onClick={() => void exportDocument()}
            >
              <Download />
              {exportBusy ? "Downloading…" : "Download a backup"}
            </Button>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={pending || busy || exportBusy}
              onClick={() => input.current?.click()}
            >
              <Upload />
              Load a backup
            </Button>
          </div>
          <input
            ref={input}
            type="file"
            accept="application/json"
            className="sr-only"
            onChange={(event) => void stageImport(event)}
          />
          {staged ? (
            <p className="text-sm">
              <span className="font-medium">{stagedName}</span> · Replaces your
              draft
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={busy}
              onClick={() => {
                cancelExport();
                setImportOpen(false);
              }}
            >
              Cancel
            </Button>
            {staged ? (
              <Button
                className="min-h-11"
                disabled={pending || exportBusy}
                pending={busy}
                pendingLabel="Importing…"
                onClick={() => void importDocument()}
              >
                <FileDown />
                Import draft
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={discardOpen}
        onOpenChange={(open) => !busy && setDiscardOpen(open)}
      >
        <DialogContent className="slim-ui grid gap-4">
          <DialogHeader>
            <DialogTitle>Discard draft changes?</DialogTitle>
            <DialogDescription>
              {hasPublish
                ? "Saves a checkpoint, then resets the draft to the last publish. Live data stays."
                : "Saves a checkpoint, then clears the draft. Live data stays."}
            </DialogDescription>
          </DialogHeader>
          {error ? <Alert variant="destructive">{error}</Alert> : null}
          <DialogFooter className="mt-1">
            <Button
              variant="outline"
              className="min-h-11"
              disabled={busy}
              onClick={() => setDiscardOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="min-h-11"
              disabled={pending}
              pending={busy}
              pendingLabel="Discarding…"
              onClick={() => void discard()}
            >
              <RotateCcw />
              Discard draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
