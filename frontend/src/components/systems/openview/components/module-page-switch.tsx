"use client";

import Link from "next/link";
import type { Route } from "next";

// The Tabs skin hooks (`tabs-list`, `tabs-trigger` with `data-active`, and
// `tabs-indicator`), so every look styles the switch as its tabs. The classes
// are the Tabs primitive's; the primitive itself is not imported, because
// these are links (each view has its own address), not a tab panel.
const list =
  "text-muted-foreground relative flex w-fit items-center gap-1 rounded-[var(--radius)] bg-[var(--surface-sunken)] p-1 shadow-[inset_0_0_0_1px_var(--rule)] max-sm:w-full";
const trigger =
  "focus-visible:outline-ring data-active:text-action-text relative isolate inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-sm px-3 text-sm font-medium whitespace-nowrap outline-none focus-visible:outline-2 data-active:font-semibold md:flex-none xl:min-h-7";
const indicator =
  "absolute inset-0 -z-10 rounded-[calc(var(--radius)*0.75)] bg-[var(--surface-raised)] shadow-[var(--lift),inset_0_0_0_1px_var(--rule)]";

/**
 * The module page's two views, Records and Reports, with their counts
 * (DC1). They are links: each view has its own address. On a phone they sit
 * under the title (DC12).
 */
export function ModulePageSwitch({
  moduleName,
  reports,
  recordsHref,
  reportsHref,
  recordCount,
  reportCount,
}: {
  moduleName: string;
  reports: boolean;
  recordsHref: string;
  reportsHref: string;
  recordCount: number | null;
  reportCount: number | null;
}) {
  const count = (value: number | null) =>
    value === null ? null : (
      <span className="font-normal tabular-nums">{value}</span>
    );
  const tab = (
    label: string,
    href: string,
    value: number | null,
    current: boolean,
  ) => (
    <Link
      href={href as Route}
      scroll={false}
      aria-current={current ? "page" : undefined}
      data-slot="tabs-trigger"
      data-active={current ? "" : undefined}
      className={trigger}
    >
      {current ? (
        <span
          aria-hidden="true"
          data-slot="tabs-indicator"
          className={indicator}
        />
      ) : null}
      {label} {count(value)}
    </Link>
  );
  return (
    <nav
      aria-label={`${moduleName} page`}
      data-slot="tabs-list"
      className={list}
    >
      {tab("Records", recordsHref, recordCount, !reports)}
      {tab("Reports", reportsHref, reportCount, reports)}
    </nav>
  );
}
