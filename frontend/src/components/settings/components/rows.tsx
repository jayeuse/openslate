"use client";

import { useId, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Label-left rows for Account settings, after Manage › Organization (MD4):
 * from 768px a muted label column (128px, 160px from 1440px) and the value on
 * the right, level with the first control line (44px below 1280px, 32px from
 * it). Phones stack the label above.
 */
const rowGrid =
  "grid min-w-0 gap-1.5 py-1 md:grid-cols-[8rem_minmax(0,1fr)] md:items-start md:gap-x-4 min-[1440px]:grid-cols-[10rem_minmax(0,1fr)]";
const labelText =
  "text-sm md:text-muted-foreground md:flex md:min-h-11 md:items-center xl:min-h-8";

/** One named group (Identity, Sign-in, Appearance, Regional) with its anchor. */
export function SettingsSection({
  id,
  title,
  end,
  children,
}: {
  /** The anchor (`/settings#look`). */
  id: string;
  title: string;
  /** Beside the title: the shared preference status. */
  end?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      className="border-border min-w-0 scroll-mt-2 border-b py-5 last:border-b-0"
    >
      <div className="mb-3 flex min-h-6 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        {/* Focusable by script: a closed dialog returns focus here when its
            opener cannot take it (focusReturn). */}
        <h2
          id={titleId}
          tabIndex={-1}
          className="text-base font-semibold outline-none"
        >
          {title}
        </h2>
        {end}
      </div>
      <div className="grid min-w-0 gap-1.5">{children}</div>
    </section>
  );
}

/**
 * Where a closed dialog returns focus: its opener while it can take focus,
 * otherwise the heading of the group it belongs to, never the page body.
 */
export function focusReturn(
  opener: HTMLButtonElement | null,
  sectionId: string,
): () => HTMLElement | false {
  return () =>
    opener?.isConnected && !opener.disabled
      ? opener
      : (document.querySelector<HTMLElement>(`#${sectionId} h2`) ?? false);
}

/**
 * A row. With `htmlFor` the label is a real `<label for>`; without it (a
 * fact with an action, a group of controls) the label is text that names the
 * row's group.
 */
export function SettingsRow({
  label,
  htmlFor,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  const labelId = useId();
  return (
    <div
      className={cn(rowGrid, className)}
      role={htmlFor ? undefined : "group"}
      aria-labelledby={htmlFor ? undefined : labelId}
    >
      {htmlFor ? (
        <label htmlFor={htmlFor} className={labelText}>
          {label}
        </label>
      ) : (
        <span id={labelId} className={labelText}>
          {label}
        </span>
      )}
      <div className="grid min-w-0 gap-1.5">{children}</div>
    </div>
  );
}

/** A plain value with a quiet action at the right (Email, Password, Two-step). */
export function FactValue({
  children,
  action,
}: {
  children: ReactNode;
  action: ReactNode;
}) {
  return (
    <div className="flex min-h-11 min-w-0 flex-wrap items-center gap-x-3 gap-y-1 xl:min-h-8">
      <span className="min-w-0 flex-1 break-words">{children}</span>
      {action}
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
