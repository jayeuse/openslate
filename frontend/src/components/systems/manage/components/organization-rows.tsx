"use client";

import { useId, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Label-left rows for Manage › Organization (MD4): from 768px a 160px muted
 * label column and the value on the right in a 40px row, so the panel reads
 * as facts until someone edits it. Phones stack the label above. The editor
 * and the reader share the grid, so a value sits in the same place in both.
 */
const rowGrid =
  "grid min-w-0 gap-1.5 md:grid-cols-[10rem_minmax(0,1fr)] md:gap-x-4";
const labelText = "text-sm md:text-muted-foreground";

/** One named group of rows (Identity, Region, Look), divided by a rule. */
export function SettingsGroup({
  title,
  hint,
  children,
  className,
}: {
  title: string;
  /** One short line beside the title; the group's only helper text. */
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  const titleId = useId();
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className={cn("border-border min-w-0 border-b py-5", className)}
    >
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h2 id={titleId} className="text-base font-semibold">
          {title}
        </h2>
        {hint ? <p className="text-muted-foreground text-sm">{hint}</p> : null}
      </div>
      {children}
    </div>
  );
}

/**
 * An editable row: a real `<label for>` and the controls beside it. The label
 * sits level with the first control line (44px below 1280px, 32px from it),
 * so a note or an error under the control never moves it.
 */
export function SettingsRow({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className={cn(rowGrid, "py-1 md:items-start")}>
      <label
        htmlFor={htmlFor}
        className={cn(
          labelText,
          "md:flex md:min-h-11 md:items-center xl:min-h-8",
        )}
      >
        {label}
      </label>
      <div className="grid min-w-0 gap-1.5">{children}</div>
    </div>
  );
}

export function RowNote({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="text-muted-foreground text-xs">
      {children}
    </p>
  );
}

export function RowError({ id, children }: { id: string; children?: string }) {
  if (!children) return null;
  return (
    <p id={id} role="alert" className="text-destructive text-sm">
      {children}
    </p>
  );
}

/** The reader's rows: the same grid as text (The Read-Only Is Text Rule). */
export function ReaderRows({ children }: { children: ReactNode }) {
  return <dl className="grid min-w-0 gap-3 md:gap-1">{children}</dl>;
}

export function ReaderRow({
  label,
  children,
}: {
  label: string;
  /** Empty reads "Not set". */
  children?: ReactNode;
}) {
  const empty =
    children === undefined ||
    children === null ||
    (typeof children === "string" && !children.trim());
  return (
    <div className={cn(rowGrid, "gap-0.5 md:min-h-9 md:items-center")}>
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd
        className={cn(
          "min-w-0 text-sm break-words whitespace-pre-line",
          empty && "text-muted-foreground",
        )}
      >
        {empty ? "Not set" : children}
      </dd>
    </div>
  );
}
