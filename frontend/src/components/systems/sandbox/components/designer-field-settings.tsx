import { useEffect, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { AdvancedSection } from "@/components/ui/advanced-section";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Field as FormField,
  FieldError,
  FieldGroup,
} from "@/components/ui/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  FIELD_TYPES,
  fieldTypeLabel,
  normalizeField,
  type Field,
  type FieldConfig,
  type FieldTypeName,
  type SelectOption,
} from "../domain/model";
import { dateValueInRange } from "../domain/date-values";
import type { SandboxCommandResult } from "../state/commands";
import { cn } from "@/lib/utils";
import { fieldAdvancedSummary } from "../domain/build-summary";
import { PropertyRow } from "./designer-properties";

type FieldDraft = {
  name: string;
  description: string;
  type: FieldTypeName;
  required: boolean;
  defaultValue: string;
  options: string;
  selectOptions?: SelectOption[];
  maxLength: string;
  min: string;
  max: string;
  step: string;
  earliest: string;
  latest: string;
  checked: boolean;
};

function draftForField(field: Field): FieldDraft {
  const normalized = normalizeField(field);
  const config = normalized.config;
  return {
    name: field.name,
    description: field.description ?? "",
    type: normalized.type as FieldTypeName,
    required: field.required,
    defaultValue:
      config.kind === "checkbox" || config.kind === "user"
        ? ""
        : config.defaultValue === null
          ? ""
          : String(config.defaultValue),
    options:
      config.kind === "select"
        ? config.options.map((option) => option.label).join(", ")
        : "",
    selectOptions: config.kind === "select" ? config.options : [],
    maxLength:
      config.kind === "text" ||
      config.kind === "long-text" ||
      config.kind === "email" ||
      config.kind === "url"
        ? String(config.maxLength ?? "")
        : "",
    min:
      config.kind === "number" || config.kind === "integer"
        ? String(config.min ?? "")
        : "",
    max:
      config.kind === "number" || config.kind === "integer"
        ? String(config.max ?? "")
        : "",
    step:
      config.kind === "number" || config.kind === "integer"
        ? String(config.kind === "integer" ? 1 : (config.step ?? ""))
        : "",
    earliest:
      config.kind === "date" || config.kind === "datetime"
        ? (config.earliest ?? "")
        : "",
    latest:
      config.kind === "date" || config.kind === "datetime"
        ? (config.latest ?? "")
        : "",
    checked: config.kind === "checkbox" ? config.defaultValue : false,
  };
}

function optionLabels(options: string): string[] {
  return options
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function reconcileSelectOptions(
  previousOptions: SelectOption[],
  labels: string[],
  newId: (index: number) => string,
): SelectOption[] {
  const reservedIds = new Set(
    previousOptions
      .filter((option) => labels.includes(option.label))
      .map((option) => option.id),
  );
  const usedIds = new Set<string>();
  return labels.map((label, index) => {
    const exact = previousOptions.find(
      (option) => option.label === label && !usedIds.has(option.id),
    );
    const samePosition = previousOptions[index];
    const preserved =
      exact ??
      (samePosition &&
      !reservedIds.has(samePosition.id) &&
      !usedIds.has(samePosition.id)
        ? samePosition
        : undefined);
    const id = preserved?.id ?? newId(index);
    usedIds.add(id);
    return { id, label };
  });
}

function selectOptionsForDraft(
  field: Field,
  draft: FieldDraft,
): SelectOption[] {
  if (draft.type !== "Select") return [];
  if (draft.selectOptions) return draft.selectOptions;
  const previousConfig = normalizeField(field).config;
  const previousOptions =
    previousConfig.kind === "select" ? previousConfig.options : [];
  return reconcileSelectOptions(
    previousOptions,
    optionLabels(draft.options),
    (index) => `new:${index}`,
  );
}

function optionalNumber(value: string): number | undefined {
  return value.trim() ? Number(value) : undefined;
}

function validDateInput(value: string, type: "Date" | "Date/Time"): boolean {
  if (!value) return true;
  if (type === "Date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return (
      !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value)
    );
  }
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function alignsWithStep(value: number, step: number, base: number): boolean {
  const steps = (value - base) / step;
  const distance = Math.abs(steps - Math.round(steps));
  const tolerance = Math.min(
    1e-7,
    Number.EPSILON * 32 * Math.max(1, Math.abs(steps)),
  );
  return distance <= tolerance;
}

export function buildField(field: Field, draft: FieldDraft): Field | string {
  if (!draft.name.trim()) return "Field name is required.";
  const type = draft.type;
  let config: FieldConfig;
  let value = draft.defaultValue;
  let options = "";
  if (["Text", "Long text", "Email", "URL"].includes(type)) {
    const kind =
      type === "Text"
        ? "text"
        : type === "Long text"
          ? "long-text"
          : (type.toLowerCase() as "email" | "url");
    const maxLength = optionalNumber(draft.maxLength);
    if (
      maxLength !== undefined &&
      (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 1_000)
    )
      return "Maximum length must be a whole number between 1 and 1000.";
    if (draft.defaultValue.length > 1_000)
      return "Default value must be 1000 characters or fewer.";
    if (maxLength !== undefined && draft.defaultValue.length > maxLength)
      return "Default value cannot exceed maximum length.";
    if (
      type === "Email" &&
      draft.defaultValue &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.defaultValue)
    )
      return "Enter a valid email address.";
    if (type === "URL" && draft.defaultValue) {
      try {
        const url = new URL(draft.defaultValue);
        if (url.protocol !== "http:" && url.protocol !== "https:")
          return "Enter a valid HTTP or HTTPS URL.";
      } catch {
        return "Enter a valid HTTP or HTTPS URL.";
      }
    }
    config = { kind, defaultValue: draft.defaultValue, maxLength };
  } else if (type === "Number" || type === "Integer") {
    const kind = type === "Number" ? "number" : "integer";
    const defaultValue = draft.defaultValue.trim()
      ? Number(draft.defaultValue)
      : null;
    const min = optionalNumber(draft.min);
    const max = optionalNumber(draft.max);
    const step = kind === "integer" ? 1 : optionalNumber(draft.step);
    if (
      [defaultValue, min, max, step].some(
        (entry) =>
          entry !== null && entry !== undefined && !Number.isFinite(entry),
      )
    )
      return "Number settings must contain valid numbers.";
    if (
      kind === "integer" &&
      [defaultValue, min, max].some(
        (entry) =>
          entry !== null && entry !== undefined && !Number.isInteger(entry),
      )
    )
      return "Integer settings must use whole numbers.";
    if (min !== undefined && max !== undefined && min > max)
      return "Minimum cannot exceed maximum.";
    if (step !== undefined && step <= 0) return "Step must be positive.";
    if (
      defaultValue !== null &&
      ((min !== undefined && defaultValue < min) ||
        (max !== undefined && defaultValue > max))
    )
      return "Default value must be within the minimum and maximum.";
    if (
      defaultValue !== null &&
      step !== undefined &&
      !alignsWithStep(defaultValue, step, min ?? 0)
    )
      return "Default value must align with the configured step.";
    config = { kind, defaultValue, min, max, step };
  } else if (type === "Date" || type === "Date/Time") {
    const kind = type === "Date" ? "date" : "datetime";
    if (
      !validDateInput(draft.defaultValue, type) ||
      !validDateInput(draft.earliest, type) ||
      !validDateInput(draft.latest, type)
    )
      return `${type} settings must contain valid values.`;
    if (
      draft.earliest &&
      draft.latest &&
      !dateValueInRange(kind, draft.earliest, undefined, draft.latest)
    )
      return "Earliest value cannot be after latest value.";
    if (
      draft.defaultValue &&
      !dateValueInRange(
        kind,
        draft.defaultValue,
        draft.earliest || undefined,
        draft.latest || undefined,
      )
    )
      return "Default value must be within the earliest and latest limits.";
    config = {
      kind,
      defaultValue: draft.defaultValue || null,
      earliest: draft.earliest || undefined,
      latest: draft.latest || undefined,
    };
  } else if (type === "Checkbox") {
    config = { kind: "checkbox", defaultValue: draft.checked };
    value = String(draft.checked);
  } else if (type === "User") {
    config = { kind: "user" };
    value = "";
  } else {
    const rawOptions = optionLabels(draft.options);
    if (new Set(rawOptions).size !== rawOptions.length)
      return "Select options must be unique.";
    if (rawOptions.length === 0) return "Add at least one select option.";
    if (rawOptions.length > 100)
      return "Select fields support up to 100 options.";
    if (rawOptions.some((option) => option.length > 100))
      return "Each select option must be 100 characters or fewer.";
    const draftOptions = selectOptionsForDraft(field, draft);
    const persistedIds = new Map<string, string>();
    const selectOptions = draftOptions.map((option) => {
      const id = option.id.startsWith("new:") ? crypto.randomUUID() : option.id;
      persistedIds.set(option.id, id);
      return { id, label: option.label };
    });
    const requestedDefault = draft.defaultValue.trim();
    const defaultValue = persistedIds.get(requestedDefault) ?? "";
    if (requestedDefault && !defaultValue)
      return "Default value must match a select option.";
    config = {
      kind: "select",
      defaultValue: defaultValue || null,
      options: selectOptions,
    };
    value = defaultValue;
    options = rawOptions.join(", ");
  }
  return {
    ...field,
    name: draft.name.trim(),
    description: draft.description,
    type,
    required: draft.required,
    value,
    options,
    config,
  };
}

/**
 * Which of a field's Advanced settings hold a value that is not the default:
 * the description, the default value (or checked by default), and any limit.
 * The closed Advanced header marks each one "(set)".
 */
function advancedFieldSettingsSet(field: Field) {
  const draft = draftForField(field);
  return {
    description: draft.description.trim() !== "",
    defaultValue: draft.defaultValue !== "" || draft.checked,
    limits: [
      draft.maxLength,
      draft.min,
      draft.max,
      draft.type === "Integer" ? "" : draft.step,
      draft.earliest,
      draft.latest,
    ].some((value) => value !== ""),
  };
}

export function FieldSettings({
  field,
  index,
  count,
  onSave,
  onMove,
  onLifecycle,
  onDelete,
  titleFieldId,
  autoFocus = false,
  pending = false,
  lifecycleClosed,
  lifecycleDisabled = false,
  lifecycleReason,
  onPurge,
  draftId,
  onDraftStateChange,
}: {
  field: Field;
  index: number;
  count: number;
  onSave: (field: Field) => Promise<SandboxCommandResult<unknown>>;
  onMove: (delta: number) => Promise<SandboxCommandResult<unknown>>;
  onLifecycle: () => Promise<SandboxCommandResult<unknown>>;
  /** Opens the delete confirmation for this field. */
  onDelete?: () => void;
  titleFieldId: string | null;
  autoFocus?: boolean;
  pending?: boolean;
  lifecycleClosed?: boolean;
  lifecycleDisabled?: boolean;
  /** Why closing is unavailable, when it is. */
  lifecycleReason?: string | null;
  onPurge?: () => Promise<SandboxCommandResult<unknown>>;
  draftId: string;
  onDraftStateChange: (id: string, dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState(() => draftForField(field));
  const closed = lifecycleClosed ?? field.closed;
  const isRecordTitle = titleFieldId === field.id && !closed;
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftForField(field));
  useEffect(() => {
    onDraftStateChange(draftId, dirty);
  }, [draftId, dirty, onDraftStateChange]);
  useEffect(
    () => () => onDraftStateChange(draftId, false),
    [draftId, onDraftStateChange],
  );
  const selectOptions = selectOptionsForDraft(field, draft);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setDraft(draftForField(field));
    setError("");
  }, [field]);
  const update = <K extends keyof FieldDraft>(key: K, value: FieldDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setError("");
  };
  const updateOptions = (options: string) => {
    const labels = optionLabels(options);
    const newIds = labels.map(() => `new:${crypto.randomUUID()}`);
    setDraft((current) => ({
      ...current,
      options,
      selectOptions: reconcileSelectOptions(
        current.selectOptions ?? [],
        labels,
        (index) => newIds[index],
      ),
    }));
    setError("");
  };
  // Visible labels drop the field name that the row already shows; each
  // control's accessible name keeps it ("Status options"), which still
  // contains the visible text (WCAG 2.5.3).
  const prefix = field.name;
  const controlId = (suffix: string) => `sandbox-field-${field.id}-${suffix}`;
  const closeReason = isRecordTitle
    ? "This is the module's title field."
    : lifecycleDisabled
      ? (lifecycleReason ?? null)
      : null;
  return (
    <FieldGroup data-field-dirty={dirty || undefined} className="gap-3 pt-1">
      <fieldset disabled={pending} className="contents">
        <PropertyRow id={controlId("name")} label="Name">
          <Input
            id={controlId("name")}
            aria-label={`${prefix} name`}
            autoFocus={autoFocus}
            data-sandbox-field-name={field.id}
            value={draft.name}
            maxLength={80}
            onChange={(event) => update("name", event.target.value)}
          />
        </PropertyRow>
        <PropertyRow id={controlId("type")} label="Type">
          <NativeSelect
            id={controlId("type")}
            aria-label={`${prefix} field type`}
            className="w-full [&_select]:min-h-10"
            value={draft.type}
            onChange={(event) =>
              update("type", event.target.value as FieldTypeName)
            }
          >
            {FIELD_TYPES.map((entry) => (
              <NativeSelectOption key={entry.kind} value={entry.name}>
                {fieldTypeLabel(entry.name)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </PropertyRow>
        <PropertyRow id={controlId("required")} label="Required" inline>
          <span className="flex min-h-11 items-center xl:min-h-8">
            {/* A 44px hit layer around the 16px box; the label beside it
                is clickable too (EXIT-9, S25). */}
            <Checkbox
              id={controlId("required")}
              className="after:-inset-3.5"
              checked={draft.required}
              onCheckedChange={(checked) => update("required", checked)}
            />
          </span>
        </PropertyRow>
        {draft.type === "Select" ? (
          <PropertyRow id={controlId("options")} label="Options">
            <Input
              id={controlId("options")}
              aria-label={`${prefix} options`}
              value={draft.options}
              placeholder="Open, Closed"
              onChange={(event) => updateOptions(event.target.value)}
            />
          </PropertyRow>
        ) : null}
        {error ? (
          <FormField data-invalid>
            <FieldError className="text-xs">{error}</FieldError>
          </FormField>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ButtonGroup aria-label={`${field.name} ordering actions`}>
            <Button
              size="icon"
              variant="outline"
              className="size-11 xl:size-8"
              aria-label={`Move ${field.name} up`}
              disabled={pending || index === 0}
              onClick={async () => {
                const result = await onMove(-1);
                if (!result.ok) setError(result.error);
              }}
            >
              <ArrowUp aria-hidden="true" />
            </Button>
            <Button
              size="icon"
              variant="outline"
              className="size-11 xl:size-8"
              aria-label={`Move ${field.name} down`}
              disabled={pending || index === count - 1}
              onClick={async () => {
                const result = await onMove(1);
                if (!result.ok) setError(result.error);
              }}
            >
              <ArrowDown aria-hidden="true" />
            </Button>
          </ButtonGroup>
          {dirty ? (
            <div
              role="group"
              aria-label={`${field.name} save actions`}
              className="flex gap-2"
            >
              <Button
                size="sm"
                variant="outline"
                disabled={pending || saving}
                onClick={() => {
                  setDraft(draftForField(field));
                  setError("");
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                pending={saving}
                pendingLabel="Saving…"
                disabled={pending}
                onClick={async () => {
                  const result = buildField(field, draft);
                  if (typeof result === "string") {
                    setError(result);
                    return;
                  }
                  setSaving(true);
                  const saved = await onSave(result);
                  setSaving(false);
                  if (!saved.ok) setError(saved.error);
                }}
              >
                Save field changes
              </Button>
            </div>
          ) : null}
        </div>
        <AdvancedSection
          storageKey="sandbox.field"
          summary={fieldAdvancedSummary(
            draft.type,
            { closed, canPurge: onPurge !== undefined },
            advancedFieldSettingsSet(field),
          )}
        >
          <PropertyRow id={controlId("description")} label="Description">
            <Input
              id={controlId("description")}
              aria-label={`${prefix} description`}
              value={draft.description}
              maxLength={1000}
              onChange={(event) => update("description", event.target.value)}
            />
          </PropertyRow>
          {draft.type === "Checkbox" ? (
            <PropertyRow
              id={controlId("default-checked")}
              label="Checked by default"
              inline
            >
              <span className="flex min-h-11 items-center xl:min-h-8">
                <Checkbox
                  id={controlId("default-checked")}
                  aria-label={`${prefix} checked by default`}
                  checked={draft.checked}
                  onCheckedChange={(checked) => update("checked", checked)}
                />
              </span>
            </PropertyRow>
          ) : draft.type === "User" ? (
            <p className="text-muted-foreground text-sm">
              No default: each record sets its user.
            </p>
          ) : draft.type === "Select" ? (
            <PropertyRow id={controlId("default-value")} label="Default value">
              <NativeSelect
                id={controlId("default-value")}
                aria-label={`${prefix} default value`}
                className="w-full"
                value={draft.defaultValue}
                onChange={(event) =>
                  update("defaultValue", event.currentTarget.value)
                }
              >
                <NativeSelectOption value="">No default</NativeSelectOption>
                {selectOptions.map((option) => (
                  <NativeSelectOption key={option.id} value={option.id}>
                    {option.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </PropertyRow>
          ) : (
            <PropertyRow id={controlId("default-value")} label="Default value">
              <Input
                id={controlId("default-value")}
                aria-label={`${prefix} default value`}
                type={
                  draft.type === "Date"
                    ? "date"
                    : draft.type === "Date/Time"
                      ? "datetime-local"
                      : draft.type === "Number" || draft.type === "Integer"
                        ? "number"
                        : "text"
                }
                value={draft.defaultValue}
                onChange={(event) => update("defaultValue", event.target.value)}
              />
            </PropertyRow>
          )}
          {["Text", "Long text", "Email", "URL"].includes(draft.type) ? (
            <PropertyRow
              id={controlId("maximum-length")}
              label="Maximum length"
            >
              <Input
                id={controlId("maximum-length")}
                aria-label={`${prefix} maximum length`}
                type="number"
                min="1"
                value={draft.maxLength}
                onChange={(event) => update("maxLength", event.target.value)}
              />
            </PropertyRow>
          ) : null}
          {draft.type === "Number" || draft.type === "Integer" ? (
            <>
              <PropertyRow id={controlId("minimum")} label="Minimum">
                <Input
                  id={controlId("minimum")}
                  aria-label={`${prefix} minimum`}
                  type="number"
                  value={draft.min}
                  onChange={(event) => update("min", event.target.value)}
                />
              </PropertyRow>
              <PropertyRow id={controlId("maximum")} label="Maximum">
                <Input
                  id={controlId("maximum")}
                  aria-label={`${prefix} maximum`}
                  type="number"
                  value={draft.max}
                  onChange={(event) => update("max", event.target.value)}
                />
              </PropertyRow>
              {draft.type === "Integer" ? null : (
                <PropertyRow id={controlId("step")} label="Step">
                  <Input
                    id={controlId("step")}
                    aria-label={`${prefix} step`}
                    type="number"
                    value={draft.step}
                    onChange={(event) => update("step", event.target.value)}
                  />
                </PropertyRow>
              )}
            </>
          ) : null}
          {draft.type === "Date" || draft.type === "Date/Time" ? (
            <>
              <PropertyRow id={controlId("earliest")} label="Earliest">
                <Input
                  id={controlId("earliest")}
                  aria-label={`${prefix} earliest`}
                  type={draft.type === "Date" ? "date" : "datetime-local"}
                  value={draft.earliest}
                  onChange={(event) => update("earliest", event.target.value)}
                />
              </PropertyRow>
              <PropertyRow id={controlId("latest")} label="Latest">
                <Input
                  id={controlId("latest")}
                  aria-label={`${prefix} latest`}
                  type={draft.type === "Date" ? "date" : "datetime-local"}
                  value={draft.latest}
                  onChange={(event) => update("latest", event.target.value)}
                />
              </PropertyRow>
            </>
          ) : null}
          <div
            role="group"
            aria-label={`${field.name} lifecycle actions`}
            className="flex flex-wrap gap-2"
          >
            <DisabledReason reason={closeReason}>
              <Button
                variant="outline"
                size="sm"
                disabled={pending || lifecycleDisabled || isRecordTitle}
                onClick={async () => {
                  const result = await onLifecycle();
                  if (!result.ok) setError(result.error);
                }}
              >
                {closed ? "Reopen" : "Close"} field
              </Button>
            </DisabledReason>
            {onDelete ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-danger-text"
                disabled={pending}
                onClick={onDelete}
              >
                Delete field
              </Button>
            ) : null}
            {onPurge ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-danger-text"
                disabled={pending || lifecycleDisabled}
                onClick={async () => {
                  const result = await onPurge();
                  if (!result.ok) setError(result.error);
                }}
              >
                Permanently delete field
              </Button>
            ) : null}
          </div>
        </AdvancedSection>
      </fieldset>
    </FieldGroup>
  );
}

/**
 * One field in the module's field list: a hairline row with the required
 * mark, the name, and the type in the code face (the canvas row rhythm).
 * The row opens its settings in place.
 */
export function FieldRow({
  field,
  selected,
  children,
}: {
  field: Field;
  selected: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(selected);
  // Once opened, the settings stay mounted while collapsed, so an unsaved
  // edit survives closing the row (and the row says it is unsaved).
  const [opened, setOpened] = useState(selected);

  useEffect(() => {
    if (selected) {
      setOpen(true);
      setOpened(true);
    }
  }, [selected]);

  return (
    <Collapsible
      role="group"
      aria-label={`${field.name} field settings`}
      data-selected={selected ? "true" : "false"}
      className="group border-border border-b last:border-b-0"
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setOpened(true);
      }}
    >
      <CollapsibleTrigger className="hover:bg-surface-hover focus-visible:outline-ring group-data-[selected=true]:bg-accent flex min-h-11 w-full items-center gap-2.5 rounded-sm px-2 text-left text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 xl:min-h-9">
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full border border-current",
            field.required ? "bg-current" : "bg-transparent",
            "text-muted-foreground",
          )}
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-medium",
            field.closed && "text-muted-foreground",
          )}
        >
          {field.name}
        </span>
        <Badge
          variant="warning"
          className="hidden group-has-[[data-field-dirty]]:inline-flex"
        >
          Unsaved
        </Badge>
        {field.closed ? (
          <Badge variant="outline">Closed</Badge>
        ) : (
          <span className="text-muted-foreground font-mono text-xs">
            {fieldTypeLabel(field.type)}
          </span>
        )}
        {field.required ? <span className="sr-only">, required</span> : null}
        <ChevronDown
          aria-hidden="true"
          className="text-muted-foreground size-4 shrink-0 transition-transform duration-(--motion-fast) group-data-[open]:rotate-180 motion-reduce:transition-none"
        />
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted={opened} className="px-2 pt-1 pb-4">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
