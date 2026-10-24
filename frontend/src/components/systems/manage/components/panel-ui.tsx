"use client";
import { Badge } from "@/components/ui/badge";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Select, SelectItem } from "@/components/ui/select";
import type { ManageSection, ManageSettings } from "../state/model";
export function SettingSelect({
  id,
  label,
  value,
  options,
  optionLabels,
  onChange,
  description,
  error,
  disabled = false,
}: {
  id: string;
  label: string;
  value: string;
  options: readonly string[];
  optionLabels?: Readonly<Record<string, string>>;
  onChange: (value: string) => void;
  description?: string;
  error?: string;
  disabled?: boolean;
}) {
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;

  return (
    <Field data-invalid={Boolean(error)} disabled={disabled}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        id={id}
        disabled={disabled}
        value={options.includes(value) ? value : ""}
        placeholder={
          options.includes(value) ? undefined : "Choose a valid option"
        }
        onValueChange={onChange}
        aria-describedby={
          [descriptionId, errorId].filter(Boolean).join(" ") || undefined
        }
        aria-invalid={Boolean(error)}
        className="min-h-11"
      >
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {optionLabels?.[option] ?? option}
          </SelectItem>
        ))}
      </Select>
      {description ? (
        <FieldDescription id={descriptionId} className="md:sr-only">
          {description}
        </FieldDescription>
      ) : null}
      <FieldError id={errorId}>{error}</FieldError>
    </Field>
  );
}

export function SectionHeading({
  title,
  description,
  dirty,
}: {
  title: string;
  description: string;
  dirty?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2
          data-slot="section-title"
          className="text-xl font-semibold tracking-tight"
        >
          {title}
        </h2>
        <p className="text-muted-foreground mt-1 max-w-3xl text-sm md:sr-only">
          {description}
        </p>
      </div>
      {dirty ? <Badge variant="warning">Unsaved</Badge> : null}
    </div>
  );
}

export function SummaryItem({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b py-3 last:border-0">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="text-right text-sm font-medium">{value}</dd>
    </div>
  );
}

export type SettingsPanelForm = {
  current: ManageSettings;
  errors: Partial<Record<keyof ManageSettings, string>>;
  changeSetting: (
    section: ManageSection,
    key: keyof ManageSettings,
    value: string,
  ) => void;
  saveSection: (section: ManageSection) => Promise<void>;
  clearDraft: (section: ManageSection) => void;
};
