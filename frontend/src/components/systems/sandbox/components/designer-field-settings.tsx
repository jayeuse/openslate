import { useEffect, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  FieldLabel,
} from "@/components/ui/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  FIELD_TYPES,
  normalizeField,
  type Field,
  type FieldConfig,
  type FieldTypeName,
} from "../domain/model";
import { dateValueInRange } from "../domain/date-values";
import type { SandboxCommandResult } from "../state/commands";

type FieldDraft = {
  name: string;
  description: string;
  type: FieldTypeName;
  required: boolean;
  defaultValue: string;
  options: string;
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
      config.kind === "checkbox"
        ? ""
        : config.defaultValue === null
          ? ""
          : String(config.defaultValue),
    options: config.kind === "select" ? config.options.join(", ") : "",
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
  } else {
    const rawOptions = draft.options
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (new Set(rawOptions).size !== rawOptions.length)
      return "Select options must be unique.";
    if (rawOptions.length === 0) return "Add at least one select option.";
    if (rawOptions.length > 100)
      return "Select fields support up to 100 options.";
    if (rawOptions.some((option) => option.length > 100))
      return "Each select option must be 100 characters or fewer.";
    const defaultValue = draft.defaultValue.trim();
    if (defaultValue && !rawOptions.includes(defaultValue))
      return "Default value must match a select option.";
    config = {
      kind: "select",
      defaultValue: defaultValue || null,
      options: rawOptions,
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

export function FieldSettings({
  field,
  index,
  count,
  onSave,
  onMove,
  onLifecycle,
  autoFocus = false,
  pending = false,
}: {
  field: Field;
  index: number;
  count: number;
  onSave: (field: Field) => Promise<SandboxCommandResult<unknown>>;
  onMove: (delta: number) => Promise<SandboxCommandResult<unknown>>;
  onLifecycle: () => Promise<SandboxCommandResult<unknown>>;
  autoFocus?: boolean;
  pending?: boolean;
}) {
  const [draft, setDraft] = useState(() => draftForField(field));
  const [error, setError] = useState("");
  useEffect(() => {
    setDraft(draftForField(field));
    setError("");
  }, [field]);
  const update = <K extends keyof FieldDraft>(key: K, value: FieldDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setError("");
  };
  const prefix = field.name;
  const controlId = (suffix: string) => `sandbox-field-${field.id}-${suffix}`;
  return (
    <FieldGroup className="mt-3 gap-3">
      <fieldset disabled={pending} className="contents">
        <FormField>
          <FieldLabel htmlFor={controlId("name")}>{prefix} name</FieldLabel>
          <Input
            id={controlId("name")}
            autoFocus={autoFocus}
            data-sandbox-field-name={field.id}
            value={draft.name}
            maxLength={80}
            onChange={(event) => update("name", event.target.value)}
          />
        </FormField>
        <FormField>
          <FieldLabel htmlFor={controlId("description")}>
            {prefix} description
          </FieldLabel>
          <Input
            id={controlId("description")}
            value={draft.description}
            maxLength={1000}
            onChange={(event) => update("description", event.target.value)}
          />
        </FormField>
        <FormField>
          <FieldLabel htmlFor={controlId("type")}>
            {prefix} field type
          </FieldLabel>
          <NativeSelect
            id={controlId("type")}
            className="w-full [&_select]:min-h-10"
            value={draft.type}
            onChange={(event) =>
              update("type", event.target.value as FieldTypeName)
            }
          >
            {FIELD_TYPES.map((entry) => (
              <NativeSelectOption key={entry.kind} value={entry.name}>
                {entry.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </FormField>
        {draft.type === "Checkbox" ? (
          <FormField className="min-h-11 flex-row items-center gap-2 xl:min-h-0">
            <Checkbox
              id={controlId("default-checked")}
              checked={draft.checked}
              onCheckedChange={(checked) => update("checked", checked)}
            />
            <FieldLabel htmlFor={controlId("default-checked")}>
              {prefix} default checked
            </FieldLabel>
          </FormField>
        ) : (
          <FormField>
            <FieldLabel htmlFor={controlId("default-value")}>
              {prefix} default value
            </FieldLabel>
            <Input
              id={controlId("default-value")}
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
          </FormField>
        )}
        {["Text", "Long text", "Email", "URL"].includes(draft.type) ? (
          <FormField>
            <FieldLabel htmlFor={controlId("maximum-length")}>
              {prefix} maximum length
            </FieldLabel>
            <Input
              id={controlId("maximum-length")}
              type="number"
              min="1"
              value={draft.maxLength}
              onChange={(event) => update("maxLength", event.target.value)}
            />
          </FormField>
        ) : null}
        {draft.type === "Number" || draft.type === "Integer" ? (
          <FieldGroup className="grid grid-cols-2 gap-2">
            <FormField>
              <FieldLabel htmlFor={controlId("minimum")}>
                {prefix} minimum
              </FieldLabel>
              <Input
                id={controlId("minimum")}
                type="number"
                value={draft.min}
                onChange={(event) => update("min", event.target.value)}
              />
            </FormField>
            <FormField>
              <FieldLabel htmlFor={controlId("maximum")}>
                {prefix} maximum
              </FieldLabel>
              <Input
                id={controlId("maximum")}
                type="number"
                value={draft.max}
                onChange={(event) => update("max", event.target.value)}
              />
            </FormField>
            <FormField data-disabled={draft.type === "Integer" || undefined}>
              <FieldLabel htmlFor={controlId("step")}>{prefix} step</FieldLabel>
              <Input
                id={controlId("step")}
                type="number"
                value={draft.type === "Integer" ? "1" : draft.step}
                disabled={draft.type === "Integer"}
                onChange={(event) => update("step", event.target.value)}
              />
            </FormField>
          </FieldGroup>
        ) : null}
        {draft.type === "Date" || draft.type === "Date/Time" ? (
          <FieldGroup className="grid grid-cols-2 gap-2">
            <FormField>
              <FieldLabel htmlFor={controlId("earliest")}>
                {prefix} earliest
              </FieldLabel>
              <Input
                id={controlId("earliest")}
                type={draft.type === "Date" ? "date" : "datetime-local"}
                value={draft.earliest}
                onChange={(event) => update("earliest", event.target.value)}
              />
            </FormField>
            <FormField>
              <FieldLabel htmlFor={controlId("latest")}>
                {prefix} latest
              </FieldLabel>
              <Input
                id={controlId("latest")}
                type={draft.type === "Date" ? "date" : "datetime-local"}
                value={draft.latest}
                onChange={(event) => update("latest", event.target.value)}
              />
            </FormField>
          </FieldGroup>
        ) : null}
        {draft.type === "Select" ? (
          <FormField>
            <FieldLabel htmlFor={controlId("options")}>
              {prefix} options
            </FieldLabel>
            <Input
              id={controlId("options")}
              value={draft.options}
              onChange={(event) => update("options", event.target.value)}
            />
          </FormField>
        ) : null}
        <FormField className="min-h-11 flex-row items-center gap-2 xl:min-h-0">
          <Checkbox
            id={controlId("required")}
            checked={draft.required}
            onCheckedChange={(checked) => update("required", checked)}
          />
          <FieldLabel htmlFor={controlId("required")}>Required</FieldLabel>
        </FormField>
        <FormField data-invalid={Boolean(error) || undefined}>
          <FieldError className="text-xs">{error}</FieldError>
        </FormField>
        <ButtonGroup
          aria-label={`${field.name} field actions`}
          className="w-full flex-wrap justify-between"
        >
          <ButtonGroup aria-label={`${field.name} save actions`}>
            <Button
              size="sm"
              disabled={pending}
              onClick={async () => {
                const result = buildField(field, draft);
                if (typeof result === "string") setError(result);
                else {
                  const saved = await onSave(result);
                  if (!saved.ok) setError(saved.error);
                }
              }}
            >
              Save field changes
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => {
                setDraft(draftForField(field));
                setError("");
              }}
            >
              Cancel
            </Button>
          </ButtonGroup>
          <ButtonGroup
            aria-label={`${field.name} ordering and lifecycle actions`}
          >
            <Button
              size="icon"
              variant="outline"
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
              aria-label={`Move ${field.name} down`}
              disabled={pending || index === count - 1}
              onClick={async () => {
                const result = await onMove(1);
                if (!result.ok) setError(result.error);
              }}
            >
              <ArrowDown aria-hidden="true" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={async () => {
                const result = await onLifecycle();
                if (!result.ok) setError(result.error);
              }}
            >
              {field.closed ? "Reopen" : "Close"} field
            </Button>
          </ButtonGroup>
        </ButtonGroup>
      </fieldset>
    </FieldGroup>
  );
}

export function FieldDisclosure({
  field,
  selected,
  children,
}: {
  field: Field;
  selected: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(selected);

  useEffect(() => {
    if (selected) setOpen(true);
  }, [selected]);

  return (
    <Collapsible className="group" open={open} onOpenChange={setOpen}>
      <Card aria-label={`${field.name} field settings`} className="w-full">
        <CardHeader className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 p-3">
          <div className="min-w-0">
            <CardTitle className="truncate text-sm">{field.name}</CardTitle>
            <CardDescription className="mt-1">
              <Badge variant={field.closed ? "outline" : "secondary"}>
                {field.closed ? "Closed" : field.type}
              </Badge>
            </CardDescription>
          </div>
          <CollapsibleTrigger
            aria-label={`${open ? "Hide" : "Show"} ${field.name} settings`}
            render={<Button size="icon" variant="ghost" />}
          >
            <ChevronDown
              aria-hidden="true"
              className="transition-transform group-data-open:rotate-180 motion-reduce:transition-none"
            />
          </CollapsibleTrigger>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="border-t p-3">{children}</CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
