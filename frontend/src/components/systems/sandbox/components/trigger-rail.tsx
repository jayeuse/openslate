"use client";

import { useId, type ReactNode } from "react";
import { ListFilter, Plus, SquarePen, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type {
  SandboxDocumentDesign,
  SandboxDocumentField,
  SandboxTrigger,
  SandboxTriggerAction,
  SandboxTriggerCondition,
  SandboxValueSource,
} from "../domain/document";
import {
  addTriggerAction,
  addTriggerCondition,
  compatibleReferenceOptions,
  defaultLiteral,
  displayLiteral,
  fieldReferenceOptionValue,
  fieldsFor,
  firstOpenField,
  firstOpenModule,
  firstOpenNumberField,
  parseLiteral,
  replaceAt,
  scheduleFrequencyChange,
  triggerOrigin,
} from "../domain/trigger-rules";
import {
  TriggerEventIcon,
  actionsText,
  conditionsText,
  triggerOperatorOptions,
  triggerStatusWord,
  triggerText,
  weekdayOptions,
} from "./trigger-flow";

// The detail of one trigger (docs/specs/sandbox-relayout.md S5, S6): Name
// and Status as label-left rows, then When, If, and Then on one rail. The
// rail is the editor: each step shows its one-line summary and, under it,
// its own settings. It only renders the draft that `useTriggerDraft` owns.

type Change = (recordTrigger: SandboxTrigger) => void;

/**
 * A label-left row: a muted label column and the control on the right from
 * a 480px detail; narrower, the label sits above. The visible label can be
 * shorter than the control's name ("Module" names "Event module").
 */
function SettingRow({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <Field className="min-w-0 gap-1.5 @min-[30rem]/detail:grid @min-[30rem]/detail:min-h-10 @min-[30rem]/detail:grid-cols-[7rem_minmax(0,1fr)] @min-[30rem]/detail:items-center @min-[30rem]/detail:gap-x-4">
      <FieldLabel
        htmlFor={id}
        className="text-muted-foreground font-normal xl:text-sm"
      >
        {label}
      </FieldLabel>
      {children}
    </Field>
  );
}

function RailStep({
  name,
  summary,
  icon,
  last = false,
  children,
}: {
  name: string;
  summary: string;
  icon: ReactNode;
  last?: boolean;
  children: ReactNode;
}) {
  const headingId = useId();
  const summaryId = useId();
  return (
    <li className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3.5">
      <span aria-hidden="true" className="relative flex justify-center">
        <span className="text-muted-foreground z-[1] grid size-7 place-items-center rounded-full bg-[var(--surface-sunken)] [&_svg]:size-4">
          {icon}
        </span>
        {last ? null : (
          <span className="absolute top-[1.875rem] -bottom-1.5 w-px bg-[var(--rule-strong)]" />
        )}
      </span>
      <section
        aria-labelledby={headingId}
        aria-describedby={summaryId}
        className={cn("grid min-w-0 gap-2", !last && "pb-6")}
      >
        <div className="flex min-h-7 min-w-0 items-baseline gap-2.5">
          <h3 id={headingId} className="shrink-0 text-sm font-semibold">
            {name}
          </h3>
          <p
            id={summaryId}
            title={summary}
            className="text-muted-foreground min-w-0 truncate text-sm @max-[30rem]/detail:whitespace-normal"
          >
            {summary}
          </p>
        </div>
        {children}
      </section>
    </li>
  );
}

/** What Save will refuse in a step, under the settings it belongs to. */
function StepNote({ id, note }: { id: string; note: string | undefined }) {
  return note ? (
    <p id={id} className="text-warn-text text-xs">
      {note}
    </p>
  ) : null;
}

function ValueEditor({
  design,
  trigger: recordTrigger,
  target,
  value,
  onChange,
  layout,
}: {
  design: SandboxDocumentDesign;
  trigger: SandboxTrigger;
  target?: SandboxDocumentField | undefined;
  value: SandboxValueSource;
  onChange: (value: SandboxValueSource) => void;
  /** A label-left row (the When threshold), or a cell of an inline row. */
  layout: "row" | "inline";
}) {
  const id = useId();
  const references = compatibleReferenceOptions(design, recordTrigger, target);
  const label = value.kind === "literal" ? "Value" : "Another field";
  const named = layout === "inline" ? { "aria-label": label } : {};
  // Another field as the value is rare: one quiet toggle beside the value,
  // shown only when a compatible field exists.
  const sourceToggle = references[0] ? (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="text-muted-foreground shrink-0 px-2 font-normal max-xl:min-h-11"
      onClick={() =>
        onChange(
          value.kind === "literal"
            ? { kind: "field-reference", ...references[0]!.reference }
            : defaultLiteral(target),
        )
      }
    >
      {value.kind === "literal" ? "Use a field" : "Use fixed value"}
    </Button>
  ) : null;
  const control =
    value.kind === "field-reference" ? (
      <NativeSelect
        id={id}
        {...named}
        className="min-w-0 flex-1"
        value={fieldReferenceOptionValue(value)}
        onChange={(event) => {
          const option = references.find(
            (item) => item.value === event.target.value,
          );
          if (option)
            onChange({ kind: "field-reference", ...option.reference });
        }}
      >
        {references.map((option) => (
          <NativeSelectOption key={option.value} value={option.value}>
            {option.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    ) : target?.config.kind === "select" ? (
      <NativeSelect
        id={id}
        {...named}
        className="min-w-0 flex-1"
        value={typeof value.value === "string" ? value.value : ""}
        onChange={(event) =>
          onChange({ kind: "literal", value: event.target.value || null })
        }
      >
        <NativeSelectOption value="">Empty</NativeSelectOption>
        {target.config.options.map((option) => (
          <NativeSelectOption key={option.id} value={option.id}>
            {option.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    ) : target?.config.kind === "checkbox" ? (
      <NativeSelect
        id={id}
        {...named}
        className="min-w-0 flex-1"
        value={String(value.value)}
        onChange={(event) =>
          onChange({ kind: "literal", value: event.target.value === "true" })
        }
      >
        <NativeSelectOption value="true">Checked</NativeSelectOption>
        <NativeSelectOption value="false">Unchecked</NativeSelectOption>
      </NativeSelect>
    ) : target?.config.kind === "long-text" ? (
      <Textarea
        id={id}
        {...named}
        className="min-w-0 flex-1"
        value={displayLiteral(value.value)}
        required={target.required}
        maxLength={target.config.maxLength}
        onChange={(event) =>
          onChange({
            kind: "literal",
            value: parseLiteral(event.target.value, target),
          })
        }
      />
    ) : (
      <Input
        id={id}
        {...named}
        className="min-w-0 flex-1"
        type={
          target?.config.kind === "number" || target?.config.kind === "integer"
            ? "number"
            : target?.config.kind === "email"
              ? "email"
              : target?.config.kind === "url"
                ? "url"
                : target?.config.kind === "date"
                  ? "date"
                  : target?.config.kind === "datetime"
                    ? "datetime-local"
                    : "text"
        }
        value={displayLiteral(value.value)}
        required={target?.required}
        min={
          target?.config.kind === "number" || target?.config.kind === "integer"
            ? target.config.min
            : target?.config.kind === "date" ||
                target?.config.kind === "datetime"
              ? target.config.earliest
              : undefined
        }
        max={
          target?.config.kind === "number" || target?.config.kind === "integer"
            ? target.config.max
            : target?.config.kind === "date" ||
                target?.config.kind === "datetime"
              ? target.config.latest
              : undefined
        }
        step={
          target?.config.kind === "number" || target?.config.kind === "integer"
            ? target.config.step
            : undefined
        }
        maxLength={
          target?.config.kind === "text" ||
          target?.config.kind === "email" ||
          target?.config.kind === "url"
            ? target.config.maxLength
            : undefined
        }
        onChange={(event) =>
          onChange({
            kind: "literal",
            value: parseLiteral(event.target.value, target),
          })
        }
      />
    );
  const cell = (
    <div className="flex min-w-0 items-center gap-1">
      {control}
      {sourceToggle}
    </div>
  );
  return layout === "row" ? (
    <SettingRow id={id} label={label}>
      {cell}
    </SettingRow>
  ) : (
    cell
  );
}

function ModuleOptions({ design }: { design: SandboxDocumentDesign }) {
  return (
    <>
      {design.modules
        .filter((item) => !item.closed)
        .map((item) => (
          <NativeSelectOption key={item.id} value={item.id}>
            {item.name}
          </NativeSelectOption>
        ))}
    </>
  );
}

function FieldOptions({ fields }: { fields: readonly SandboxDocumentField[] }) {
  return (
    <>
      {fields.map((field) => (
        <NativeSelectOption key={field.id} value={field.id}>
          {field.name}
        </NativeSelectOption>
      ))}
    </>
  );
}

/** The remove control of an inline row: a quiet ×, named for its row. */
function RemoveButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      className="text-muted-foreground hover:text-danger-text size-11"
      onClick={onClick}
    >
      <X aria-hidden="true" />
    </Button>
  );
}

/** Adds a condition or an action, under the rows of its step. */
function AddButton({
  children,
  disabled,
  onClick,
}: {
  children: ReactNode;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="ghost"
      className="text-foreground -ml-2 min-h-11 justify-self-start"
      disabled={disabled}
      onClick={onClick}
    >
      <Plus aria-hidden="true" />
      {children}
    </Button>
  );
}

export function TriggerRail({
  design,
  trigger: recordTrigger,
  stepErrors,
  pending,
  locked,
  onChange,
}: {
  design: SandboxDocumentDesign;
  trigger: SandboxTrigger;
  /** Fixed values Save will refuse, by step (see `triggerStepErrors`). */
  stepErrors: ReadonlyMap<string, string>;
  pending: boolean;
  /** Read-only while kept edits wait; the fieldset does not reach Switch. */
  locked: boolean;
  onChange: Change;
}) {
  const nameId = useId();
  const statusId = useId();
  const statusWordId = useId();
  const statusNoteId = useId();
  return (
    <fieldset
      className="grid min-w-0 gap-5 border-0 p-0"
      disabled={pending}
      aria-busy={pending}
    >
      <div className="grid gap-3 @min-[30rem]/detail:gap-2">
        <SettingRow id={nameId} label="Name">
          <Input
            id={nameId}
            aria-label="Trigger name"
            value={recordTrigger.name}
            onChange={(event) =>
              onChange({ ...recordTrigger, name: event.target.value })
            }
          />
        </SettingRow>
        <SettingRow id={statusId} label="Status">
          {/* The word says the state the switch is in (S6); Off adds what
              that means for the published workspace. */}
          <div className="flex min-h-11 items-center gap-2.5 xl:min-h-8">
            <Switch
              id={statusId}
              aria-label="Trigger status"
              aria-describedby={
                recordTrigger.enabled
                  ? statusWordId
                  : `${statusWordId} ${statusNoteId}`
              }
              disabled={pending || locked}
              checked={recordTrigger.enabled}
              onCheckedChange={(checked) =>
                onChange({ ...recordTrigger, enabled: checked })
              }
            />
            <span
              id={statusWordId}
              className={cn(
                "text-sm font-medium",
                !recordTrigger.enabled && "text-muted-foreground",
              )}
            >
              {triggerStatusWord(recordTrigger.enabled)}
            </span>
            {recordTrigger.enabled ? null : (
              <span id={statusNoteId} className="text-muted-foreground text-sm">
                · won&apos;t run after publish
              </span>
            )}
          </div>
        </SettingRow>
      </div>
      <ol aria-label="Flow" className="grid min-w-0">
        <RailStep
          name="When"
          summary={triggerText(design, recordTrigger)}
          icon={<TriggerEventIcon kind={recordTrigger.trigger.kind} />}
        >
          <WhenSettings
            design={design}
            trigger={recordTrigger}
            note={stepErrors.get("trigger")}
            onChange={onChange}
          />
        </RailStep>
        <RailStep
          name="If"
          summary={conditionsText(design, recordTrigger)}
          icon={<ListFilter />}
        >
          <Conditions
            design={design}
            trigger={recordTrigger}
            stepErrors={stepErrors}
            onChange={onChange}
          />
        </RailStep>
        <RailStep
          name="Then"
          summary={actionsText(design, recordTrigger)}
          icon={<SquarePen />}
          last
        >
          <Actions
            design={design}
            trigger={recordTrigger}
            stepErrors={stepErrors}
            onChange={onChange}
          />
        </RailStep>
      </ol>
    </fieldset>
  );
}

function WhenSettings({
  design,
  trigger: recordTrigger,
  note,
  onChange,
}: {
  design: SandboxDocumentDesign;
  trigger: SandboxTrigger;
  note: string | undefined;
  onChange: Change;
}) {
  const eventId = useId();
  const moduleId = useId();
  const frequencyId = useId();
  const timeId = useId();
  const weekdayId = useId();
  const fieldId = useId();
  const operatorId = useId();
  const noteId = useId();
  const trigger = recordTrigger.trigger;
  const changeEvent = (kind: SandboxTrigger["trigger"]["kind"]) => {
    const firstModule = firstOpenModule(design);
    const field =
      kind === "threshold-crossed"
        ? firstOpenNumberField(design, firstModule)
        : firstOpenField(design, firstModule);
    const next =
      kind === "record-created"
        ? { kind, moduleId: firstModule }
        : kind === "field-changed"
          ? { kind, moduleId: firstModule, fieldId: field?.id ?? "" }
          : kind === "threshold-crossed"
            ? {
                kind,
                moduleId: firstModule,
                fieldId: field?.id ?? "",
                operator: ">=" as const,
                value: defaultLiteral(field),
              }
            : {
                kind: "schedule" as const,
                moduleId: firstModule,
                frequency: "daily" as const,
                time: "09:00",
              };
    onChange({ ...recordTrigger, trigger: next });
  };
  const changeModule = (nextModule: string) => {
    if (trigger.kind === "schedule") return;
    const field =
      trigger.kind === "threshold-crossed"
        ? firstOpenNumberField(design, nextModule)
        : firstOpenField(design, nextModule);
    const next =
      trigger.kind === "record-created"
        ? { kind: "record-created" as const, moduleId: nextModule }
        : trigger.kind === "field-changed"
          ? {
              kind: "field-changed" as const,
              moduleId: nextModule,
              fieldId: field?.id ?? "",
            }
          : {
              kind: "threshold-crossed" as const,
              moduleId: nextModule,
              fieldId: field?.id ?? "",
              operator: trigger.operator,
              value: trigger.value,
            };
    onChange({ ...recordTrigger, trigger: next });
  };
  const eventFields =
    trigger.kind === "field-changed" || trigger.kind === "threshold-crossed"
      ? fieldsFor(design, trigger.moduleId).filter(
          (item) =>
            !item.closed &&
            (trigger.kind !== "threshold-crossed" ||
              item.config.kind === "number" ||
              item.config.kind === "integer"),
        )
      : [];
  return (
    <div
      role="group"
      aria-label="When settings"
      aria-describedby={note ? noteId : undefined}
      className="grid min-w-0 gap-3 @min-[30rem]/detail:gap-2"
    >
      <SettingRow id={eventId} label="Event">
        <NativeSelect
          id={eventId}
          className="w-full"
          value={trigger.kind}
          onChange={(event) =>
            changeEvent(event.target.value as SandboxTrigger["trigger"]["kind"])
          }
        >
          <NativeSelectOption value="record-created">
            Item added
          </NativeSelectOption>
          <NativeSelectOption value="field-changed">
            Field changed
          </NativeSelectOption>
          <NativeSelectOption value="threshold-crossed">
            Threshold crossed
          </NativeSelectOption>
          <NativeSelectOption value="schedule">Schedule</NativeSelectOption>
        </NativeSelect>
      </SettingRow>
      {trigger.kind === "schedule" ? (
        <>
          <SettingRow id={moduleId} label="Module">
            <NativeSelect
              id={moduleId}
              className="w-full"
              value={trigger.moduleId ?? ""}
              onChange={(event) =>
                onChange({
                  ...recordTrigger,
                  trigger: { ...trigger, moduleId: event.target.value },
                })
              }
            >
              <NativeSelectOption value="">Choose module</NativeSelectOption>
              <ModuleOptions design={design} />
            </NativeSelect>
          </SettingRow>
          <SettingRow id={frequencyId} label="Frequency">
            <NativeSelect
              id={frequencyId}
              className="w-full"
              value={trigger.frequency}
              onChange={(event) =>
                onChange({
                  ...recordTrigger,
                  trigger: scheduleFrequencyChange(
                    trigger,
                    event.target.value as "daily" | "weekly",
                  ),
                })
              }
            >
              <NativeSelectOption value="daily">Daily</NativeSelectOption>
              <NativeSelectOption value="weekly">Weekly</NativeSelectOption>
            </NativeSelect>
          </SettingRow>
          {trigger.frequency === "weekly" ? (
            <SettingRow id={weekdayId} label="Weekday">
              <NativeSelect
                id={weekdayId}
                className="w-full"
                value={String(trigger.weekday ?? 1)}
                onChange={(event) =>
                  onChange({
                    ...recordTrigger,
                    trigger: {
                      ...trigger,
                      weekday: Number(event.target.value),
                    },
                  })
                }
              >
                {weekdayOptions.map((weekday) => (
                  <NativeSelectOption key={weekday.value} value={weekday.value}>
                    {weekday.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </SettingRow>
          ) : null}
          <SettingRow id={timeId} label="Time">
            <Input
              id={timeId}
              type="time"
              className="max-w-40"
              value={trigger.time}
              onChange={(event) =>
                onChange({
                  ...recordTrigger,
                  trigger: { ...trigger, time: event.target.value },
                })
              }
            />
          </SettingRow>
        </>
      ) : (
        <SettingRow id={moduleId} label="Module">
          <NativeSelect
            id={moduleId}
            aria-label="Event module"
            className="w-full"
            value={triggerOrigin(recordTrigger, design)}
            onChange={(event) => changeModule(event.target.value)}
          >
            <ModuleOptions design={design} />
          </NativeSelect>
        </SettingRow>
      )}
      {trigger.kind === "field-changed" ||
      trigger.kind === "threshold-crossed" ? (
        <SettingRow id={fieldId} label="Field">
          <NativeSelect
            id={fieldId}
            aria-label="Event field"
            className="w-full"
            value={trigger.fieldId}
            onChange={(event) => {
              const nextField = eventFields.find(
                (item) => item.id === event.target.value,
              );
              onChange({
                ...recordTrigger,
                trigger:
                  trigger.kind === "field-changed"
                    ? { ...trigger, fieldId: event.target.value }
                    : {
                        ...trigger,
                        fieldId: event.target.value,
                        value: defaultLiteral(nextField),
                      },
              });
            }}
          >
            <FieldOptions fields={eventFields} />
          </NativeSelect>
        </SettingRow>
      ) : null}
      {trigger.kind === "threshold-crossed" ? (
        <>
          <SettingRow id={operatorId} label="Operator">
            <NativeSelect
              id={operatorId}
              aria-label="Threshold operator"
              className="w-full"
              value={trigger.operator}
              onChange={(event) =>
                onChange({
                  ...recordTrigger,
                  trigger: {
                    ...trigger,
                    operator: event.target
                      .value as SandboxTriggerCondition["operator"],
                  },
                })
              }
            >
              {triggerOperatorOptions.map((operator) => (
                <NativeSelectOption key={operator.value} value={operator.value}>
                  {operator.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </SettingRow>
          <ValueEditor
            layout="row"
            design={design}
            trigger={recordTrigger}
            target={eventFields.find((item) => item.id === trigger.fieldId)}
            value={trigger.value}
            onChange={(value) =>
              onChange({ ...recordTrigger, trigger: { ...trigger, value } })
            }
          />
        </>
      ) : null}
      <StepNote id={noteId} note={note} />
    </div>
  );
}

// An inline row from a 544px detail: field, operator or word, value, and ×.
// Narrower, the field and × share the first line and the rest stack.
const inlineRow =
  "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 @min-[34rem]/detail:grid-cols-[minmax(0,1fr)_7rem_minmax(0,1.4fr)_auto]";
const firstCell =
  "col-start-1 row-start-1 @min-[34rem]/detail:col-start-1 @min-[34rem]/detail:row-start-1";
const secondCell =
  "col-start-1 row-start-2 @min-[34rem]/detail:col-start-2 @min-[34rem]/detail:row-start-1";
const valueCell =
  "col-start-1 row-start-3 @min-[34rem]/detail:col-start-3 @min-[34rem]/detail:row-start-1";
const removeCell =
  "col-start-2 row-start-1 @min-[34rem]/detail:col-start-4 @min-[34rem]/detail:row-start-1";

function Conditions({
  design,
  trigger: recordTrigger,
  stepErrors,
  onChange,
}: {
  design: SandboxDocumentDesign;
  trigger: SandboxTrigger;
  stepErrors: ReadonlyMap<string, string>;
  onChange: Change;
}) {
  const baseId = useId();
  const moduleId = triggerOrigin(recordTrigger, design);
  const fields = fieldsFor(design, moduleId).filter((field) => !field.closed);
  const conditions = recordTrigger.conditionGroup.conditions;
  const update = (index: number, condition: SandboxTriggerCondition) =>
    onChange({
      ...recordTrigger,
      conditionGroup: {
        ...recordTrigger.conditionGroup,
        conditions: replaceAt(conditions, index, condition),
      },
    });
  return (
    <div className="grid min-w-0 gap-2">
      {/* All or Any matters only from two conditions. */}
      {conditions.length >= 2 ? (
        <NativeSelect
          aria-label="Condition group operator"
          className="w-full max-w-60"
          value={recordTrigger.conditionGroup.operator}
          onChange={(event) =>
            onChange({
              ...recordTrigger,
              conditionGroup: {
                ...recordTrigger.conditionGroup,
                operator: event.target.value as "all" | "any",
              },
            })
          }
        >
          <NativeSelectOption value="all">
            All conditions match
          </NativeSelectOption>
          <NativeSelectOption value="any">
            Any condition matches
          </NativeSelectOption>
        </NativeSelect>
      ) : null}
      {conditions.map((condition, index) => {
        const sameModule = condition.field.moduleId === moduleId;
        const target = sameModule
          ? fieldsFor(design, moduleId).find(
              (field) => field.id === condition.field.fieldId,
            )
          : firstOpenField(design, moduleId);
        const note = stepErrors.get(`condition:${condition.id}`);
        const noteId = `${baseId}-condition-${index}`;
        return (
          <div
            key={condition.id}
            role="group"
            aria-label={`Condition ${index + 1}`}
            aria-describedby={note ? noteId : undefined}
            className="grid min-w-0 gap-1"
          >
            <div className={inlineRow}>
              <NativeSelect
                aria-label={`Condition ${index + 1} field`}
                className={cn("w-full", firstCell)}
                value={
                  sameModule ? condition.field.fieldId : (target?.id ?? "")
                }
                onChange={(event) => {
                  const field = fields.find(
                    (item) => item.id === event.target.value,
                  );
                  update(index, {
                    ...condition,
                    field: { moduleId, fieldId: event.target.value },
                    value: defaultLiteral(field),
                  });
                }}
              >
                <FieldOptions fields={fields} />
              </NativeSelect>
              <NativeSelect
                aria-label={`Condition ${index + 1} operator`}
                className={cn("w-full", secondCell)}
                value={condition.operator}
                onChange={(event) =>
                  update(index, {
                    ...condition,
                    operator: event.target
                      .value as SandboxTriggerCondition["operator"],
                  })
                }
              >
                {triggerOperatorOptions.map((operator) => (
                  <NativeSelectOption
                    key={operator.value}
                    value={operator.value}
                  >
                    {operator.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <div className={cn("min-w-0", valueCell)}>
                <ValueEditor
                  layout="inline"
                  design={design}
                  trigger={recordTrigger}
                  target={target}
                  value={condition.value}
                  onChange={(value) => update(index, { ...condition, value })}
                />
              </div>
              <div className={removeCell}>
                <RemoveButton
                  label={`Remove condition ${index + 1}`}
                  onClick={() =>
                    onChange({
                      ...recordTrigger,
                      conditionGroup: {
                        ...recordTrigger.conditionGroup,
                        conditions: conditions.filter(
                          (item) => item.id !== condition.id,
                        ),
                      },
                    })
                  }
                />
              </div>
            </div>
            <StepNote id={noteId} note={note} />
          </div>
        );
      })}
      <AddButton
        disabled={conditions.length >= 20}
        onClick={() => onChange(addTriggerCondition(recordTrigger, design))}
      >
        Add condition
      </AddButton>
    </div>
  );
}

function Actions({
  design,
  trigger: recordTrigger,
  stepErrors,
  onChange,
}: {
  design: SandboxDocumentDesign;
  trigger: SandboxTrigger;
  stepErrors: ReadonlyMap<string, string>;
  onChange: Change;
}) {
  const baseId = useId();
  const moduleId = triggerOrigin(recordTrigger, design);
  const fields = fieldsFor(design, moduleId).filter((field) => !field.closed);
  const update = (index: number, action: SandboxTriggerAction) =>
    onChange({
      ...recordTrigger,
      actions: replaceAt(recordTrigger.actions, index, action),
    });
  return (
    <div className="grid min-w-0 gap-2">
      {recordTrigger.actions.map((action, index) => {
        const note = stepErrors.get(`action:${action.id}`);
        const noteId = `${baseId}-action-${index}`;
        const remove = (
          <div className={removeCell}>
            <RemoveButton
              label={`Remove action ${index + 1}`}
              onClick={() =>
                onChange({
                  ...recordTrigger,
                  actions: recordTrigger.actions.filter(
                    (item) => item.id !== action.id,
                  ),
                })
              }
            />
          </div>
        );
        if (action.kind !== "set-field")
          return (
            <div
              key={action.id}
              role="group"
              aria-label={`Action ${index + 1}`}
              className="grid min-w-0 gap-2"
            >
              <div className="flex min-w-0 items-center justify-between gap-2">
                <p className="text-warn-text min-w-0 text-sm font-medium">
                  {`${action.kind.charAt(0).toUpperCase()}${action.kind.slice(1)} · can't publish yet`}
                </p>
                {remove}
              </div>
              <Alert variant="destructive" role="alert">
                This imported action is not supported for publishing. Remove it
                or replace it with Set field.
              </Alert>
            </div>
          );
        const sameModule = action.target.moduleId === moduleId;
        const target = sameModule
          ? fieldsFor(design, moduleId).find(
              (field) => field.id === action.target.fieldId,
            )
          : firstOpenField(design, moduleId);
        return (
          <div
            key={action.id}
            role="group"
            aria-label={`Action ${index + 1}`}
            aria-describedby={note ? noteId : undefined}
            className="grid min-w-0 gap-1"
          >
            <div className={inlineRow}>
              <NativeSelect
                aria-label="Set field target"
                className={cn("w-full", firstCell)}
                value={sameModule ? action.target.fieldId : (target?.id ?? "")}
                onChange={(event) => {
                  const field = fields.find(
                    (item) => item.id === event.target.value,
                  );
                  update(index, {
                    ...action,
                    target: { moduleId, fieldId: event.target.value },
                    value: defaultLiteral(field),
                  });
                }}
              >
                <FieldOptions fields={fields} />
              </NativeSelect>
              <span
                aria-hidden="true"
                className="text-muted-foreground hidden text-center text-sm @min-[34rem]/detail:col-start-2 @min-[34rem]/detail:row-start-1 @min-[34rem]/detail:block"
              >
                set to
              </span>
              {/* Narrower, the hidden "set to" frees the second line. */}
              <div className="col-start-1 row-start-2 min-w-0 @min-[34rem]/detail:col-start-3 @min-[34rem]/detail:row-start-1">
                <ValueEditor
                  layout="inline"
                  design={design}
                  trigger={recordTrigger}
                  target={target}
                  value={action.value}
                  onChange={(value) => update(index, { ...action, value })}
                />
              </div>
              {remove}
            </div>
            <StepNote id={noteId} note={note} />
          </div>
        );
      })}
      <AddButton
        disabled={recordTrigger.actions.length >= 20}
        onClick={() => onChange(addTriggerAction(recordTrigger, design))}
      >
        Add action
      </AddButton>
    </div>
  );
}
