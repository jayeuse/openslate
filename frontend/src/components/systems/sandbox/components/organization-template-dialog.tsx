"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import type { SandboxCommandResult } from "../state/commands";
import {
  SANDBOX_ORGANIZATION_TEMPLATES,
  sandboxTemplateStats,
  type SandboxOrganizationTemplate,
} from "../domain/templates";

type OrganizationTemplateDialogProps = {
  open: boolean;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onApply: (
    template: SandboxOrganizationTemplate,
  ) => Promise<SandboxCommandResult<unknown>>;
};

export function OrganizationTemplateDialog({
  open,
  pending,
  onOpenChange,
  onApply,
}: OrganizationTemplateDialogProps) {
  const [selectedTemplateId, setSelectedTemplateId] = useState(
    SANDBOX_ORGANIZATION_TEMPLATES[0]?.id ?? "",
  );
  const [error, setError] = useState("");
  const [applying, setApplying] = useState(false);
  const selectedTemplate = SANDBOX_ORGANIZATION_TEMPLATES.find(
    (template) => template.id === selectedTemplateId,
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && pending) return;
        if (!nextOpen) setError("");
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        aria-busy={applying || undefined}
        className="max-h-[90dvh] max-w-6xl overflow-y-auto max-xl:[&_button]:min-h-11 max-xl:[&_button]:min-w-11"
      >
        <DialogTitle>Organization templates</DialogTitle>
        <DialogDescription>
          Start from a detailed operating baseline. Nothing is applied until you
          select a template and confirm the replacement.
        </DialogDescription>
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.7fr)]">
          <div className="grid gap-3 sm:grid-cols-2">
            {SANDBOX_ORGANIZATION_TEMPLATES.map((template) => {
              const stats = sandboxTemplateStats(template);
              const selected = template.id === selectedTemplateId;
              return (
                <button
                  key={template.id}
                  type="button"
                  aria-label={`Select ${template.name}`}
                  aria-pressed={selected}
                  className="focus-visible:outline-ring rounded-xl text-left outline-none focus-visible:outline-2"
                  disabled={pending}
                  onClick={() => {
                    setSelectedTemplateId(template.id);
                    setError("");
                  }}
                >
                  <Card
                    className={
                      selected
                        ? "border-primary ring-primary h-full ring-1"
                        : "hover:border-foreground/30 h-full"
                    }
                  >
                    <CardHeader>
                      <p className="text-muted-foreground text-xs font-medium uppercase">
                        {template.category}
                      </p>
                      <CardTitle>{template.name}</CardTitle>
                      <CardDescription>{template.description}</CardDescription>
                    </CardHeader>
                    <CardContent className="text-muted-foreground text-xs tabular-nums">
                      {stats.departments} departments · {stats.modules} modules
                      · {stats.fields} fields
                    </CardContent>
                  </Card>
                </button>
              );
            })}
          </div>
          {selectedTemplate ? (
            <Card className="h-fit lg:sticky lg:top-0">
              <CardHeader>
                <CardTitle>{selectedTemplate.name}</CardTitle>
                <CardDescription>
                  Complete organization baseline
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 text-sm">
                {(() => {
                  const stats = sandboxTemplateStats(selectedTemplate);
                  return (
                    <p className="text-muted-foreground tabular-nums">
                      {stats.departments} departments · {stats.modules} modules
                      · {stats.fields} fields · {stats.relationships}{" "}
                      relationships · {stats.triggers} triggers
                    </p>
                  );
                })()}
                <section>
                  <h3 className="font-medium">Recommended for</h3>
                  <ul className="text-muted-foreground mt-2 list-inside list-disc space-y-1">
                    {selectedTemplate.recommendedFor.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </section>
                <section>
                  <h3 className="font-medium">Included workflow coverage</h3>
                  <ul className="text-muted-foreground mt-2 list-inside list-disc space-y-1">
                    {selectedTemplate.highlights.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </section>
                <Alert variant="warning">
                  Applying this template replaces the current shared Sandbox
                  draft. The import is recorded in version history.
                </Alert>
              </CardContent>
            </Card>
          ) : null}
        </div>
        {error ? (
          <Alert role="alert" variant="destructive">
            {error}
          </Alert>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={pending || applying || !selectedTemplate}
            onClick={async () => {
              if (!selectedTemplate) return;
              setError("");
              setApplying(true);
              const result = await onApply(selectedTemplate);
              setApplying(false);
              if (!result.ok) {
                setError(result.error);
                return;
              }
              onOpenChange(false);
            }}
          >
            {applying
              ? "Applying…"
              : `Use ${selectedTemplate?.name ?? "template"}`}
          </Button>
        </DialogFooter>
        {applying ? (
          <p role="status" aria-live="polite" className="sr-only">
            Applying template
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
