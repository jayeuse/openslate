"use client";

import type { Route } from "next";
import { ArrowRight, Phone } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { personInitials } from "@/components/person-avatar";
import { GuardedWorkspaceLink } from "@/components/workspace-navigation-guard";
import {
  formatWorkspaceDate,
  formatWorkspaceDateTime,
} from "@/lib/date-time-display";
import type { IdentityEditor } from "../hooks/use-identity-editor";
import type { SettingsRegion } from "../hooks/use-settings-region";

/**
 * The Preview pane (PD13): only what the settings cannot show. How others
 * see you follows the Identity draft as you type, without a card read; Your
 * formats renders today, now and an amount in your formats; and a small
 * sample shows the appearance.
 */
export function SettingsPreview({
  editor,
  region,
}: {
  editor: IdentityEditor;
  region: SettingsRegion;
}) {
  const { values, self } = editor;
  const now = new Date();
  const display = region.display;
  return (
    <aside
      aria-label="Preview"
      className="bg-card border-border min-w-0 rounded-[var(--radius)] border text-sm xl:min-h-0 xl:overflow-y-auto xl:overscroll-contain"
    >
      <div className="border-border border-b px-4 py-3">
        <h2 data-slot="section-title" className="text-base font-semibold">
          Preview
        </h2>
      </div>
      <section
        aria-labelledby="preview-person"
        className="border-border border-b px-4 pt-3.5 pb-4"
      >
        <h3
          id="preview-person"
          className="text-muted-foreground mb-2.5 text-[0.8125rem] font-semibold"
        >
          How others see you
        </h3>
        <div className="border-border bg-background grid grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1 rounded-[var(--radius)] border p-3">
          <Avatar aria-hidden="true" className="row-span-2 size-10">
            {editor.photo ? (
              <AvatarImage src={editor.photo.url} alt="" />
            ) : null}
            <AvatarFallback className="text-muted-foreground text-sm font-semibold">
              {personInitials(values.display_name)}
            </AvatarFallback>
          </Avatar>
          <span className="truncate font-semibold">
            {self ? values.display_name || "Unnamed" : ""}
          </span>
          <span className="text-muted-foreground truncate text-[0.8125rem]">
            {values.job_title}
          </span>
          {values.phone ? (
            <span className="border-border col-span-2 mt-2 flex items-center gap-2 border-t pt-2 text-[0.8125rem] tabular-nums">
              <Phone
                aria-hidden="true"
                className="text-muted-foreground size-3.5"
              />
              {values.phone}
            </span>
          ) : null}
        </div>
        <GuardedWorkspaceLink
          href={"/profile" as Route}
          className="text-action-text mt-2 inline-flex min-h-11 items-center gap-1.5 text-sm font-medium underline-offset-4 hover:underline xl:min-h-8"
        >
          View your profile
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </GuardedWorkspaceLink>
      </section>
      <section
        aria-labelledby="preview-formats"
        className="border-border border-b px-4 pt-3.5 pb-4"
      >
        <h3
          id="preview-formats"
          className="text-muted-foreground mb-1.5 text-[0.8125rem] font-semibold"
        >
          Your formats
        </h3>
        {display ? (
          <dl className="divide-border divide-y text-sm">
            <FormatRow label="Today">
              {formatWorkspaceDate(now.toISOString(), display, {
                weekday: "short",
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
            </FormatRow>
            <FormatRow label="Now">
              {formatWorkspaceDateTime(now.toISOString(), display, {
                hour: "numeric",
                minute: "2-digit",
              })}
            </FormatRow>
            {region.currency ? (
              <FormatRow label="Amount">
                {new Intl.NumberFormat(display.locale, {
                  style: "currency",
                  currency: region.currency,
                }).format(12500)}
              </FormatRow>
            ) : null}
          </dl>
        ) : (
          <span className="text-muted-foreground text-sm">
            {region.state === "loading" ? "Loading formats…" : "Unavailable"}
          </span>
        )}
      </section>
      <section aria-label="Appearance preview" className="px-4 pt-3.5 pb-4">
        <h3 className="text-muted-foreground mb-2.5 text-[0.8125rem] font-semibold">
          Appearance
        </h3>
        <div className="border-border bg-background grid gap-2 rounded-[var(--radius)] border p-3">
          <div className="flex items-center gap-2">
            <b className="font-semibold">Equipment request</b>
            <Badge variant="secondary">Open</Badge>
          </div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[0.8125rem]">
            <dt className="text-muted-foreground">Reference</dt>
            <dd className="tabular-nums">REQ-1042</dd>
            <dt className="text-muted-foreground">Due</dt>
            <dd className="tabular-nums">
              {display
                ? formatWorkspaceDate("2026-10-30", display)
                : "Oct 30, 2026"}
            </dd>
          </dl>
          {/* A sample of the primary button, not a control. */}
          <span
            aria-hidden="true"
            className="bg-primary text-primary-foreground inline-flex h-8 w-fit items-center rounded-[var(--radius)] px-3 text-sm font-semibold"
          >
            Approve
          </span>
        </div>
      </section>
    </aside>
  );
}

function FormatRow({ label, children }: { label: string; children: string }) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-4 py-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right tabular-nums">{children}</dd>
    </div>
  );
}
