"use client";

import Link from "next/link";
import type { Route } from "next";

import {
  linkTabsIndicatorClass as indicator,
  linkTabsListClass as list,
  linkTabsTriggerClass as trigger,
} from "@/components/ui/link-tabs";

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
