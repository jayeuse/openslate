"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LifecyclePreviewResponse } from "@/lib/api";
import { workspaceCalendarQueryOptions } from "../../manage/adapters/workspace-api";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { LifecyclePurgeReview } from "@/components/systems/shared/lifecycle-purge-review";
import {
  structuralLifecycleErrorMessage,
  type LifecyclePurgeInput,
  type LifecyclePurgePreview,
} from "@/lib/lifecycle";
import {
  previewSandboxLifecycle,
  type SandboxLifecycleRequest,
} from "../state/lifecycle-api";

type Props = {
  request: SandboxLifecycleRequest | null;
  onCancel: () => void;
  onConfirm: (input?: LifecyclePurgeInput) => Promise<void>;
};

export function SandboxLifecycleDialog({
  request,
  onCancel,
  onConfirm,
}: Props) {
  const [preview, setPreview] = useState<
    LifecyclePreviewResponse | LifecyclePurgePreview | null
  >(null);
  const [confirmation, setConfirmation] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"review" | "command" | null>(null);
  const generation = useRef(0);
  const confirming = useRef(false);
  const id = useId();
  const region = useQuery({
    ...workspaceCalendarQueryOptions(),
    enabled: request?.operation === "purge",
  });

  function clear() {
    setPreview(null);
    setConfirmation("");
    setPassword("");
    setError("");
  }
  async function review(current: number, target: SandboxLifecycleRequest) {
    clear();
    setBusy("review");
    try {
      const result = await previewSandboxLifecycle(target);
      if (generation.current === current) setPreview(result);
    } catch (reason) {
      if (generation.current === current)
        setError(structuralLifecycleErrorMessage(reason, target.operation));
    } finally {
      if (generation.current === current) setBusy(null);
    }
  }
  useEffect(() => {
    const current = ++generation.current;
    confirming.current = false;
    clear();
    setBusy(null);
    if (request && request.operation !== "reopen")
      void review(current, request);
    return () => {
      generation.current += 1;
    };
  }, [request]);

  if (!request) return null;
  const { operation, binding } = request;
  const title = `${operation === "purge" ? "Permanently delete" : operation === "close" ? "Close" : "Reopen"} ${binding.kind}`;
  const recordLinkCount = preview
    ? new Set(
        preview.impact.external_impacts
          .map((impact) => impact.edge_id)
          .filter((id) => id !== null),
      ).size
    : 0;
  const blocked = Boolean(preview?.impact.blockers.length);
  const cancel = () => {
    if (confirming.current) return;
    generation.current += 1;
    clear();
    setBusy(null);
    onCancel();
  };
  async function confirm() {
    if (!request || confirming.current || busy || blocked) return;
    if (
      request.operation !== "reopen" &&
      (!preview || confirmation !== preview.confirmation_name || !password)
    )
      return;
    confirming.current = true;
    setBusy("command");
    setError("");
    const current = generation.current;
    try {
      await onConfirm(
        request.operation === "reopen"
          ? undefined
          : {
              token: preview!.token,
              confirmationName: preview!.confirmation_name,
              password,
            },
      );
      if (generation.current === current) {
        clear();
      }
    } catch (reason) {
      if (generation.current === current) {
        clear();
        setError(structuralLifecycleErrorMessage(reason, request.operation));
      }
    } finally {
      if (generation.current === current) {
        setPassword("");
        setBusy(null);
        confirming.current = false;
      }
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
    >
      <DialogContent className="flex flex-col overflow-hidden p-0 sm:max-w-xl">
        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-5">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {operation === "purge"
                ? `Permanent deletion removes this live ${binding.kind} and its corresponding current design structure${binding.kind === "department" ? ", including draft modules and fields" : ""}.`
                : operation === "close"
                  ? "Review the effect on the live workspace before closing this item."
                  : "Reopen this item and the items included by its original close operation."}
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <Alert role="alert" variant="destructive">
              {error}
            </Alert>
          ) : null}
          {busy === "review" ? <p role="status">Preparing review…</p> : null}
          {preview &&
          operation === "purge" &&
          "last_successful_backup_at" in preview ? (
            <LifecyclePurgeReview preview={preview} region={region.data} />
          ) : null}
          {preview && operation === "close" ? (
            <div className="space-y-3 text-sm">
              <p role="status">
                This close affects {preview.impact.rows.length} items. Existing
                records are kept.
              </p>
              {binding.kind === "relationship" ? (
                <p>
                  {recordLinkCount} record link
                  {recordLinkCount === 1 ? "" : "s"} will be closed. Existing
                  records are kept.
                </p>
              ) : null}
              {binding.kind === "field" ? (
                <p>
                  Closing this field removes its linked fields from the current
                  design.
                </p>
              ) : null}
              {blocked ? (
                <Alert role="alert" variant="warning">
                  <p>Closing is blocked</p>
                  <ul className="list-disc space-y-2 pl-5">
                    {preview.impact.blockers.map((blocker) => (
                      <li key={`${blocker.code}-${blocker.entity_id}`}>
                        {blocker.detail}
                      </li>
                    ))}
                  </ul>
                </Alert>
              ) : null}
            </div>
          ) : null}
          {preview ? (
            <>
              <p className="text-sm">
                Confirm the live name:{" "}
                <strong className="break-words">
                  {preview.confirmation_name}
                </strong>
                .
              </p>
              <Field>
                <FieldLabel htmlFor={`${id}-name`}>
                  Type the {binding.kind} name
                </FieldLabel>
                <Input
                  id={`${id}-name`}
                  value={confirmation}
                  disabled={busy !== null || blocked}
                  onChange={(event) => setConfirmation(event.target.value)}
                  autoComplete="off"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-password`}>
                  Administrator password
                </FieldLabel>
                <Input
                  id={`${id}-password`}
                  type="password"
                  value={password}
                  disabled={busy !== null || blocked}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                />
              </Field>
            </>
          ) : null}
        </div>
        <div className="border-border flex flex-wrap justify-end gap-2 border-t p-5">
          <Button
            variant="outline"
            disabled={busy === "command"}
            onClick={cancel}
          >
            Cancel
          </Button>
          {operation !== "reopen" && !preview && busy === null ? (
            <Button
              variant="outline"
              onClick={() => void review(++generation.current, request)}
            >
              Review again
            </Button>
          ) : null}
          <Button
            variant={operation === "purge" ? "destructive" : "default"}
            disabled={
              busy !== null ||
              blocked ||
              (operation !== "reopen" &&
                (!preview ||
                  confirmation !== preview.confirmation_name ||
                  !password))
            }
            onClick={() => void confirm()}
          >
            {busy === "command"
              ? "Confirming…"
              : operation === "purge"
                ? "Permanently delete"
                : title}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
