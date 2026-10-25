"use client";

import { CalendarClock, ChevronRight, Files, FileText } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type ReportStep = {
  /** "What it lists", "When it runs", "What you keep". */
  label: string;
  value: ReactNode;
  detail: ReactNode;
  /** A manager's Change: the step is then a button. */
  change?: {
    label: string;
    onClick: () => void;
    expanded?: boolean;
    controls?: string;
  };
};

const ICONS = [FileText, CalendarClock, Files] as const;

/**
 * The three steps that explain a report (DC4) and teach an empty module
 * (DC11, dashed): what it lists → when it runs → what you keep, in reading
 * order. A step a manager can change is one button named for its change.
 */
export function ReportSteps({
  steps,
  label,
  dashed = false,
}: {
  steps: readonly [ReportStep, ReportStep, ReportStep];
  label: string;
  dashed?: boolean;
}) {
  return (
    <ol
      aria-label={label}
      className="grid min-w-0 gap-2 md:grid-cols-[minmax(0,1fr)_1.25rem_minmax(0,1fr)_1.25rem_minmax(0,1fr)] md:gap-0"
    >
      {steps.map((step, index) => {
        const Icon = ICONS[index]!;
        const body = (
          <>
            <span
              aria-hidden="true"
              className="bg-card text-muted-foreground row-span-3 grid size-7 place-items-center rounded-md"
            >
              <Icon className="size-4" />
            </span>
            <span className="text-muted-foreground text-xs font-medium">
              {index + 1} · {step.label}
            </span>
            <span className="text-sm font-medium break-words">
              {step.value}
            </span>
            <span className="text-muted-foreground text-xs break-words tabular-nums">
              {step.detail}
              {step.change ? (
                <>
                  {" · "}
                  <span className="text-action-text font-medium">Change</span>
                </>
              ) : null}
            </span>
          </>
        );
        const card = cn(
          "grid h-full w-full min-w-0 grid-cols-[1.75rem_minmax(0,1fr)] content-start gap-x-2.5 gap-y-0.5 rounded-lg border p-3 text-left",
          dashed ? "border-dashed" : "bg-[var(--surface-sunken)]",
        );
        return (
          <Fragment key={step.label}>
            {index > 0 ? (
              <li
                aria-hidden="true"
                className="text-muted-foreground hidden place-items-center md:grid"
              >
                <ChevronRight className="size-3.5" />
              </li>
            ) : null}
            <li className="min-w-0">
              {step.change ? (
                <button
                  type="button"
                  aria-label={step.change.label}
                  aria-expanded={step.change.expanded}
                  aria-controls={step.change.controls}
                  className={cn(
                    card,
                    "focus-visible:outline-ring min-h-11 hover:border-[var(--rule-strong)] focus-visible:outline-2",
                    step.change.expanded &&
                      "bg-[color-mix(in_oklab,var(--ink)_14%,transparent)]",
                  )}
                  onClick={step.change.onClick}
                >
                  {body}
                </button>
              ) : (
                <div className={card}>{body}</div>
              )}
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}
