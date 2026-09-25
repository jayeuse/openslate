"use client";

import { Plus, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { OpenViewAudienceConfirmation } from "./audience-confirmation";
import {
  audienceLabel,
  decodeAudienceRef,
  getModuleDefinition,
  isUnresolvedAudience,
  type AudienceLookup,
  type AudienceRef,
  type OpenViewModuleId,
  type RefreshCadence,
  type SortRule,
} from "../domain/model";
import {
  audienceValue,
  parseAudienceValue,
  refreshFromValue,
  refreshValue,
} from "./analytics-data";

export function Choice({
  id,
  label,
  value,
  values,
  onChange,
  description,
  disabled = false,
}: {
  id?: string;
  label: string;
  value: string;
  values: { value: string; label: string }[] | string[];
  onChange: (value: string) => void;
  description?: string;
  disabled?: boolean;
}) {
  const options = values.map((item) =>
    typeof item === "string" ? { value: item, label: item } : item,
  );
  const inputId =
    id ?? `openview-choice-${label.toLowerCase().replaceAll(" ", "-")}`;
  return (
    <Field data-disabled={disabled ? true : undefined}>
      <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
      <Select
        id={inputId}
        className="h-11 min-h-11"
        value={value}
        disabled={disabled}
        onValueChange={onChange}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
}

export function AudienceField({
  id,
  label = "Audience preview",
  audience,
  audienceLookup,
  onChange,
}: {
  id: string;
  label?: string;
  audience: AudienceRef;
  audienceLookup: AudienceLookup;
  onChange: (audience: AudienceRef) => void;
}) {
  const [pending, setPending] = useState<AudienceRef | null>(null);
  const lookup = audienceLookup;
  const audienceOptions = [
    { value: "private", label: "Only me" },
    { value: "everyone", label: "Everyone" },
    ...(lookup.roles ?? []).map((role) => ({
      value: `role:${role.id}`,
      label: `Role: ${role.name}`,
    })),
    ...(lookup.identities ?? []).map((person) => ({
      value: `identity:${person.id}`,
      label: `User: ${person.name}`,
    })),
  ];
  return (
    <>
      <Choice
        id={id}
        label={label}
        value={audienceValue(audience)}
        values={audienceOptions}
        onChange={(value) => {
          const next = parseAudienceValue(value);
          if (next.kind === "everyone" && audience.kind !== "everyone")
            setPending(next);
          else onChange(decodeAudienceRef(next, lookup));
        }}
        description="This does not change access permissions."
      />
      <div className="flex items-center gap-2">
        <Badge
          variant={
            audience.kind === "everyone" || isUnresolvedAudience(audience)
              ? "warning"
              : "secondary"
          }
        >
          {audienceLabel(audience, lookup)}
        </Badge>
      </div>
      <OpenViewAudienceConfirmation
        open={pending !== null}
        artifact="artifact"
        cancelLabel="Keep private"
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending) onChange(pending);
          setPending(null);
        }}
      />
    </>
  );
}

export function RefreshField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: RefreshCadence;
  onChange: (value: RefreshCadence) => void;
}) {
  return (
    <Choice
      id={id}
      label="Refresh interval"
      value={refreshValue(value)}
      values={[
        { value: "manual", label: "Manual" },
        { value: "one-minute", label: "Every minute" },
        { value: "five-minutes", label: "Every 5 minutes" },
      ]}
      onChange={(next) => onChange(refreshFromValue(next))}
      description="No background refresh is scheduled."
    />
  );
}

export function SortEditor({
  moduleId,
  sorts,
  onChange,
}: {
  moduleId: OpenViewModuleId;
  sorts: SortRule[];
  onChange: (sorts: SortRule[]) => void;
}) {
  const moduleDefinition = getModuleDefinition(moduleId);
  return (
    <FieldSet>
      <FieldLegend>Sort order</FieldLegend>
      <p className="text-muted-foreground text-sm">
        Use up to three ordered sort rules.
      </p>
      <FieldGroup>
        {sorts.map((sort, index) => (
          <div
            key={`${sort.field}-${index}`}
            className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end"
          >
            <Choice
              id={`sort-field-${index}`}
              label={`Sort ${index + 1} field`}
              value={sort.field}
              values={moduleDefinition.fields.map((field) => ({
                value: field.id,
                label: field.label,
              }))}
              onChange={(field) =>
                onChange(
                  sorts.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, field } : item,
                  ),
                )
              }
            />
            <Choice
              id={`sort-direction-${index}`}
              label="Direction"
              value={sort.direction}
              values={[
                { value: "asc", label: "Ascending" },
                { value: "desc", label: "Descending" },
              ]}
              onChange={(direction) =>
                onChange(
                  sorts.map((item, itemIndex) =>
                    itemIndex === index
                      ? {
                          ...item,
                          direction: direction === "desc" ? "desc" : "asc",
                        }
                      : item,
                  ),
                )
              }
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="min-h-11 min-w-11"
              aria-label={`Remove sort ${index + 1}`}
              onClick={() =>
                onChange(sorts.filter((_, itemIndex) => itemIndex !== index))
              }
            >
              <X data-icon="inline-start" />
            </Button>
          </div>
        ))}
      </FieldGroup>
      <Button
        type="button"
        variant="outline"
        className="min-h-11 self-start"
        disabled={sorts.length >= 3}
        onClick={() =>
          onChange([
            ...sorts,
            { field: moduleDefinition.primaryField, direction: "asc" },
          ])
        }
      >
        <Plus data-icon="inline-start" />
        Add sort
      </Button>
    </FieldSet>
  );
}

export function Workbench({
  controls,
  children,
}: {
  controls: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(17rem,20rem)_minmax(0,1fr)]">
      <aside className="bg-card flex h-fit flex-col gap-5 rounded-[var(--radius)] border p-5">
        {controls}
      </aside>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className = "",
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Empty className={className}>
      <EmptyHeader>
        {icon ? <EmptyMedia variant="icon">{icon}</EmptyMedia> : null}
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}
