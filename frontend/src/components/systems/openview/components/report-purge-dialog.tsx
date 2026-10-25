"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DialogFrameFooter,
  DialogFrameHeader,
  dialogFrameContentClass,
} from "@/components/ui/dialog-frame";
import { Input } from "@/components/ui/input";
import {
  lifecycleErrorMessage,
  type LifecyclePurgePreview,
} from "@/lib/lifecycle";
import { cn } from "@/lib/utils";
import { LifecyclePurgeReview } from "../../shared/lifecycle-purge-review";
import {
  subscribeWorkspaceLifecycleSettings,
  workspaceCalendarQueryOptions,
  workspaceLifecycleQueryOptions,
} from "../../manage/adapters/workspace-api";
import {
  previewReportPurge,
  purgeReport,
  type OpenViewReport,
} from "../adapters/reports-api";

/**
 * Whether permanent delete is on for this organization (the existing purge
 * rules): only an administrator sees it, and only for an archived report.
 */
export function useReportPurgeEnabled(
  isAdmin: boolean,
  archived: boolean,
): boolean {
  const queryClient = useQueryClient();
  const enabled = isAdmin && archived;
  const lifecycle = useQuery({
    ...workspaceLifecycleQueryOptions(),
    enabled,
  });
  useEffect(() => {
    if (enabled) return subscribeWorkspaceLifecycleSettings(queryClient);
  }, [enabled, queryClient]);
  return enabled && lifecycle.isSuccess && lifecycle.data.purge_enabled;
}

/**
 * Delete forever (DC3, the existing purge rules): a fresh review of what goes,
 * then the exact report name and the administrator's password.
 */
export function ReportPurgeDialog({
  report,
  onClose,
  onPurged,
}: {
  report: OpenViewReport;
  onClose: () => void;
  onPurged: () => void;
}) {
  const region = useQuery(workspaceCalendarQueryOptions());
  const [preview, setPreview] = useState<LifecyclePurgePreview | null>(null);
  const [reviewing, setReviewing] = useState(true);
  const [pending, setPending] = useState(false);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const request = useRef(0);

  async function review(): Promise<void> {
    const sequence = ++request.current;
    setReviewing(true);
    setPreview(null);
    setName("");
    setPassword("");
    setError("");
    try {
      const next = await previewReportPurge(report.id);
      if (sequence === request.current) setPreview(next);
    } catch (failure) {
      if (sequence === request.current)
        setError(
          lifecycleErrorMessage(
            failure,
            "The report review could not be prepared. Request a new review.",
          ),
        );
    } finally {
      if (sequence === request.current) setReviewing(false);
    }
  }

  useEffect(() => {
    void review();
    return () => {
      request.current += 1;
    };
    // One review per opened dialog; Review again asks for a fresh one.
  }, [report.id]);

  async function confirm(): Promise<void> {
    if (
      !preview ||
      pending ||
      preview.impact.blockers.length ||
      name !== preview.confirmation_name ||
      !password
    )
      return;
    const sequence = ++request.current;
    setPending(true);
    setError("");
    try {
      await purgeReport(report.id, {
        token: preview.token,
        confirmationName: name,
        password,
      });
      if (sequence === request.current) onPurged();
    } catch (failure) {
      if (sequence !== request.current) return;
      setError(
        lifecycleErrorMessage(
          failure,
          "The report was not deleted. Request a new review.",
        ),
      );
      setPreview(null);
      setName("");
    } finally {
      setPassword("");
      setPending(false);
    }
  }

  const busy = pending || reviewing;
  return (
    <Dialog
      open
      dismissible={!busy}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className={cn(dialogFrameContentClass, "max-w-xl")}>
        <DialogFrameHeader
          title={<DialogTitle>Delete report forever?</DialogTitle>}
          description={
            <DialogDescription>
              The archived report and its copies go for good.
            </DialogDescription>
          }
          closeLabel="Close without deleting"
          closeDisabled={pending}
          onClose={onClose}
        />
        {reviewing ? <p role="status">Preparing review…</p> : null}
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        {preview ? (
          <form
            id="report-purge-form"
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void confirm();
            }}
          >
            <LifecyclePurgeReview preview={preview} region={region.data} />
            {preview.impact.blockers.length === 0 ? (
              <>
                <p className="text-sm break-words">
                  Report name: <code>{preview.confirmation_name}</code>
                </p>
                <label className="flex flex-col gap-2 text-sm">
                  Type the report name
                  <Input
                    autoComplete="off"
                    value={name}
                    disabled={pending}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-2 text-sm">
                  Administrator password
                  <Input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    disabled={pending}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </label>
              </>
            ) : null}
          </form>
        ) : null}
        <DialogFrameFooter>
          <DialogFooter className="mt-0">
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={pending}
              onClick={onClose}
            >
              Cancel
            </Button>
            {preview && preview.impact.blockers.length === 0 ? (
              <Button
                type="submit"
                form="report-purge-form"
                variant="destructive"
                className="min-h-11"
                disabled={
                  pending || name !== preview.confirmation_name || !password
                }
              >
                {pending ? "Deleting…" : "Delete forever"}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={busy}
                onClick={() => void review()}
              >
                Review again
              </Button>
            )}
          </DialogFooter>
        </DialogFrameFooter>
      </DialogContent>
    </Dialog>
  );
}
