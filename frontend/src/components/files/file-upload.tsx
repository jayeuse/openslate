"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import {
  DOCUMENT_ACCEPT,
  LOGO_ACCEPT,
  fileSelectionError,
  reserveFile,
  uploadFile,
  type FilePurpose,
  type ManagedFile,
} from "@/lib/files";
export function FileUpload({
  purpose,
  recordId,
  onChange,
  disabled = false,
  onBusyChange,
}: {
  purpose: FilePurpose;
  recordId?: string;
  onChange: (file: ManagedFile) => void;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [selected, setSelected] = useState<File | null>(null);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const logo = purpose === "workspace_logo";
  async function submit() {
    if (!selected || busy) return;
    const reason = fileSelectionError(selected, logo);
    if (reason) {
      setError(reason);
      return;
    }
    setBusy(true);
    onBusyChange?.(true);
    setError("");
    let reserved = false;
    try {
      setStage("Reserving file…");
      const item = await reserveFile(selected, purpose, recordId);
      reserved = true;
      onChange(item);
      setStage("Uploading file…");
      const uploaded = await uploadFile(item.id, selected);
      onChange(uploaded);
      setStage("Upload complete. Scanning continues in the background.");
    } catch (reason) {
      setError(
        `${reason instanceof Error ? reason.message : "File operation failed."} ${reserved ? "The reserved file is retained. Check its status before taking another action." : "The request was not retried. Check the file list before starting another upload."}`,
      );
      setStage("");
    } finally {
      setBusy(false);
      onBusyChange?.(false);
      setSelected(null);
      setInputKey((value) => value + 1);
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <Field>
        <FieldLabel htmlFor={`upload-${purpose}`}>
          {logo ? "Choose logo" : "Choose document"}
        </FieldLabel>
        <Input
          key={inputKey}
          id={`upload-${purpose}`}
          type="file"
          accept={logo ? LOGO_ACCEPT : DOCUMENT_ACCEPT}
          disabled={disabled || busy}
          onChange={(event) => {
            setSelected(event.target.files?.[0] ?? null);
            setError("");
          }}
        />
        <FieldDescription>
          {logo
            ? "JPEG or PNG, up to 2 MiB."
            : "PDF, JPEG, PNG, DOCX, XLSX or PPTX, up to 25 MiB."}{" "}
          Files must pass validation and scanning before use.
        </FieldDescription>
      </Field>
      <Button
        className="self-start"
        disabled={!selected || disabled || busy}
        onClick={() => void submit()}
      >
        {busy ? "Processing…" : "Upload and scan"}
      </Button>
      {stage && (
        <p role="status" className="text-muted-foreground text-sm">
          {stage}
        </p>
      )}
      {error && <Alert variant="destructive">{error}</Alert>}
    </div>
  );
}
