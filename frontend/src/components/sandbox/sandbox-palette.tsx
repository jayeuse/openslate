"use client";

import type { DragEvent } from "react";

import {
  Box,
  Building2,
  Calculator,
  Calendar,
  CalendarClock,
  Hash,
  Link2,
  List,
  Plus,
  Sparkles,
  ToggleLeft,
  Type,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  FIELD_TYPE_META,
  type SandboxFieldType,
  type Stage,
} from "@/lib/sandbox/model";

export interface SandboxPaletteProps {
  stage: Stage;
  onAddDepartment: () => void;
  onAddModule: () => void;
  onAddField: (type: SandboxFieldType) => void;
  onAddRelationship: () => void;
  disabledReason?: string;
}

const FIELD_ICONS = {
  Type,
  Hash,
  Calculator,
  ToggleLeft,
  Calendar,
  CalendarClock,
  List,
} as const;

type FieldMetaEntry = [
  SandboxFieldType,
  (typeof FIELD_TYPE_META)[SandboxFieldType],
];

const FIELD_ENTRIES = Object.entries(FIELD_TYPE_META) as FieldMetaEntry[];

const STAGE_HEADINGS: Record<Stage, { title: string; hint: string }> = {
  departments: {
    title: "Departments",
    hint: "Group modules into departments.",
  },
  modules: {
    title: "Modules",
    hint: "Add tables inside a department.",
  },
  fields: {
    title: "Fields",
    hint: "Drag onto a module or click to add.",
  },
  relationships: {
    title: "Relationships",
    hint: "Connect two modules on the canvas.",
  },
  automation: {
    title: "Automation",
    hint: "Workflows arrive later.",
  },
};

function setDragPayload(
  event: DragEvent<HTMLDivElement>,
  kind: string,
  fieldType?: SandboxFieldType,
): void {
  event.dataTransfer.setData("application/x-sandbox-kind", kind);
  // Types remain readable during native dragover while payload data is protected.
  event.dataTransfer.setData(`application/x-sandbox-kind-${kind}`, kind);
  if (fieldType !== undefined) {
    event.dataTransfer.setData("application/x-sandbox-field-type", fieldType);
  }
  event.dataTransfer.effectAllowed = "copy";
}

export function SandboxPalette({
  stage,
  onAddDepartment,
  onAddModule,
  onAddField,
  disabledReason,
  onAddRelationship,
}: SandboxPaletteProps) {
  const locked = disabledReason !== undefined && disabledReason.length > 0;
  const heading = STAGE_HEADINGS[stage];

  return (
    <section aria-label="Sandbox palette" className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-semibold">{heading.title}</h2>
        <p className="text-muted-foreground text-xs">{heading.hint}</p>
      </div>

      {locked ? (
        <p
          role="note"
          className="border-border bg-muted rounded-[var(--radius)] border px-3 py-2 text-xs"
        >
          {disabledReason}
        </p>
      ) : null}

      {stage === "departments" ? (
        <div
          draggable={!locked}
          data-kind="department"
          onDragStart={(event) => setDragPayload(event, "department")}
        >
          <Button
            type="button"
            variant="outline"
            data-testid="palette-add-department"
            aria-label="Add department"
            title={locked ? disabledReason : "Add a department"}
            disabled={locked}
            onClick={onAddDepartment}
            className="w-full justify-start"
          >
            <Building2 aria-hidden="true" />
            <span className="flex-1 text-left">Department</span>
            <Plus aria-hidden="true" />
          </Button>
          <p className="text-muted-foreground mt-1.5 text-xs">
            Drag onto the canvas, or select Add.
          </p>
        </div>
      ) : null}

      {stage === "modules" ? (
        <div
          draggable={!locked}
          data-kind="module"
          onDragStart={(event) => setDragPayload(event, "module")}
        >
          <Button
            type="button"
            variant="outline"
            data-testid="palette-add-module"
            aria-label="Add module"
            title={locked ? disabledReason : "Add a module"}
            disabled={locked}
            onClick={onAddModule}
            className="w-full justify-start"
          >
            <Box aria-hidden="true" />
            <span className="flex-1 text-left">Module</span>
            <Plus aria-hidden="true" />
          </Button>
          <p className="text-muted-foreground mt-1.5 text-xs">
            Drag onto a department, or select Add.
          </p>
        </div>
      ) : null}

      {stage === "fields" ? (
        <ul className="flex flex-col gap-2">
          {FIELD_ENTRIES.map(([type, meta]) => {
            const FieldIcon =
              FIELD_ICONS[meta.icon as keyof typeof FIELD_ICONS];
            return (
              <li key={type}>
                <div
                  draggable={!locked}
                  data-kind="field"
                  data-field-type={type}
                  onDragStart={(event) => setDragPayload(event, "field", type)}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    data-testid={`palette-add-field-${type}`}
                    aria-label={`Add ${meta.label} field`}
                    title={
                      locked ? disabledReason : `Add a ${meta.label} field`
                    }
                    disabled={locked}
                    onClick={() => onAddField(type)}
                    className="h-11 w-full justify-start gap-3 px-2"
                  >
                    <FieldIcon aria-hidden="true" />
                    <span className="flex-1 text-left">{meta.label}</span>
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {stage === "relationships" ? (
        <div data-kind="relationship">
          <Button
            type="button"
            variant="outline"
            data-testid="palette-add-relationship"
            aria-label="Start a relationship"
            title={
              locked && disabledReason
                ? disabledReason
                : "Choose the source and target modules"
            }
            disabled={locked}
            onClick={onAddRelationship}
            className="w-full justify-start"
          >
            <Link2 aria-hidden="true" />
            <span className="flex-1 text-left">Relationship</span>
          </Button>
          <p className="text-muted-foreground mt-1.5 text-xs">
            Drag between the connection handles, or click to choose two modules.
          </p>
        </div>
      ) : null}

      {stage === "automation" ? (
        <Card
          data-testid="palette-automation-coming-soon"
          className="border-dashed p-4 text-center"
        >
          <Sparkles
            aria-hidden="true"
            className="text-muted-foreground mx-auto size-5"
          />
          <p className="mt-2 text-sm font-medium">Automation</p>
          <p className="text-muted-foreground mt-0.5 text-xs">Coming later</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled
            title="Coming later"
            aria-label="Add automation (coming later)"
            data-testid="palette-add-automation"
            className="mt-3 w-full"
          >
            Add
          </Button>
        </Card>
      ) : null}
    </section>
  );
}
