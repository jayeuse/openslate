"use client";

import Link from "next/link";
import type { Route } from "next";
import { cn } from "@/lib/utils";

const item =
  "text-muted-foreground hover:text-foreground focus-visible:outline-ring inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md px-3 text-sm whitespace-nowrap focus-visible:outline-2 aria-[current=page]:bg-[var(--surface-raised)] aria-[current=page]:font-semibold aria-[current=page]:text-action-text aria-[current=page]:shadow-[var(--lift),inset_0_0_0_1px_color-mix(in_oklab,var(--ink-muted)_60%,transparent)] md:flex-none xl:min-h-7";

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
  return (
    <nav
      aria-label={`${moduleName} page`}
      className={cn(
        "flex gap-1 rounded-lg bg-[var(--surface-sunken)] p-1 shadow-[inset_0_0_0_1px_var(--rule)] max-sm:w-full",
      )}
    >
      <Link
        href={recordsHref as Route}
        scroll={false}
        aria-current={reports ? undefined : "page"}
        className={item}
      >
        Records {count(recordCount)}
      </Link>
      <Link
        href={reportsHref as Route}
        scroll={false}
        aria-current={reports ? "page" : undefined}
        className={item}
      >
        Reports {count(reportCount)}
      </Link>
    </nav>
  );
}
