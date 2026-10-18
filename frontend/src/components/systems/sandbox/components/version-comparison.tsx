"use client";

import {
  ArrowDownRight,
  ArrowUpRight,
  Building2,
  Boxes,
  Check,
  ChevronDown,
  FileText,
  GitBranch,
  Layers,
  Minus,
  Plus,
  SlidersHorizontal,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  Table,
  TableCaption,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { projectSandboxDocument } from "../domain/document-bridge";
import type { SandboxVersionDetail } from "../state/api";

const areas: { prefix: string; label: string; icon: LucideIcon }[] = [
  { prefix: "Department", label: "Departments", icon: Building2 },
  { prefix: "Module", label: "Modules", icon: Boxes },
  { prefix: "Field", label: "Fields", icon: FileText },
  { prefix: "Relationship", label: "Relationships", icon: GitBranch },
  { prefix: "Trigger", label: "Triggers", icon: Zap },
  { prefix: "Scenario", label: "Scenarios", icon: Layers },
];

function structureCounts(version: SandboxVersionDetail) {
  const design = projectSandboxDocument(version.document);
  return [
    design.departments.length,
    design.modules.length,
    design.modules.reduce((total, item) => total + item.fields.length, 0),
    design.relationships.length,
    design.rules.length,
  ];
}

export function VersionComparison({
  first,
  second,
  changes,
}: {
  first: SandboxVersionDetail;
  second: SandboxVersionDetail;
  changes: readonly string[];
}) {
  const before = structureCounts(first);
  const after = structureCounts(second);
  const changedAreas = before.filter(
    (value, index) => value !== after[index],
  ).length;
  const groups = [
    ...areas.map((area) => ({
      ...area,
      entries: changes.filter((change) => change.startsWith(area.prefix + " ")),
    })),
    {
      prefix: "Other",
      label: "Other changes",
      icon: SlidersHorizontal,
      entries: changes.filter(
        (change) => !areas.some((area) => change.startsWith(area.prefix + " ")),
      ),
    },
  ].filter((group) => group.entries.length);
  return (
    <div className="border-border mt-6 border-t pt-5">
      <div className="grid grid-cols-2 gap-5">
        {[
          { version: first, marker: "A", label: "Before" },
          { version: second, marker: "B", label: "After" },
        ].map(({ version, marker, label }) => (
          <div key={marker} className="min-w-0">
            <p className="text-muted-foreground flex items-center gap-2 text-xs">
              <span className="border-action-text/30 bg-action-tint text-action-text flex size-6 shrink-0 items-center justify-center rounded-md border font-semibold">
                {marker}
              </span>
              {label} · v{version.sequence}
            </p>
            <h3 className="mt-2 text-sm font-semibold break-words">
              {version.label}
            </h3>
          </div>
        ))}
      </div>
      <div className="border-border mt-5 overflow-hidden rounded-xl border">
        <Table className="w-full table-fixed text-left text-sm [&_td]:whitespace-normal [&_th]:whitespace-normal">
          <TableCaption className="sr-only">
            Structure counts for the saved comparison
          </TableCaption>
          <colgroup>
            <col className="w-[38%]" />
            <col className="w-[15%]" />
            <col className="w-[15%]" />
            <col className="w-[32%]" />
          </colgroup>
          <TableHeader className="bg-muted/60 text-muted-foreground text-xs">
            <TableRow>
              <TableHead scope="col" className="px-3 py-3 font-medium">
                Structure
              </TableHead>
              <TableHead
                scope="col"
                aria-label={`Before: ${first.label}`}
                className="px-1 py-3 text-center font-medium"
              >
                Before
              </TableHead>
              <TableHead
                scope="col"
                aria-label={`After: ${second.label}`}
                className="px-1 py-3 text-center font-medium"
              >
                After
              </TableHead>
              <TableHead
                scope="col"
                className="px-2 py-3 text-right font-medium"
              >
                Difference
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {areas.slice(0, 5).map(({ label, icon: Icon }, index) => {
              const delta = after[index] - before[index];
              const Direction =
                delta > 0 ? ArrowUpRight : delta < 0 ? ArrowDownRight : Minus;
              const tone =
                delta > 0
                  ? "text-success"
                  : delta < 0
                    ? "text-destructive"
                    : "text-muted-foreground";
              return (
                <TableRow
                  key={label}
                  className={`border-border border-t ${delta > 0 ? "bg-success/5" : delta < 0 ? "bg-destructive/5" : "bg-card/30"}`}
                >
                  <TableHead
                    scope="row"
                    className="px-3 py-4 font-medium break-words"
                  >
                    <span className="flex items-center gap-2">
                      <Icon
                        aria-hidden="true"
                        className="text-muted-foreground hidden size-4 shrink-0 2xl:block"
                      />
                      {label}
                    </span>
                  </TableHead>
                  <TableCell className="text-muted-foreground px-1 py-4 text-center tabular-nums">
                    {before[index]}
                  </TableCell>
                  <TableCell className="px-1 py-4 text-center text-base font-semibold tabular-nums">
                    {after[index]}
                  </TableCell>
                  <TableCell className={`px-2 py-4 text-right text-xs ${tone}`}>
                    <span className="inline-flex max-w-full flex-wrap items-center justify-end gap-1">
                      <Direction
                        aria-hidden="true"
                        className="size-3.5 shrink-0"
                      />
                      <span className="break-words tabular-nums">
                        {delta === 0
                          ? "No change"
                          : `${Math.abs(delta)} ${delta > 0 ? "more" : "fewer"}`}
                      </span>
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
        {changedAreas
          ? `${changedAreas} of 5 structure totals differ.`
          : "Structure totals are unchanged."}{" "}
        Counts can stay the same when names or settings change.
      </p>

      <section aria-label="Change details" className="mt-7">
        <div className="flex items-center justify-between gap-3">
          <h3 data-slot="section-title" className="font-semibold">
            What changed
          </h3>
          <Badge variant="secondary" className="px-2 py-1 tabular-nums">
            {changes.length} {changes.length === 1 ? "entry" : "entries"}
          </Badge>
        </div>
        <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
          Grouped by area. Open a section to review its changes.
        </p>
        {groups.length ? (
          <div className="border-border mt-4 divide-y rounded-xl border">
            {groups.map(({ prefix, label, icon: Icon, entries }) => (
              <Collapsible
                key={`${first.id}-${second.id}-${prefix}`}
                className="group border-border"
              >
                <CollapsibleTrigger
                  aria-label={`${label}, ${entries.length} change entries`}
                  className="hover:bg-muted/50 focus-visible:outline-ring flex min-h-16 w-full cursor-pointer list-none items-center gap-3 px-4 py-3 text-left outline-offset-2 focus-visible:outline-2 [&::-webkit-details-marker]:hidden"
                >
                  <Icon
                    aria-hidden="true"
                    className="text-muted-foreground size-4 shrink-0"
                  />
                  <span className="min-w-0 flex-1 text-sm font-medium">
                    {label}
                  </span>
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {entries.length}
                  </span>
                  <ChevronDown
                    aria-hidden="true"
                    className="text-muted-foreground size-4 shrink-0 transition-transform group-data-[open]:rotate-180 motion-reduce:transition-none"
                  />
                </CollapsibleTrigger>
                <CollapsibleContent keepMounted>
                  <ul className="border-border bg-muted/20 space-y-3 border-t px-4 py-4">
                    {entries.map((change, index) => {
                      const operation = change.match(
                        /^[A-Za-z]+ (added|removed):/,
                      )?.[1];
                      const Mark =
                        operation === "added"
                          ? Plus
                          : operation === "removed"
                            ? Minus
                            : SlidersHorizontal;
                      return (
                        <li
                          key={`${change}-${index}`}
                          className="flex items-start gap-3 text-sm leading-relaxed [overflow-wrap:anywhere]"
                        >
                          <Mark
                            aria-hidden="true"
                            className={`mt-1 size-3.5 shrink-0 ${operation === "added" ? "text-success" : operation === "removed" ? "text-destructive" : "text-muted-foreground"}`}
                          />
                          <span className="min-w-0">{change}</span>
                        </li>
                      );
                    })}
                  </ul>
                </CollapsibleContent>
              </Collapsible>
            ))}
          </div>
        ) : (
          <div className="border-border mt-4 flex items-start gap-3 rounded-xl border p-4">
            <Check
              aria-hidden="true"
              className="text-muted-foreground mt-0.5 size-4 shrink-0"
            />
            <p className="text-sm">
              No structural changes between these versions.
            </p>
          </div>
        )}
      </section>
      <p className="border-border text-muted-foreground mt-5 border-t pt-4 text-xs">
        Comparing saved designs does not change your draft.
      </p>
    </div>
  );
}
