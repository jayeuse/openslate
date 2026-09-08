"use client";

import type { SandboxState, Stage } from "@/lib/sandbox/model";
import { canEnterStage } from "@/lib/sandbox/rules";
import { cn } from "@/lib/utils";

export interface SandboxWorkflowProps {
  stage: Stage;
  state: SandboxState;
  onStageChange: (stage: Stage) => void;
}
const STAGES: { id: Stage; label: string }[] = [
  { id: "departments", label: "Departments" },
  { id: "modules", label: "Modules" },
  { id: "fields", label: "Fields" },
  { id: "relationships", label: "Relationships" },
  { id: "automation", label: "Automation" },
];
export function SandboxWorkflow({
  stage,
  state,
  onStageChange,
}: SandboxWorkflowProps) {
  return (
    <nav aria-label="Sandbox progress">
      <ol className="flex w-max items-center gap-1 sm:gap-4">
        {STAGES.map(({ id, label }) => {
          const gate = canEnterStage(id, state);
          return (
            <li key={id}>
              <button
                type="button"
                data-testid={`stage-step-${id}`}
                disabled={!gate.ok}
                title={
                  !gate.ok
                    ? gate.reason
                    : id === "automation"
                      ? "Read-only preview"
                      : label
                }
                aria-current={id === stage ? "step" : undefined}
                onClick={() => onStageChange(id)}
                style={{
                  borderBottomColor: id === stage ? "#3b82f6" : "transparent",
                }}
                className={cn(
                  "relative h-12 border-b-2 px-3 text-sm whitespace-nowrap transition-colors focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-40",
                  id === stage
                    ? "border-blue-500 font-medium text-blue-600 dark:text-blue-400"
                    : "text-muted-foreground hover:text-foreground border-transparent",
                )}
              >
                {label}
                {id === "automation" ? (
                  <span className="sr-only"> preview</span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
