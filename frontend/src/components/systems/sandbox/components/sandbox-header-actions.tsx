"use client";

import { useRef, useState, type ChangeEvent } from "react";
import {
  Download,
  FileDown,
  MoreHorizontal,
  RotateCcw,
  Save,
  Upload,
} from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  parseSandboxDocument,
  type SandboxDocumentV3,
} from "../domain/document";
import type { SandboxOrganizationTemplate } from "../domain/templates";
import { exportSandboxBundle } from "../state/api";
import type { SandboxCommandResult } from "../state/commands";
import { OrganizationTemplateDialog } from "./organization-template-dialog";

type Props = {
  pending: boolean;
  /** The page owns the template dialog so the empty canvas can open it too. */
  templatesOpen: boolean;
  onTemplatesOpenChange: (open: boolean) => void;
  /** A checkpoint of an empty design would save nothing. */
  canCheckpoint: boolean;
  /** Discard only acts when the draft differs from what was published. */
  canDiscard: boolean;
  onCreateCheckpoint: (
    label: string,
    note: string,
  ) => Promise<SandboxCommandResult<unknown>>;
  onImport: (
    document: SandboxDocumentV3,
  ) => Promise<SandboxCommandResult<unknown>>;
  onApplyTemplate: (
    template: SandboxOrganizationTemplate,
  ) => Promise<SandboxCommandResult<unknown>>;
  onDiscard: () => Promise<SandboxCommandResult<unknown>>;
};

function download(name: string, document: SandboxDocumentV3) {
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
  pending,
  templatesOpen,
  onTemplatesOpenChange,
  canCheckpoint,
  canDiscard,
  onCreateCheckpoint,
  onImport,
  onApplyTemplate,
  onDiscard,
}: Props) {
  const input = useRef<HTMLInputElement | null>(null);
  const [checkpointOpen, setCheckpointOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [staged, setStaged] = useState<SandboxDocumentV3 | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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
    setBusy(true);
    setError("");
    try {
      const bundle = await exportSandboxBundle();
      download(bundle.filename, bundle.document);
    } catch {
      setError("Export could not be completed. Try again.");
    } finally {
      setBusy(false);
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
              variant="outline"
              size="icon"
              className="min-h-11 min-w-11"
              aria-label="More Sandbox actions"
            >
              <MoreHorizontal />
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            className="min-h-11"
            onClick={() => onTemplatesOpenChange(true)}
          >
            Start from a template
          </DropdownMenuItem>
          <DropdownMenuItem
            className="min-h-11"
            disabled={!canCheckpoint}
            onClick={() => setCheckpointOpen(true)}
          >
            Save checkpoint
          </DropdownMenuItem>
          <DropdownMenuItem
            className="min-h-11"
            onClick={() => setImportOpen(true)}
          >
            Import or export
          </DropdownMenuItem>
          <DropdownMenuItem
            className="min-h-11"
            disabled={!canDiscard}
            onClick={() => setDiscardOpen(true)}
          >
            Discard draft changes
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save checkpoint</DialogTitle>
            <DialogDescription>
              Save this draft so you can compare or restore it later.
            </DialogDescription>
          </DialogHeader>
          {error ? <Alert variant="destructive">{error}</Alert> : null}
          <Field>
            <FieldLabel htmlFor="sandbox-checkpoint-label">Name</FieldLabel>
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
          <Button
            className="min-h-11"
            disabled={pending || busy}
            onClick={() => void checkpoint()}
          >
            <Save />
            Save checkpoint
          </Button>
        </DialogContent>
      </Dialog>
      <Dialog
        open={importOpen}
        onOpenChange={(open) => !busy && setImportOpen(open)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import or export</DialogTitle>
            <DialogDescription>
              Export a portable JSON file, or replace this draft with one you
              previously exported.
            </DialogDescription>
          </DialogHeader>
          {error ? <Alert variant="destructive">{error}</Alert> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              className="min-h-11"
              disabled={pending || busy}
              onClick={() => void exportDocument()}
            >
              <Download />
              Export JSON
            </Button>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={pending || busy}
              onClick={() => input.current?.click()}
            >
              <Upload />
              Choose JSON
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
            <div className="grid gap-2">
              <p className="text-sm">
                This file will replace the current draft.
              </p>
              <Button
                className="min-h-11"
                disabled={pending || busy}
                onClick={() => void importDocument()}
              >
                <FileDown />
                Import draft
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog
        open={discardOpen}
        onOpenChange={(open) => !busy && setDiscardOpen(open)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard draft changes?</DialogTitle>
            <DialogDescription>
              A checkpoint is saved first. This restores the latest published
              draft when available; otherwise it starts with an empty draft.
              Live workspace data is never changed here.
            </DialogDescription>
          </DialogHeader>
          {error ? <Alert variant="destructive">{error}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              className="min-h-11"
              disabled={busy}
              onClick={() => setDiscardOpen(false)}
            >
              Keep editing
            </Button>
            <Button
              variant="destructive"
              className="min-h-11"
              disabled={pending || busy}
              onClick={() => void discard()}
            >
              <RotateCcw />
              Discard draft
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
