"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
import { toast } from "@/components/ui/toast";
import {
  ApiError,
  apiFetch,
  type LifecycleImpact,
  type LifecycleMutationResponse,
  type LifecycleOperation,
  type LifecyclePreviewResponse,
  type LifecycleTargetType,
} from "@/lib/api";

const purgeEnabled = process.env.NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED === "true";

type LifecycleActionProps = {
  targetType: LifecycleTargetType;
  targetId: string;
  targetName: string;
  isClosed: boolean;
  allowClose?: boolean;
  allowReopen?: boolean;
  onComplete: () => void | Promise<void>;
};

type WizardStep = "preview" | "name" | "password";

function operationLabel(operation: LifecycleOperation) {
  return operation === "purge" ? "Purge" : "Close";
}

function targetPath(
  targetType: LifecycleTargetType,
  targetId: string,
  operation: "close" | "purge",
  preview: boolean,
) {
  return `/${targetType}s/${targetId}/${operation}${preview ? "/preview" : ""}`;
}

function impactSummary(impact: LifecycleImpact) {
  const counts = new Map<string, number>();
  for (const row of impact.rows) {
    counts.set(row.entity_type, (counts.get(row.entity_type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([type, count]) => `${count} ${type}`)
    .join(", ");
}

function ImpactReport({
  impact,
  operation,
}: {
  impact: LifecycleImpact;
  operation: "close" | "purge";
}) {
  return (
    <div className="space-y-4" data-testid="lifecycle-impact-report">
      <p className="text-sm">
        This operation affects {impactSummary(impact) || "no rows"}.{" "}
        {operation === "close"
          ? "Closed data remains visible and can be reopened."
          : "Purged operational data cannot be restored; immutable audit snapshots may remain under the configured retention policy."}
      </p>
      {impact.external_impacts.length > 0 && (
        <section aria-labelledby="external-impact-heading">
          <h3 id="external-impact-heading" className="font-medium">
            External relationship impacts
          </h3>
          <ul className="text-muted-foreground mt-2 space-y-1 text-sm">
            {impact.external_impacts.map((external) => (
              <li key={`${external.edge_id}-${external.external_record_id}`}>
                {external.external_department_label ??
                  external.external_department_name}
                /{" "}
                {external.external_module_label ??
                  external.external_module_name}
              </li>
            ))}
          </ul>
        </section>
      )}
      {impact.key_strips.length > 0 && (
        <p className="text-muted-foreground text-sm">
          {impact.key_strips.length} record key value(s) will be removed.
        </p>
      )}
      {impact.blockers.length > 0 && (
        <Alert variant="warning">
          <p className="font-medium">This operation is blocked.</p>
          <ul className="mt-1 list-disc pl-5">
            {impact.blockers.map((blocker) => (
              <li key={`${blocker.code}-${blocker.entity_id}`}>
                {blocker.detail}
              </li>
            ))}
          </ul>
        </Alert>
      )}
    </div>
  );
}

export function LifecycleAction({
  targetType,
  targetId,
  targetName,
  isClosed,
  allowClose = true,
  allowReopen = true,
  onComplete,
}: LifecycleActionProps) {
  const [wizardOperation, setWizardOperation] = useState<"close" | "purge">(
    "close",
  );
  const [open, setOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [step, setStep] = useState<WizardStep>("preview");
  const [preview, setPreview] = useState<LifecyclePreviewResponse | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const loadPreview = useCallback(async () => {
    setPending(true);
    setError("");
    setPreview(null);
    setName("");
    setPassword("");
    try {
      const result = await apiFetch<LifecyclePreviewResponse>(
        targetPath(targetType, targetId, wizardOperation, true),
        { method: "POST" },
      );
      setPreview(result);
      setStep("preview");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Preview unavailable",
      );
    } finally {
      setPending(false);
    }
  }, [targetId, targetType, wizardOperation]);

  useEffect(() => {
    if (open) void loadPreview();
  }, [loadPreview, open]);

  function closeWizard() {
    setOpen(false);
    setPreview(null);
    setName("");
    setPassword("");
    setError("");
  }

  function openWizard(nextOperation: "close" | "purge") {
    setWizardOperation(nextOperation);
    setOpen(true);
  }

  async function execute() {
    if (pending || !preview || name !== preview.confirmation_name || !password)
      return;
    if (new Date(preview.expires_at).getTime() <= Date.now()) {
      await loadPreview();
      return;
    }
    setPending(true);
    setError("");
    try {
      await apiFetch<LifecycleMutationResponse>(
        targetPath(targetType, targetId, wizardOperation, false),
        {
          method: "POST",
          body: JSON.stringify({
            token: preview.token,
            confirmation_name: name,
            password,
          }),
        },
      );
      closeWizard();
      try {
        await onComplete();
      } catch {
        setError(
          "The operation completed, but the updated data could not be loaded. Refresh the page.",
        );
        return;
      }
      toast.add({
        title: `${targetName} ${wizardOperation === "purge" ? "purged" : "closed"}.`,
        type: "success",
      });
    } catch (reason) {
      setPassword("");
      if (
        reason instanceof ApiError &&
        (reason.code === "challenge_expired" ||
          reason.code === "impact_changed")
      ) {
        await loadPreview();
      } else {
        setError(reason instanceof Error ? reason.message : "Operation failed");
      }
    } finally {
      setPending(false);
    }
  }

  async function reopen() {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await apiFetch<LifecycleMutationResponse>(
        `/${targetType}s/${targetId}/reopen`,
        { method: "POST", body: JSON.stringify({ confirmed: true }) },
      );
      setReopenOpen(false);
      try {
        await onComplete();
      } catch {
        setError(
          "Reopening completed, but the updated data could not be loaded. Refresh the page.",
        );
        return;
      }
      toast.add({ title: `${targetName} reopened.`, type: "success" });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not reopen");
    } finally {
      setPending(false);
    }
  }

  const operation = wizardOperation;
  return (
    <>
      {isClosed ? (
        <>
          {allowReopen && (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => setReopenOpen(true)}
            >
              Reopen
            </Button>
          )}
          {purgeEnabled && (
            <Button
              variant="destructive"
              size="sm"
              disabled={pending}
              onClick={() => openWizard("purge")}
            >
              Purge
            </Button>
          )}
        </>
      ) : allowClose ? (
        <Button
          variant="destructive"
          size="sm"
          disabled={pending}
          onClick={() => openWizard("close")}
        >
          Close
        </Button>
      ) : null}
      {error && !open && (
        <span className="text-destructive text-xs">{error}</span>
      )}
      <ConfirmationDialog
        open={reopenOpen}
        onOpenChange={setReopenOpen}
        title={`Reopen ${targetName}?`}
        description={`All closed descendants of this ${targetType} will reopen too.`}
        confirmLabel="Reopen"
        pending={pending}
        onConfirm={reopen}
      />
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && !pending) closeWizard();
        }}
        dismissible={!pending}
      >
        <DialogContent aria-labelledby="lifecycle-dialog-title">
          <div className="flex items-start justify-between gap-4">
            <div>
              <DialogTitle
                id="lifecycle-dialog-title"
                className="text-lg font-semibold"
              >
                {operationLabel(operation)} {targetType}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground mt-1 text-sm">
                {targetName}
              </DialogDescription>
            </div>
            <Badge variant="outline">
              {step === "preview" ? "1" : step === "name" ? "2" : "3"} of 3
            </Badge>
          </div>
          {error && (
            <Alert variant="destructive" className="mt-4">
              {error}
            </Alert>
          )}
          <div className="mt-5">
            {pending && !preview && (
              <p className="text-muted-foreground text-sm">
                Loading impact preview…
              </p>
            )}
            {preview && step === "preview" && (
              <>
                <ImpactReport impact={preview.impact} operation={operation} />
                <p className="text-muted-foreground mt-4 text-xs">
                  Preview expires{" "}
                  {new Date(preview.expires_at).toLocaleString()}.
                </p>
              </>
            )}
            {preview && step === "name" && (
              <div className="space-y-2">
                <Label htmlFor="lifecycle-confirmation-name">
                  Type <strong>{preview.confirmation_name}</strong> to continue
                </Label>
                <Input
                  id="lifecycle-confirmation-name"
                  autoFocus
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
            )}
            {preview && step === "password" && (
              <div className="space-y-2">
                <Label htmlFor="lifecycle-password">Your password</Label>
                <Input
                  id="lifecycle-password"
                  type="password"
                  autoFocus
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <p className="text-muted-foreground text-xs">
                  Password is used once and is never stored.
                </p>
              </div>
            )}
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" disabled={pending} onClick={closeWizard}>
              Cancel
            </Button>
            {preview && step !== "preview" && (
              <Button
                variant="outline"
                disabled={pending}
                onClick={() =>
                  setStep(step === "password" ? "name" : "preview")
                }
              >
                Back
              </Button>
            )}
            {preview && step === "preview" && (
              <Button
                disabled={pending || preview.impact.blockers.length > 0}
                onClick={() => setStep("name")}
              >
                Continue
              </Button>
            )}
            {preview && step === "name" && (
              <Button
                disabled={pending || name !== preview.confirmation_name}
                onClick={() => setStep("password")}
              >
                Continue
              </Button>
            )}
            {preview && step === "password" && (
              <Button
                variant="destructive"
                disabled={pending || !password}
                onClick={() => void execute()}
              >
                {pending
                  ? `${operationLabel(operation)}ing…`
                  : operationLabel(operation)}
              </Button>
            )}
            {preview && step === "preview" && (
              <Button
                variant="ghost"
                onClick={() => void loadPreview()}
                disabled={pending}
              >
                Refresh preview
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
