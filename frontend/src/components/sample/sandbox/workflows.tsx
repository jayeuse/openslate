import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field as FormField,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { useSampleState } from "@/components/sample/sample-state";
import { initialRoles, type Role } from "@/components/sample/access/model";
import {
  SandboxCommandError,
  type SandboxCommandResult,
  type SandboxSimulationUpdate,
} from "./async";
import { cn } from "@/lib/utils";
import {
  changesFrom,
  counts,
  normalizeField,
  normalizeRule,
  reorder,
  ruleConfigLabels,
  uid,
  type Design,
  type Field,
  type DesignUpdate,
  type Rule,
  type RuleAction,
  type RuleCondition,
  type RuleConfig,
  type RuleOperator,
  type RuleTrigger,
  type Version,
} from "./model";
import { validateFieldValue, validateSandboxDesign } from "./validation";
import type { SandboxCreateRequest } from "./sandbox-controls";
type Props = {
  section: string;
  design: Design;
  change: (d: DesignUpdate) => Promise<SandboxCommandResult<Design>>;
  versions: Version[];
  simulation: unknown;
  updateVersions: (
    update: (current: Version[]) => Version[],
  ) => Promise<SandboxCommandResult<Version[]>>;
  updateSimulation: (
    update: SandboxSimulationUpdate,
    commandKey?: string,
  ) => Promise<SandboxCommandResult<unknown>>;
  restoreVersion: (id: string) => Promise<SandboxCommandResult<Version>>;
  rollbackVersion: (
    id: string,
  ) => Promise<SandboxCommandResult<{ version: Version; release: Version }>>;
  deleteVersion: (id: string) => Promise<
    SandboxCommandResult<{
      version: Version;
      index: number;
      versions: Version[];
    }>
  >;
  restoreDeletedVersion: (
    version: Version,
    index: number,
  ) => Promise<SandboxCommandResult<Version[]>>;
  navigate: (s: string) => void;
  notify: (s: string) => void;
  createRequest: SandboxCreateRequest | null;
  onCreateRequestHandled: (id: number) => void;
  requestedRuleId?: string | null;
  pending: boolean;
};
type SimulationValue = string | boolean;
type SimulationRecord = {
  id: string;
  moduleId: string;
  values: Record<string, SimulationValue>;
};
type SimulationTrace = {
  id: string;
  ruleId: string;
  rule: string;
  status: "Matched" | "Skipped" | "Error";
  detail: string;
};
type Simulation = {
  records: SimulationRecord[];
  users: { id: string; name: string; role: string }[];
  trace: SimulationTrace[];
  runs: { id: string; ruleId?: string; rule: string; result: string }[];
  snapshot?: {
    moduleId: string;
    before: Record<string, SimulationValue>;
    after: Record<string, SimulationValue>;
  };
};
const empty: Simulation = { records: [], users: [], trace: [], runs: [] };

function versionFingerprint(versions: Version[]): string {
  return JSON.stringify(versions);
}

type RuleDraft = { name: string; config: RuleConfig };
const operators: RuleOperator[] = [">", ">=", "<", "<=", "=", "!="];

function defaultRuleDraft(design: Design): RuleDraft {
  const sandboxModule = design.modules.find((item) => !item.closed);
  return {
    name: "",
    config: {
      trigger: { kind: "new-record", moduleId: sandboxModule?.id ?? "" },
      condition: { kind: "always" },
      action: { kind: "notification", message: "" },
    },
  };
}

function ruleDraft(rule: Rule, design: Design): RuleDraft {
  const normalized = normalizeRule(rule, design);
  return { name: normalized.name, config: structuredClone(normalized.config) };
}

function ruleFromDraft(draft: RuleDraft, design: Design, id = uid()): Rule {
  const labels = ruleConfigLabels(draft.config, design);
  return {
    id,
    name: draft.name.trim(),
    trigger: labels.trigger,
    condition: labels.condition,
    action: labels.action,
    enabled: true,
    config: draft.config,
  };
}

function moduleFields(design: Design, moduleId: string): Field[] {
  return design.modules.find((item) => item.id === moduleId)?.fields ?? [];
}

function normalizeSimulation(value: unknown, design: Design): Simulation {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return empty;
  const source = value as Record<string, unknown>;
  const users = Array.isArray(source.users)
    ? source.users.filter(
        (item): item is Simulation["users"][number] =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as Record<string, unknown>).id === "string" &&
          typeof (item as Record<string, unknown>).name === "string" &&
          typeof (item as Record<string, unknown>).role === "string",
      )
    : [];
  const runs = Array.isArray(source.runs)
    ? source.runs.filter(
        (item): item is Simulation["runs"][number] =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as Record<string, unknown>).id === "string" &&
          typeof (item as Record<string, unknown>).rule === "string" &&
          typeof (item as Record<string, unknown>).result === "string" &&
          ((item as Record<string, unknown>).ruleId === undefined ||
            typeof (item as Record<string, unknown>).ruleId === "string"),
      )
    : [];
  const trace = Array.isArray(source.trace)
    ? source.trace.filter((item): item is SimulationTrace => {
        if (typeof item !== "object" || item === null) return false;
        const entry = item as Record<string, unknown>;
        return (
          typeof entry.id === "string" &&
          typeof entry.ruleId === "string" &&
          typeof entry.rule === "string" &&
          ["Matched", "Skipped", "Error"].includes(String(entry.status)) &&
          typeof entry.detail === "string"
        );
      })
    : [];
  const records: SimulationRecord[] = [];
  if (Array.isArray(source.records)) {
    for (const item of source.records) {
      if (typeof item !== "object" || item === null || Array.isArray(item))
        continue;
      const record = item as Record<string, unknown>;
      if (
        typeof record.id === "string" &&
        typeof record.moduleId === "string" &&
        typeof record.values === "object" &&
        record.values !== null &&
        !Array.isArray(record.values)
      ) {
        records.push({
          id: record.id,
          moduleId: record.moduleId,
          values: Object.fromEntries(
            Object.entries(record.values as Record<string, unknown>).filter(
              (entry): entry is [string, SimulationValue] =>
                typeof entry[1] === "string" || typeof entry[1] === "boolean",
            ),
          ),
        });
        continue;
      }
      const sandboxModule = design.modules.find(
        (module) => module.id === "sample-requests",
      );
      if (!sandboxModule || typeof record.id !== "string") continue;
      const values: Record<string, SimulationValue> = {};
      for (const field of sandboxModule.fields) {
        const legacy = record[field.name.toLowerCase()];
        if (typeof legacy === "string" || typeof legacy === "boolean")
          values[field.id] = legacy;
      }
      records.push({ id: record.id, moduleId: sandboxModule.id, values });
    }
  }
  let snapshot: Simulation["snapshot"];
  if (
    typeof source.snapshot === "object" &&
    source.snapshot !== null &&
    !Array.isArray(source.snapshot)
  ) {
    const candidate = source.snapshot as Record<string, unknown>;
    if (
      typeof candidate.moduleId === "string" &&
      typeof candidate.before === "object" &&
      candidate.before !== null &&
      !Array.isArray(candidate.before) &&
      typeof candidate.after === "object" &&
      candidate.after !== null &&
      !Array.isArray(candidate.after)
    ) {
      const safeValues = (values: object) =>
        Object.fromEntries(
          Object.entries(values).filter(
            (entry): entry is [string, SimulationValue] =>
              typeof entry[1] === "string" || typeof entry[1] === "boolean",
          ),
        );
      snapshot = {
        moduleId: candidate.moduleId,
        before: safeValues(candidate.before),
        after: safeValues(candidate.after),
      };
    }
  }
  return { records, users, trace, runs, ...(snapshot ? { snapshot } : {}) };
}

function LabeledField({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: (controlId: string) => ReactNode;
}) {
  const controlId = useId();
  return (
    <FormField className={className}>
      <FieldLabel htmlFor={controlId} className="text-xs">
        {label}
      </FieldLabel>
      {children(controlId)}
    </FormField>
  );
}

function Choice({
  label,
  value,
  options,
  onChange,
  renderOption = (option) => option,
  required = false,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (s: string) => void | PromiseLike<void>;
  renderOption?: (option: string) => string;
  required?: boolean;
}) {
  return (
    <LabeledField label={label}>
      {(controlId) => (
        <NativeSelect
          id={controlId}
          className="w-full [&_select]:min-h-11"
          value={value}
          required={required}
          onChange={(event) => void onChange(event.target.value)}
        >
          {options.map((option) => (
            <NativeSelectOption key={option} value={option}>
              {renderOption(option)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      )}
    </LabeledField>
  );
}

function ModuleChoice({
  label,
  design,
  value,
  onChange,
}: {
  label: string;
  design: Design;
  value: string;
  onChange: (moduleId: string) => void;
}) {
  return (
    <Choice
      label={label}
      value={value}
      onChange={onChange}
      options={design.modules.map((item) => item.id)}
      renderOption={(id) =>
        design.modules.find((item) => item.id === id)?.name ?? id
      }
    />
  );
}

function FieldChoice({
  label,
  design,
  moduleId,
  value,
  onChange,
}: {
  label: string;
  design: Design;
  moduleId: string;
  value: string;
  onChange: (fieldId: string) => void;
}) {
  return (
    <Choice
      label={label}
      value={value}
      onChange={onChange}
      options={moduleFields(design, moduleId).map((item) => item.id)}
      renderOption={(id) =>
        moduleFields(design, moduleId).find((item) => item.id === id)?.name ??
        id
      }
    />
  );
}

function RuleValueControl({
  label,
  field,
  value,
  onChange,
}: {
  label: string;
  field: Field | undefined;
  value: string;
  onChange: (value: string) => void;
}) {
  if (!field)
    return (
      <LabeledField label={label}>
        {(controlId) => (
          <Input
            id={controlId}
            required
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        )}
      </LabeledField>
    );
  const config = normalizeField(field).config;
  if (config.kind === "checkbox")
    return (
      <Choice
        label={label}
        value={value}
        onChange={onChange}
        options={["true", "false"]}
        renderOption={(option) => (option === "true" ? "Checked" : "Unchecked")}
      />
    );
  if (config.kind === "select")
    return (
      <Choice
        label={label}
        value={value}
        onChange={onChange}
        options={config.options}
      />
    );
  if (config.kind === "long-text")
    return (
      <LabeledField label={label}>
        {(controlId) => (
          <Textarea
            id={controlId}
            required
            value={value}
            maxLength={config.maxLength}
            onChange={(event) => onChange(event.target.value)}
          />
        )}
      </LabeledField>
    );
  const type =
    config.kind === "number" || config.kind === "integer"
      ? "number"
      : config.kind === "datetime"
        ? "datetime-local"
        : config.kind;
  return (
    <LabeledField label={label}>
      {(controlId) => (
        <Input
          id={controlId}
          required
          type={type}
          value={value}
          min={
            config.kind === "number" || config.kind === "integer"
              ? config.min
              : config.kind === "date" || config.kind === "datetime"
                ? config.earliest
                : undefined
          }
          max={
            config.kind === "number" || config.kind === "integer"
              ? config.max
              : config.kind === "date" || config.kind === "datetime"
                ? config.latest
                : undefined
          }
          step={
            config.kind === "integer"
              ? 1
              : config.kind === "number"
                ? config.step
                : undefined
          }
          maxLength={
            config.kind === "text" ||
            config.kind === "email" ||
            config.kind === "url"
              ? config.maxLength
              : undefined
          }
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </LabeledField>
  );
}

function RuleEditor({
  mode,
  design,
  initial,
  onSave,
  onCancel,
  pending,
}: {
  mode: "create" | "edit";
  design: Design;
  initial: RuleDraft;
  onSave: (draft: RuleDraft) => Promise<string | null>;
  onCancel: () => void;
  pending: boolean;
}) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState("");
  const trigger = draft.config.trigger;
  const condition = draft.config.condition;
  const action = draft.config.action;
  const firstModuleId = design.modules[0]?.id ?? "";
  const firstFieldId = (moduleId: string) =>
    moduleFields(design, moduleId)[0]?.id ?? "";
  function setTriggerKind(kind: RuleTrigger["kind"]) {
    const moduleId = firstModuleId;
    const fieldId = firstFieldId(moduleId);
    const next: RuleTrigger =
      kind === "new-record"
        ? { kind, moduleId }
        : kind === "field-change"
          ? { kind, moduleId, fieldId }
          : kind === "threshold"
            ? { kind, moduleId, fieldId, operator: ">=", value: "" }
            : { kind, frequency: "daily", time: "09:00" };
    setDraft({ ...draft, config: { ...draft.config, trigger: next } });
  }
  function setConditionKind(kind: RuleCondition["kind"]) {
    const moduleId = firstModuleId;
    setDraft({
      ...draft,
      config: {
        ...draft.config,
        condition:
          kind === "always"
            ? { kind }
            : {
                kind,
                moduleId,
                fieldId: firstFieldId(moduleId),
                operator: "=",
                value: "",
              },
      },
    });
  }
  function setActionKind(kind: RuleAction["kind"]) {
    const moduleId = firstModuleId;
    const fieldId = firstFieldId(moduleId);
    const next: RuleAction =
      kind === "notification"
        ? { kind, message: "" }
        : kind === "channel-message"
          ? { kind, channel: "" }
          : kind === "assign-task"
            ? { kind, assignee: "" }
            : { kind, moduleId, fieldId, value: "" };
    setDraft({ ...draft, config: { ...draft.config, action: next } });
  }
  return (
    <Card>
      <form
        aria-label={`${mode === "create" ? "Create" : "Edit"} automation rule`}
        onSubmit={async (event) => {
          event.preventDefault();
          if (pending) return;
          const message = await onSave(draft);
          setError(message ?? "");
        }}
      >
        <fieldset
          disabled={pending}
          aria-busy={pending || undefined}
          className="contents"
        >
          <CardContent>
            <FieldGroup className="grid gap-4 md:grid-cols-2">
              <LabeledField label="Rule name">
                {(controlId) => (
                  <Input
                    id={controlId}
                    autoFocus
                    required
                    maxLength={80}
                    value={draft.name}
                    onChange={(event) =>
                      setDraft({ ...draft, name: event.target.value })
                    }
                  />
                )}
              </LabeledField>
              <Choice
                label="Trigger"
                value={trigger.kind}
                onChange={(value) =>
                  setTriggerKind(value as RuleTrigger["kind"])
                }
                options={[
                  "new-record",
                  "field-change",
                  "threshold",
                  "schedule",
                ]}
                renderOption={(value) =>
                  ({
                    "new-record": "New record",
                    "field-change": "Field change",
                    threshold: "Threshold",
                    schedule: "Schedule",
                  })[value] ?? value
                }
              />
              {trigger.kind !== "schedule" && (
                <ModuleChoice
                  label="Trigger module"
                  design={design}
                  value={trigger.moduleId}
                  onChange={(moduleId) =>
                    setDraft({
                      ...draft,
                      config: {
                        ...draft.config,
                        trigger:
                          trigger.kind === "new-record"
                            ? { ...trigger, moduleId }
                            : {
                                ...trigger,
                                moduleId,
                                fieldId: firstFieldId(moduleId),
                              },
                      },
                    })
                  }
                />
              )}
              {(trigger.kind === "field-change" ||
                trigger.kind === "threshold") && (
                <FieldChoice
                  label="Trigger field"
                  design={design}
                  moduleId={trigger.moduleId}
                  value={trigger.fieldId}
                  onChange={(fieldId) =>
                    setDraft({
                      ...draft,
                      config: {
                        ...draft.config,
                        trigger: { ...trigger, fieldId },
                      },
                    })
                  }
                />
              )}
              {trigger.kind === "threshold" && (
                <>
                  <Choice
                    label="Threshold operator"
                    value={trigger.operator}
                    onChange={(operator) =>
                      setDraft({
                        ...draft,
                        config: {
                          ...draft.config,
                          trigger: {
                            ...trigger,
                            operator: operator as RuleOperator,
                          },
                        },
                      })
                    }
                    options={operators}
                  />
                  <RuleValueControl
                    label="Threshold value"
                    field={moduleFields(design, trigger.moduleId).find(
                      (field) => field.id === trigger.fieldId,
                    )}
                    value={trigger.value}
                    onChange={(value) =>
                      setDraft({
                        ...draft,
                        config: {
                          ...draft.config,
                          trigger: { ...trigger, value },
                        },
                      })
                    }
                  />
                </>
              )}
              {trigger.kind === "schedule" && (
                <>
                  <Choice
                    label="Schedule frequency"
                    value={trigger.frequency}
                    onChange={(frequency) =>
                      setDraft({
                        ...draft,
                        config: {
                          ...draft.config,
                          trigger: {
                            ...trigger,
                            frequency: frequency as "daily" | "weekly",
                            ...(frequency === "weekly"
                              ? { weekday: trigger.weekday ?? 1 }
                              : { weekday: undefined }),
                          },
                        },
                      })
                    }
                    options={["daily", "weekly"]}
                    renderOption={(value) =>
                      value === "daily" ? "Daily" : "Weekly"
                    }
                  />
                  {trigger.frequency === "weekly" && (
                    <Choice
                      label="Schedule weekday"
                      value={String(trigger.weekday ?? 1)}
                      onChange={(weekday) =>
                        setDraft({
                          ...draft,
                          config: {
                            ...draft.config,
                            trigger: { ...trigger, weekday: Number(weekday) },
                          },
                        })
                      }
                      options={["1", "2", "3", "4", "5", "6", "7"]}
                      renderOption={(value) =>
                        [
                          "Monday",
                          "Tuesday",
                          "Wednesday",
                          "Thursday",
                          "Friday",
                          "Saturday",
                          "Sunday",
                        ][Number(value) - 1]
                      }
                    />
                  )}
                  <LabeledField label="Schedule time">
                    {(controlId) => (
                      <Input
                        id={controlId}
                        type="time"
                        required
                        value={trigger.time}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            config: {
                              ...draft.config,
                              trigger: { ...trigger, time: event.target.value },
                            },
                          })
                        }
                      />
                    )}
                  </LabeledField>
                </>
              )}
              <Choice
                label="Condition"
                value={condition.kind}
                onChange={(value) =>
                  setConditionKind(value as RuleCondition["kind"])
                }
                options={["always", "field-comparison"]}
                renderOption={(value) =>
                  value === "always" ? "Always" : "Field comparison"
                }
              />
              {condition.kind === "field-comparison" && (
                <>
                  <ModuleChoice
                    label="Condition module"
                    design={design}
                    value={condition.moduleId}
                    onChange={(moduleId) =>
                      setDraft({
                        ...draft,
                        config: {
                          ...draft.config,
                          condition: {
                            ...condition,
                            moduleId,
                            fieldId: firstFieldId(moduleId),
                          },
                        },
                      })
                    }
                  />
                  <FieldChoice
                    label="Condition field"
                    design={design}
                    moduleId={condition.moduleId}
                    value={condition.fieldId}
                    onChange={(fieldId) =>
                      setDraft({
                        ...draft,
                        config: {
                          ...draft.config,
                          condition: { ...condition, fieldId },
                        },
                      })
                    }
                  />
                  <Choice
                    label="Condition operator"
                    value={condition.operator}
                    onChange={(operator) =>
                      setDraft({
                        ...draft,
                        config: {
                          ...draft.config,
                          condition: {
                            ...condition,
                            operator: operator as RuleOperator,
                          },
                        },
                      })
                    }
                    options={operators}
                  />
                  <RuleValueControl
                    label="Condition value"
                    field={moduleFields(design, condition.moduleId).find(
                      (field) => field.id === condition.fieldId,
                    )}
                    value={condition.value}
                    onChange={(value) =>
                      setDraft({
                        ...draft,
                        config: {
                          ...draft.config,
                          condition: { ...condition, value },
                        },
                      })
                    }
                  />
                </>
              )}
              <Choice
                label="Action"
                value={action.kind}
                onChange={(value) => setActionKind(value as RuleAction["kind"])}
                options={[
                  "notification",
                  "channel-message",
                  "create-record",
                  "update-field",
                  "assign-task",
                ]}
                renderOption={(value) =>
                  ({
                    notification: "Send a notification",
                    "channel-message": "Send a channel message",
                    "create-record": "Create a record",
                    "update-field": "Update a field",
                    "assign-task": "Assign a task",
                  })[value] ?? value
                }
              />
              {action.kind === "notification" && (
                <LabeledField label="Notification message">
                  {(controlId) => (
                    <Textarea
                      id={controlId}
                      required
                      maxLength={1000}
                      value={action.message}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          config: {
                            ...draft.config,
                            action: { ...action, message: event.target.value },
                          },
                        })
                      }
                    />
                  )}
                </LabeledField>
              )}
              {action.kind === "channel-message" && (
                <LabeledField label="Channel">
                  {(controlId) => (
                    <Input
                      id={controlId}
                      required
                      value={action.channel}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          config: {
                            ...draft.config,
                            action: { ...action, channel: event.target.value },
                          },
                        })
                      }
                    />
                  )}
                </LabeledField>
              )}
              {(action.kind === "create-record" ||
                action.kind === "update-field") && (
                <>
                  <ModuleChoice
                    label="Action module"
                    design={design}
                    value={action.moduleId}
                    onChange={(moduleId) =>
                      setDraft({
                        ...draft,
                        config: {
                          ...draft.config,
                          action: {
                            ...action,
                            moduleId,
                            fieldId: firstFieldId(moduleId),
                          },
                        },
                      })
                    }
                  />
                  <FieldChoice
                    label="Action field"
                    design={design}
                    moduleId={action.moduleId}
                    value={action.fieldId}
                    onChange={(fieldId) =>
                      setDraft({
                        ...draft,
                        config: {
                          ...draft.config,
                          action: { ...action, fieldId },
                        },
                      })
                    }
                  />
                  <RuleValueControl
                    label="Action value"
                    field={moduleFields(design, action.moduleId).find(
                      (field) => field.id === action.fieldId,
                    )}
                    value={action.value}
                    onChange={(value) =>
                      setDraft({
                        ...draft,
                        config: {
                          ...draft.config,
                          action: { ...action, value },
                        },
                      })
                    }
                  />
                </>
              )}
              {action.kind === "assign-task" && (
                <LabeledField label="Assignee">
                  {(controlId) => (
                    <Input
                      id={controlId}
                      required
                      value={action.assignee}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          config: {
                            ...draft.config,
                            action: { ...action, assignee: event.target.value },
                          },
                        })
                      }
                    />
                  )}
                </LabeledField>
              )}
              {error && (
                <Alert
                  variant="destructive"
                  role="alert"
                  className="md:col-span-2"
                >
                  {error}
                </Alert>
              )}
              <div className="flex gap-2 md:col-span-2">
                <Button type="submit" disabled={pending}>
                  {mode === "create" ? "Save rule" : "Save changes"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={pending}
                  onClick={onCancel}
                >
                  Cancel
                </Button>
              </div>
            </FieldGroup>
          </CardContent>
        </fieldset>
      </form>
    </Card>
  );
}

function sampleFieldValue(field: Field): SimulationValue {
  const config = normalizeField(field).config;
  if (field.name === "Request number") return "REQ-001";
  if (field.name === "Title") return "Urgent generator inspection";
  if (field.name === "Priority") return "Urgent";
  if (field.name === "Status") return "Open";
  if (field.required && config.kind !== "checkbox")
    return `Sample ${field.name}`;
  switch (config.kind) {
    case "checkbox":
      return config.defaultValue;
    case "number":
    case "integer":
      return config.defaultValue === null ? "" : String(config.defaultValue);
    case "date":
    case "datetime":
      return config.defaultValue ?? "";
    case "select":
      return config.defaultValue ?? config.options[0] ?? "";
    default:
      return config.defaultValue;
  }
}

function SimulationField({
  field,
  value,
  onChange,
}: {
  field: Field;
  value: SimulationValue;
  onChange: (
    value: SimulationValue,
  ) =>
    | void
    | SandboxCommandResult<unknown>
    | PromiseLike<SandboxCommandResult<unknown> | void>;
}) {
  const controlId = useId();
  const [draft, setDraft] = useState<SimulationValue>(() => value);
  const pendingRef = useRef(false);
  const syncedValueRef = useRef(value);
  useEffect(() => {
    if (pendingRef.current || Object.is(syncedValueRef.current, value)) return;
    syncedValueRef.current = value;
    setDraft(value);
  }, [value]);
  async function commit(next: SimulationValue): Promise<void> {
    if (pendingRef.current) return;
    setDraft(next);
    pendingRef.current = true;
    try {
      const result = await onChange(next);
      if (result && !result.ok) return;
      syncedValueRef.current = next;
    } finally {
      pendingRef.current = false;
    }
  }
  const config = normalizeField(field).config;
  if (config.kind === "checkbox")
    return (
      <FormField className="min-h-11 flex-row items-center gap-3">
        <Checkbox
          id={controlId}
          checked={draft === true}
          required={field.required}
          onCheckedChange={(checked) => void commit(checked)}
        />
        <FieldLabel htmlFor={controlId} className="font-normal">
          {field.name}
        </FieldLabel>
      </FormField>
    );
  if (config.kind === "select")
    return (
      <Choice
        label={field.name}
        value={String(draft)}
        options={config.options}
        required={field.required}
        onChange={(next) => void commit(next)}
      />
    );
  if (config.kind === "long-text")
    return (
      <LabeledField label={field.name}>
        {(id) => (
          <Textarea
            id={id}
            value={String(draft)}
            required={field.required}
            maxLength={config.maxLength}
            onChange={(event) => void commit(event.target.value)}
          />
        )}
      </LabeledField>
    );
  const type =
    config.kind === "number" || config.kind === "integer"
      ? "number"
      : config.kind === "datetime"
        ? "datetime-local"
        : config.kind;
  return (
    <LabeledField label={field.name}>
      {(id) => (
        <Input
          id={id}
          type={type}
          required={field.required}
          min={
            config.kind === "number" || config.kind === "integer"
              ? config.min
              : config.kind === "date" || config.kind === "datetime"
                ? config.earliest
                : undefined
          }
          max={
            config.kind === "number" || config.kind === "integer"
              ? config.max
              : config.kind === "date" || config.kind === "datetime"
                ? config.latest
                : undefined
          }
          step={
            config.kind === "integer"
              ? 1
              : config.kind === "number"
                ? config.step
                : undefined
          }
          maxLength={
            config.kind === "text" ||
            config.kind === "email" ||
            config.kind === "url"
              ? config.maxLength
              : undefined
          }
          value={String(draft)}
          onChange={(event) => void commit(event.target.value)}
        />
      )}
    </LabeledField>
  );
}

function PreviewField({
  field,
  disabled,
}: {
  field: Field;
  disabled: boolean;
}) {
  const controlId = useId();
  const config = normalizeField(field).config;
  if (config.kind === "checkbox")
    return (
      <FormField className="min-h-11 flex-row items-center gap-3">
        <Checkbox
          id={controlId}
          aria-label={field.name}
          defaultChecked={config.defaultValue}
          required={field.required}
          disabled={disabled}
        />
        <FieldLabel htmlFor={controlId} className="font-normal">
          {field.name}
          {field.required ? " *" : ""}
        </FieldLabel>
      </FormField>
    );
  if (config.kind === "select")
    return (
      <LabeledField label={`${field.name}${field.required ? " *" : ""}`}>
        {(id) => (
          <NativeSelect
            id={id}
            aria-label={field.name}
            className="w-full [&_select]:min-h-11"
            defaultValue={config.defaultValue ?? ""}
            required={field.required}
            disabled={disabled}
          >
            <NativeSelectOption value="">Select an option</NativeSelectOption>
            {config.options.map((option) => (
              <NativeSelectOption key={option} value={option}>
                {option}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
      </LabeledField>
    );
  if (config.kind === "long-text")
    return (
      <LabeledField label={`${field.name}${field.required ? " *" : ""}`}>
        {(id) => (
          <Textarea
            id={id}
            aria-label={field.name}
            defaultValue={config.defaultValue}
            maxLength={config.maxLength}
            required={field.required}
            disabled={disabled}
          />
        )}
      </LabeledField>
    );
  if (
    config.kind === "text" ||
    config.kind === "email" ||
    config.kind === "url"
  )
    return (
      <LabeledField label={`${field.name}${field.required ? " *" : ""}`}>
        {(id) => (
          <Input
            id={id}
            aria-label={field.name}
            type={config.kind}
            defaultValue={config.defaultValue}
            maxLength={config.maxLength}
            required={field.required}
            disabled={disabled}
          />
        )}
      </LabeledField>
    );
  if (config.kind === "number" || config.kind === "integer")
    return (
      <LabeledField label={`${field.name}${field.required ? " *" : ""}`}>
        {(id) => (
          <Input
            id={id}
            aria-label={field.name}
            type="number"
            defaultValue={config.defaultValue ?? ""}
            min={config.min}
            max={config.max}
            step={config.kind === "integer" ? 1 : config.step}
            required={field.required}
            disabled={disabled}
          />
        )}
      </LabeledField>
    );
  if (config.kind === "date" || config.kind === "datetime")
    return (
      <LabeledField label={`${field.name}${field.required ? " *" : ""}`}>
        {(id) => (
          <Input
            id={id}
            aria-label={field.name}
            type={config.kind === "datetime" ? "datetime-local" : "date"}
            defaultValue={config.defaultValue ?? ""}
            min={config.earliest}
            max={config.latest}
            required={field.required}
            disabled={disabled}
          />
        )}
      </LabeledField>
    );
  return null;
}

function RecordSnapshot({
  label,
  values,
  sandboxModule,
}: {
  label: string;
  values: Record<string, SimulationValue>;
  sandboxModule: Design["modules"][number] | undefined;
}) {
  return (
    <Card aria-label={label}>
      <CardHeader>
        <h3 className="font-semibold">{label}</h3>
      </CardHeader>
      <CardContent className="flex flex-col gap-1 text-sm">
        {sandboxModule?.fields.map((field) => (
          <p key={field.id}>
            <strong>{field.name}:</strong> {String(values[field.id] ?? "")}
          </p>
        ))}
      </CardContent>
    </Card>
  );
}

function compareSimulationValues(
  actual: SimulationValue | undefined,
  operator: RuleOperator,
  expected: string,
): boolean {
  const leftNumber = Number(actual);
  const rightNumber = Number(expected);
  const numeric =
    actual !== "" &&
    expected !== "" &&
    Number.isFinite(leftNumber) &&
    Number.isFinite(rightNumber);
  const left = numeric ? leftNumber : String(actual ?? "");
  const right = numeric ? rightNumber : expected;
  switch (operator) {
    case ">":
      return left > right;
    case ">=":
      return left >= right;
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case "=":
      return left === right;
    case "!=":
      return left !== right;
  }
}

function simulateScenario({
  design,
  sim,
  simulationModuleId,
  simulationRuleId,
  simulationEvent,
  role,
  selectedUserId,
  accessRoles,
}: {
  design: Design;
  sim: Simulation;
  simulationModuleId: string;
  simulationRuleId: string;
  simulationEvent: string;
  role: string;
  selectedUserId: string;
  accessRoles: Role[];
}): Simulation | string {
  if (!sim.records.length)
    return "Load sample records before running a scenario.";
  const record = sim.records.find(
    (item) => item.moduleId === simulationModuleId,
  );
  if (!record) return "Load a record for the selected schema module first.";
  const selectedUser = sim.users.find((item) => item.id === selectedUserId);
  const effectiveRoleName = selectedUser?.role ?? role;
  const activeRole = accessRoles.find(
    (entry) => entry.name === effectiveRoleName,
  );
  const isAdmin = activeRole?.id === "sample-admin";
  const hasModuleScope = (module: Design["modules"][number]) =>
    Boolean(
      activeRole &&
      (isAdmin ||
        (activeRole.grants.includes(`Module · ${module.name}`) &&
          activeRole.grants.includes(
            `Department · ${design.departments.find((department) => department.id === module.department)?.name}`,
          ))),
    );
  const canRead = (module: Design["modules"][number]) =>
    Boolean(
      activeRole &&
      (isAdmin ||
        (activeRole.grants.includes("Action · read") &&
          hasModuleScope(module))),
    );
  const canWrite = (
    module: Design["modules"][number],
    action: "create" | "update",
  ) =>
    Boolean(
      activeRole &&
      (isAdmin ||
        (activeRole.grants.includes(`Action · ${action}`) &&
          hasModuleScope(module))),
    );
  const recordModule = design.modules.find(
    (item) => item.id === record.moduleId,
  );
  const recordValueError = recordModule?.fields
    .filter((field) => !field.closed)
    .map((field) =>
      validateFieldValue(
        field,
        record.values[field.id] ?? sampleFieldValue(field),
      ),
    )
    .find((message) => message !== null);
  const before = { ...record.values };
  const after = { ...record.values };
  let records = sim.records;
  const trace: SimulationTrace[] = [];
  const runs: Simulation["runs"] = [];
  const selectedRules =
    simulationRuleId === "all-enabled"
      ? design.rules.filter((rule) => rule.enabled)
      : design.rules.filter((rule) => rule.id === simulationRuleId);
  for (const legacyRule of selectedRules) {
    const rule = normalizeRule(legacyRule, design);
    const configIssues = validateSandboxDesign({
      ...design,
      rules: [rule],
    }).filter((item) => item.targetId === rule.id);
    let status: SimulationTrace["status"] = "Skipped";
    let detail = "Trigger or condition did not match.";
    if (configIssues.length) {
      status = "Error";
      detail = configIssues[0].message;
    } else if (!recordModule || !canRead(recordModule)) {
      status = "Error";
      detail = `${effectiveRoleName} cannot read the selected record module.`;
    } else if (recordValueError) {
      status = "Error";
      detail = recordValueError;
    } else {
      const trigger = rule.config.trigger;
      const expectedEvent =
        trigger.kind === "new-record"
          ? "new-record"
          : trigger.kind === "field-change"
            ? "field-change"
            : trigger.kind === "threshold"
              ? "threshold"
              : "schedule";
      const moduleMatches =
        trigger.kind === "schedule" || trigger.moduleId === record.moduleId;
      const thresholdMatches =
        trigger.kind !== "threshold" ||
        compareSimulationValues(
          after[trigger.fieldId],
          trigger.operator,
          trigger.value,
        );
      const condition = rule.config.condition;
      const conditionMatches =
        condition.kind === "always" ||
        (condition.moduleId === record.moduleId &&
          compareSimulationValues(
            after[condition.fieldId],
            condition.operator,
            condition.value,
          ));
      if (
        simulationEvent === expectedEvent &&
        moduleMatches &&
        thresholdMatches &&
        conditionMatches
      ) {
        status = "Matched";
        const action = rule.config.action;
        const actionTarget =
          action.kind === "create-record" || action.kind === "update-field"
            ? design.modules.find((item) => item.id === action.moduleId)
            : recordModule;
        const requiredWrite =
          action.kind === "create-record"
            ? "create"
            : action.kind === "update-field" || action.kind === "assign-task"
              ? "update"
              : null;
        if (
          requiredWrite &&
          (!actionTarget || !canWrite(actionTarget, requiredWrite))
        ) {
          status = "Error";
          detail = `${effectiveRoleName} does not have ${requiredWrite} access to ${actionTarget?.name ?? "the action target"}.`;
        } else {
          switch (action.kind) {
            case "notification":
              detail = `Sample notification: ${action.message}`;
              break;
            case "channel-message":
              detail = `Sample channel message: ${action.channel}`;
              break;
            case "create-record":
              records = [
                ...records,
                {
                  id: uid(),
                  moduleId: action.moduleId,
                  values: { [action.fieldId]: action.value },
                },
              ];
              detail = `Sample ${design.modules.find((item) => item.id === action.moduleId)?.name ?? "record"} record prepared with ${action.value}.`;
              break;
            case "update-field":
              if (action.moduleId !== record.moduleId) {
                status = "Error";
                detail = "The action targets a different schema module.";
              } else {
                after[action.fieldId] = action.value;
                detail = "Sample field updated.";
              }
              break;
            case "assign-task":
              detail = `Sample task assigned to ${action.assignee}.`;
              break;
          }
        }
      }
    }
    trace.push({
      id: uid(),
      ruleId: rule.id,
      rule: rule.name,
      status,
      detail,
    });
    runs.push({
      id: uid(),
      ruleId: rule.id,
      rule: rule.name,
      result: `${status}: ${detail}`,
    });
  }
  return {
    ...sim,
    records: records.map((item) =>
      item.id === record.id ? { ...item, values: after } : item,
    ),
    trace,
    snapshot: { moduleId: record.moduleId, before, after },
    runs: [...runs, ...sim.runs],
  };
}

export function Workflows({
  section,
  design,
  change,
  versions,
  simulation: storedSimulation,
  updateVersions,
  updateSimulation,
  restoreVersion,
  rollbackVersion,
  deleteVersion,
  restoreDeletedVersion,
  navigate,
  notify,
  createRequest,
  onCreateRequestHandled,
  requestedRuleId,
  pending,
}: Props) {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createRequestId, setCreateRequestId] = useState<number | null>(null);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [deletingRuleId, setDeletingRuleId] = useState<string | null>(null);
  const ruleDeleteReturnFocus = useRef<HTMLElement | null>(null);
  const [historyRuleId, setHistoryRuleId] = useState("");
  const ruleElements = useRef(new Map<string, HTMLElement>());
  const handledRuleNavigation = useRef<string | null>(null);
  useEffect(() => {
    if (
      createRequest?.kind !== "automation-rule" ||
      createRequest.id === createRequestId
    )
      return;
    setCreateRequestId(createRequest.id);
    setEditingRuleId(null);
    setCreating(true);
    onCreateRequestHandled(createRequest.id);
  }, [createRequest, createRequestId, onCreateRequestHandled]);
  useEffect(() => {
    if (section !== "Automation") {
      handledRuleNavigation.current = null;
      return;
    }
    if (!requestedRuleId || handledRuleNavigation.current === requestedRuleId)
      return;
    handledRuleNavigation.current = requestedRuleId;
    const rule = design.rules.find((item) => item.id === requestedRuleId);
    if (!rule) {
      notify("The requested automation rule is unavailable.");
      return;
    }
    setHistoryRuleId(rule.id);
    ruleElements.current.get(rule.id)?.focus();
    notify(`Navigated to automation rule ${rule.name}.`);
  }, [design.rules, notify, requestedRuleId, section]);
  const sim = normalizeSimulation(storedSimulation, design);
  const setSim = (
    update: Simulation | ((previous: Simulation) => Simulation),
    commandKey = "sandbox.simulation",
  ): Promise<SandboxCommandResult<unknown>> =>
    updateSimulation((stored, currentDesign) => {
      const previous = normalizeSimulation(stored, currentDesign);
      return typeof update === "function" ? update(previous) : update;
    }, commandKey);
  const [role, setRole] = useState("Administrator");
  const [accessRoles] = useSampleState<Role[]>("access-roles", initialRoles);
  const roles = accessRoles.map((entry) => entry.name);
  const [selectedUserId, setSelectedUserId] = useState("role-only");
  const selectedUser = sim.users.find((user) => user.id === selectedUserId);
  const effectiveRoleName =
    section === "Simulation" ? (selectedUser?.role ?? role) : role;
  const activeRole = accessRoles.find(
    (entry) => entry.name === effectiveRoleName,
  );
  const isAdmin = activeRole?.id === "sample-admin";
  const hasModuleScope = (
    module: Design["modules"][number],
    sourceDesign: Design = design,
  ) =>
    Boolean(
      activeRole &&
      (isAdmin ||
        (activeRole.grants.includes(`Module · ${module.name}`) &&
          activeRole.grants.includes(
            `Department · ${sourceDesign.departments.find((department) => department.id === module.department)?.name}`,
          ))),
    );
  const canRead = (
    module: Design["modules"][number],
    sourceDesign: Design = design,
  ) =>
    Boolean(
      activeRole &&
      (isAdmin ||
        (activeRole.grants.includes("Action · read") &&
          hasModuleScope(module, sourceDesign))),
    );
  const canWrite = (
    module: Design["modules"][number],
    action: "create" | "update",
    sourceDesign: Design = design,
  ) =>
    Boolean(
      activeRole &&
      (isAdmin ||
        (activeRole.grants.includes(`Action · ${action}`) &&
          hasModuleScope(module, sourceDesign))),
    );
  const [simulationEvent, setSimulationEvent] = useState("new-record");
  const [simulationModuleId, setSimulationModuleId] = useState(
    design.modules.find((item) => !item.closed)?.id ??
      design.modules[0]?.id ??
      "",
  );
  const [simulationRuleId, setSimulationRuleId] = useState("all-enabled");
  const [preview, setPreview] = useState(design);
  const previewCanRead = (module: Design["modules"][number]) =>
    canRead(module, preview);
  const previewCanWrite = (
    module: Design["modules"][number],
    action: "create" | "update",
  ) => canWrite(module, action, preview);
  const previewCanEdit = preview.modules.some(
    (module) =>
      previewCanWrite(module, "update") || previewCanWrite(module, "create"),
  );
  const [previewMode, setPreviewMode] = useState<"desktop" | "mobile">(
    "desktop",
  );
  const [compareA, setCompareA] = useState(versions[0]?.id ?? "");
  const [compareB, setCompareB] = useState(versions.at(-1)?.id ?? "");
  const [comparing, setComparing] = useState(false);
  const [checkpointLabelEdit, setCheckpointLabelEdit] = useState<{
    id: string;
    value: string;
    error: string;
  } | null>(null);
  const [confirm, setConfirm] = useState<{
    kind: "restore" | "delete" | "rollback";
    id: string;
  } | null>(null);
  const [deletedVersion, setDeletedVersion] = useState<{
    version: Version;
    index: number;
    remainingVersionsFingerprint: string;
  } | null>(null);
  const versionActionReturnFocus = useRef<HTMLElement | null>(null);
  const versionsHeading = useRef<HTMLHeadingElement | null>(null);
  const published = versions.filter((v) => v.published);
  const confirmVersion = confirm
    ? versions.find((version) => version.id === confirm.id)
    : undefined;
  useEffect(() => {
    if (
      deletedVersion &&
      versionFingerprint(versions) !==
        deletedVersion.remainingVersionsFingerprint
    )
      setDeletedVersion(null);
  }, [deletedVersion, versions]);
  async function run() {
    const result = await updateSimulation((stored, currentDesign) => {
      const current = normalizeSimulation(stored, currentDesign);
      const simulated = simulateScenario({
        design: currentDesign,
        sim: current,
        simulationModuleId,
        simulationRuleId,
        simulationEvent,
        role,
        selectedUserId,
        accessRoles,
      });
      if (typeof simulated === "string")
        throw new SandboxCommandError(simulated);
      return simulated;
    }, "sandbox.simulation.run");
    if (!result.ok) notify(result.error);
  }
  async function apply() {
    if (!confirm || pending) return;
    const action = confirm;
    const v = versions.find((x) => x.id === action.id);
    if (!v) {
      notify("This version is no longer available.");
      return;
    }
    if (action.kind === "delete") {
      const result = await deleteVersion(action.id);
      if (!result.ok) {
        notify(result.error);
        return;
      }
      setDeletedVersion({
        version: result.value.version,
        index: result.value.index,
        remainingVersionsFingerprint: versionFingerprint(result.value.versions),
      });
      notify(
        `${result.value.version.label} deleted from this tab. Undo delete is available.`,
      );
    } else {
      const result =
        action.kind === "rollback"
          ? await rollbackVersion(action.id)
          : await restoreVersion(action.id);
      if (!result.ok) {
        notify(result.error);
        return;
      }
      setDeletedVersion(null);
      notify(
        `Local draft restored from ${v.label}. No live workspace was changed.`,
      );
    }
    const deleted = action.kind === "delete";
    setConfirm(null);
    requestAnimationFrame(() => {
      const returnTarget = versionActionReturnFocus.current;
      if (!deleted && returnTarget?.isConnected) returnTarget.focus();
      else versionsHeading.current?.focus();
    });
  }
  function closeVersionConfirm() {
    if (pending) return;
    setConfirm(null);
    requestAnimationFrame(() => {
      const returnTarget = versionActionReturnFocus.current;
      if (returnTarget?.isConnected) returnTarget.focus();
      else versionsHeading.current?.focus();
    });
  }
  return (
    <div className="flex flex-col gap-6">
      {section === "Automation" && (
        <>
          <div className="flex flex-wrap justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold">Automation rules</h2>
              <p className="text-muted-foreground mt-1 text-sm">
                Rules run in priority order, inside Simulation only.
              </p>
            </div>
            <Button
              disabled={pending}
              onClick={() => {
                setCreating(true);
                setEditingRuleId(null);
              }}
            >
              Create rule
            </Button>
          </div>
          {creating && (
            <RuleEditor
              key={`create-rule-${createRequestId ?? "local"}`}
              mode="create"
              design={design}
              initial={defaultRuleDraft(design)}
              onCancel={() => {
                if (!pending) setCreating(false);
              }}
              pending={pending}
              onSave={async (draft) => {
                const candidateId = uid();
                const result = await change((current) => {
                  const candidate = ruleFromDraft(draft, current, candidateId);
                  const problem = validateSandboxDesign({
                    ...current,
                    rules: [candidate],
                  }).find((item) => item.targetId === candidate.id);
                  if (problem) throw new SandboxCommandError(problem.message);
                  return { ...current, rules: [...current.rules, candidate] };
                });
                if (!result.ok) return result.error;
                setCreating(false);
                notify("Sample automation rule created.");
                return null;
              }}
            />
          )}
          <Card>
            <CardContent className="divide-border divide-y p-0">
              {design.rules.map((legacyRule, i) => {
                const r = normalizeRule(legacyRule, design);
                const labels = ruleConfigLabels(r.config, design);
                return (
                  <article
                    key={r.id}
                    ref={(element) => {
                      if (element) ruleElements.current.set(r.id, element);
                      else ruleElements.current.delete(r.id);
                    }}
                    tabIndex={-1}
                    aria-label={`Rule ${r.name}`}
                    className="flex flex-wrap justify-between gap-4 p-5"
                  >
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-muted-foreground text-xs">
                          PRIORITY {i + 1}
                        </p>
                        <Badge variant={r.enabled ? "success" : "outline"}>
                          {r.enabled ? "Enabled" : "Disabled"}
                        </Badge>
                      </div>
                      <h3 className="mt-2 font-semibold">{r.name}</h3>
                      <p className="text-muted-foreground mt-2 text-sm">
                        {labels.trigger} · {labels.condition} → {labels.action}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={() => {
                          setCreating(false);
                          setEditingRuleId(r.id);
                        }}
                      >
                        Edit rule
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending}
                        onClick={async () => {
                          const result = await change((current) => ({
                            ...current,
                            rules: current.rules.map((x) =>
                              x.id === r.id ? { ...x, enabled: !x.enabled } : x,
                            ),
                          }));
                          if (!result.ok) notify(result.error);
                        }}
                      >
                        {r.enabled ? "Disable" : "Enable"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending || !i}
                        onClick={async () => {
                          const result = await change((current) => {
                            const currentIndex = current.rules.findIndex(
                              (item) => item.id === r.id,
                            );
                            return {
                              ...current,
                              rules: reorder(current.rules, currentIndex, -1),
                            };
                          });
                          if (!result.ok) notify(result.error);
                        }}
                      >
                        Higher priority
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending || i === design.rules.length - 1}
                        onClick={async () => {
                          const result = await change((current) => {
                            const currentIndex = current.rules.findIndex(
                              (item) => item.id === r.id,
                            );
                            return {
                              ...current,
                              rules: reorder(current.rules, currentIndex, 1),
                            };
                          });
                          if (!result.ok) notify(result.error);
                        }}
                      >
                        Lower priority
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setSimulationRuleId(r.id);
                          const triggerModule =
                            r.config.trigger.kind === "schedule"
                              ? design.modules[0]?.id
                              : r.config.trigger.moduleId;
                          if (triggerModule)
                            setSimulationModuleId(triggerModule);
                          setSimulationEvent(
                            r.config.trigger.kind === "new-record"
                              ? "new-record"
                              : r.config.trigger.kind === "field-change"
                                ? "field-change"
                                : r.config.trigger.kind === "threshold"
                                  ? "threshold"
                                  : "schedule",
                          );
                          navigate("Simulation");
                        }}
                      >
                        Test rule
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setHistoryRuleId(historyRuleId === r.id ? "" : r.id)
                        }
                      >
                        Run history
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(event) => {
                          ruleDeleteReturnFocus.current = event.currentTarget;
                          setDeletingRuleId(r.id);
                        }}
                      >
                        Delete rule
                      </Button>
                    </div>
                    {historyRuleId === r.id && (
                      <div className="bg-muted w-full rounded-lg p-4 text-sm">
                        {sim.runs.filter(
                          (x) =>
                            x.ruleId === r.id ||
                            (x.ruleId === undefined && x.rule === r.name),
                        ).length
                          ? sim.runs
                              .filter(
                                (x) =>
                                  x.ruleId === r.id ||
                                  (x.ruleId === undefined && x.rule === r.name),
                              )
                              .map((x) => (
                                <p key={x.id} className="py-2">
                                  {x.result}
                                </p>
                              ))
                          : "No sample runs yet. Test this rule in Simulation."}
                      </div>
                    )}
                    {editingRuleId === r.id && (
                      <div className="w-full">
                        <RuleEditor
                          key={r.id}
                          mode="edit"
                          design={design}
                          initial={ruleDraft(r, design)}
                          onCancel={() => {
                            if (!pending) setEditingRuleId(null);
                          }}
                          pending={pending}
                          onSave={async (draft) => {
                            const result = await change((current) => {
                              const currentRule = current.rules.find(
                                (item) => item.id === r.id,
                              );
                              if (!currentRule)
                                throw new SandboxCommandError(
                                  "This automation rule was deleted. Keep the editor open and try again.",
                                );
                              const candidate = {
                                ...ruleFromDraft(draft, current, r.id),
                                enabled: currentRule.enabled,
                              };
                              const problem = validateSandboxDesign({
                                ...current,
                                rules: [candidate],
                              }).find((item) => item.targetId === candidate.id);
                              if (problem)
                                throw new SandboxCommandError(problem.message);
                              return {
                                ...current,
                                rules: current.rules.map((item) =>
                                  item.id === r.id ? candidate : item,
                                ),
                              };
                            });
                            if (!result.ok) return result.error;
                            setEditingRuleId(null);
                            notify("Sample automation rule updated.");
                            return null;
                          }}
                        />
                      </div>
                    )}
                  </article>
                );
              })}
              {!design.rules.length && (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>No rules yet</EmptyTitle>
                    <EmptyDescription>
                      Create a rule to begin testing sample automation.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </CardContent>
          </Card>
          <AlertDialog
            open={Boolean(deletingRuleId)}
            onOpenChange={(open) => {
              if (!open && !pending) setDeletingRuleId(null);
            }}
          >
            <AlertDialogContent
              finalFocus={() =>
                ruleDeleteReturnFocus.current?.isConnected
                  ? ruleDeleteReturnFocus.current
                  : false
              }
              className="max-xl:[&_button]:min-h-11 max-xl:[&_button]:min-w-11 max-xl:[&_input:not([type=checkbox]):not([type=radio])]:min-h-11 max-xl:[&_select]:min-h-11"
            >
              <AlertDialogHeader>
                <AlertDialogTitle>Delete automation rule</AlertDialogTitle>
                <AlertDialogDescription>
                  This removes the rule from this tab. Undo can restore it.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() => setDeletingRuleId(null)}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  disabled={pending}
                  onClick={async () => {
                    if (!deletingRuleId) return;
                    const result = await change((current) => ({
                      ...current,
                      rules: current.rules.filter(
                        (item) => item.id !== deletingRuleId,
                      ),
                    }));
                    if (!result.ok) {
                      notify(result.error);
                      return;
                    }
                    setDeletingRuleId(null);
                    notify("Sample automation rule deleted.");
                  }}
                >
                  Delete rule
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
      {section === "Simulation" && (
        <>
          <div className="flex flex-wrap justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold">Simulation lab</h2>
              <p className="text-muted-foreground mt-1 text-sm">
                Test permissions and automation on disposable sample records.
              </p>
            </div>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => navigate("Designer")}
            >
              Exit Simulation
            </Button>
          </div>
          <fieldset
            disabled={pending}
            className="contents"
            aria-busy={pending || undefined}
          >
            <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
              <Card>
                <CardContent className="flex flex-col gap-4">
                  <ModuleChoice
                    label="Schema module"
                    design={design}
                    value={simulationModuleId}
                    onChange={async (moduleId) => {
                      setSimulationModuleId(moduleId);
                      const result = await setSim((previous) => ({
                        ...previous,
                        records: [],
                        trace: [],
                        snapshot: undefined,
                      }));
                      if (!result.ok) notify(result.error);
                    }}
                  />
                  <Button
                    className="w-full"
                    variant="outline"
                    disabled={pending}
                    onClick={async () => {
                      const sandboxModule = design.modules.find(
                        (item) => item.id === simulationModuleId,
                      );
                      if (!sandboxModule) {
                        notify("Choose an available schema module first.");
                        return;
                      }
                      const result = await setSim((s) => ({
                        ...s,
                        records: [
                          {
                            id: uid(),
                            moduleId: sandboxModule.id,
                            values: Object.fromEntries(
                              sandboxModule.fields
                                .filter((field) => !field.closed)
                                .map((field) => [
                                  field.id,
                                  sampleFieldValue(field),
                                ]),
                            ),
                          },
                        ],
                        trace: [],
                        snapshot: undefined,
                      }));
                      if (!result.ok) notify(result.error);
                    }}
                  >
                    Load sample records
                  </Button>
                  <Choice
                    label="Simulation role"
                    value={role}
                    onChange={setRole}
                    options={roles}
                  />
                  <form
                    className="flex flex-col gap-3"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (!name.trim()) return;
                      const result = await setSim((s) => ({
                        ...s,
                        users: [
                          ...s.users,
                          { id: uid(), name: name.trim(), role },
                        ],
                      }));
                      if (!result.ok) {
                        notify(result.error);
                        return;
                      }
                      setName("");
                    }}
                  >
                    <LabeledField label="Test user name">
                      {(controlId) => (
                        <Input
                          id={controlId}
                          required
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                        />
                      )}
                    </LabeledField>
                    <Button variant="outline" type="submit" disabled={pending}>
                      Create test user
                    </Button>
                  </form>
                  <Choice
                    label="Test user"
                    value={selectedUser?.id ?? "role-only"}
                    onChange={setSelectedUserId}
                    options={["role-only", ...sim.users.map((user) => user.id)]}
                    renderOption={(value) => {
                      const user = sim.users.find((item) => item.id === value);
                      return user
                        ? `${user.name} · ${user.role}`
                        : "No test user — use selected role";
                    }}
                  />
                  <p className="text-muted-foreground text-xs">
                    {selectedUser
                      ? `Running as ${selectedUser.name} · ${effectiveRoleName}`
                      : `Using role-only simulation · ${effectiveRoleName}`}
                  </p>
                  {sim.users.map((u) => (
                    <div
                      key={u.id}
                      className="flex items-center justify-between gap-2"
                    >
                      <p className="text-muted-foreground text-xs">
                        {u.name} · {u.role}
                      </p>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Delete test user ${u.name}`}
                        disabled={pending}
                        onClick={async () => {
                          const result = await setSim(
                            (current) => ({
                              ...current,
                              users: current.users.filter(
                                (user) => user.id !== u.id,
                              ),
                            }),
                            `sandbox.simulation.user.delete:${u.id}`,
                          );
                          if (!result.ok) {
                            notify(result.error);
                            return;
                          }
                          if (selectedUserId === u.id)
                            setSelectedUserId("role-only");
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  ))}
                  <Choice
                    label="Rule selection"
                    value={simulationRuleId}
                    onChange={setSimulationRuleId}
                    options={[
                      "all-enabled",
                      ...design.rules.map((rule) => rule.id),
                    ]}
                    renderOption={(value) =>
                      value === "all-enabled"
                        ? "All enabled rules"
                        : (design.rules.find((rule) => rule.id === value)
                            ?.name ?? value)
                    }
                  />
                  <Choice
                    label="Simulation event"
                    value={simulationEvent}
                    onChange={setSimulationEvent}
                    options={[
                      "new-record",
                      "field-change",
                      "threshold",
                      "schedule",
                    ]}
                    renderOption={(value) =>
                      ({
                        "new-record": "New record",
                        "field-change": "Field change",
                        threshold: "Threshold",
                        schedule: "Schedule",
                      })[value] ?? value
                    }
                  />
                  <Button className="w-full" disabled={pending} onClick={run}>
                    Run simulation
                  </Button>
                  <Button
                    className="w-full"
                    variant="ghost"
                    disabled={pending}
                    onClick={async () => {
                      const result = await setSim(
                        empty,
                        "sandbox.simulation.reset",
                      );
                      if (!result.ok) {
                        notify(result.error);
                        return;
                      }
                      setSelectedUserId("role-only");
                    }}
                  >
                    Reset simulation
                  </Button>
                </CardContent>
              </Card>
              <div className="flex flex-col gap-5">
                <Card>
                  <CardHeader>
                    <h3 className="font-semibold">Sample records</h3>
                  </CardHeader>
                  <CardContent>
                    {sim.records.length ? (
                      sim.records.map((record) => {
                        const sandboxModule = design.modules.find(
                          (item) => item.id === record.moduleId,
                        );
                        return (
                          <div
                            key={record.id}
                            className="grid gap-4 border-t py-4 first:border-t-0 first:pt-0 last:pb-0 md:grid-cols-2"
                          >
                            {sandboxModule?.fields
                              .filter((field) => !field.closed)
                              .map((field) => (
                                <SimulationField
                                  key={field.id}
                                  field={field}
                                  value={
                                    record.values[field.id] ??
                                    sampleFieldValue(field)
                                  }
                                  onChange={async (value) => {
                                    const result = await setSim(
                                      (previous) => ({
                                        ...previous,
                                        records: previous.records.map((item) =>
                                          item.id === record.id
                                            ? {
                                                ...item,
                                                values: {
                                                  ...item.values,
                                                  [field.id]: value,
                                                },
                                              }
                                            : item,
                                        ),
                                        trace: [],
                                        snapshot: undefined,
                                      }),
                                      `sandbox.simulation.record:${record.id}:${field.id}`,
                                    );
                                    if (!result.ok) notify(result.error);
                                    return result;
                                  }}
                                />
                              ))}
                          </div>
                        );
                      })
                    ) : (
                      <Empty>
                        <EmptyHeader>
                          <EmptyTitle>No simulation records loaded.</EmptyTitle>
                          <EmptyDescription>
                            Load sample records to edit and test this schema.
                          </EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    )}
                  </CardContent>
                </Card>
                <Card aria-label="Execution trace">
                  <CardHeader>
                    <h3 className="font-semibold">Execution trace</h3>
                  </CardHeader>
                  <CardContent>
                    {sim.trace.length ? (
                      sim.trace.map((entry) => (
                        <div
                          key={entry.id}
                          role="group"
                          aria-label={`${entry.rule} · ${entry.status}`}
                          className="border-t py-3 text-sm first:border-t-0 first:pt-0 last:pb-0"
                        >
                          <p className="flex flex-wrap items-center gap-1 font-medium">
                            <span>{entry.rule} ·</span>
                            <Badge
                              variant={
                                entry.status === "Matched"
                                  ? "success"
                                  : entry.status === "Error"
                                    ? "destructive"
                                    : "outline"
                              }
                            >
                              {entry.status}
                            </Badge>
                          </p>
                          <p className="text-muted-foreground mt-1">
                            {entry.detail}
                          </p>
                        </div>
                      ))
                    ) : (
                      <Empty>
                        <EmptyHeader>
                          <EmptyTitle>No execution trace yet</EmptyTitle>
                          <EmptyDescription>
                            Choose a rule and event, then run the simulation.
                          </EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    )}
                  </CardContent>
                </Card>
                {sim.snapshot && (
                  <div className="grid gap-4 md:grid-cols-2">
                    <RecordSnapshot
                      label="Before record"
                      values={sim.snapshot.before}
                      sandboxModule={design.modules.find(
                        (item) => item.id === sim.snapshot?.moduleId,
                      )}
                    />
                    <RecordSnapshot
                      label="After record"
                      values={sim.snapshot.after}
                      sandboxModule={design.modules.find(
                        (item) => item.id === sim.snapshot?.moduleId,
                      )}
                    />
                  </div>
                )}
              </div>
            </div>
          </fieldset>
        </>
      )}
      {section === "Preview" && (
        <>
          <div className="flex flex-wrap justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold">Workspace preview</h2>
              <p className="text-muted-foreground mt-1 text-sm">
                {role} ·{" "}
                {!previewCanEdit
                  ? "Read only"
                  : isAdmin
                    ? "Full sample access"
                    : "Record editing"}
              </p>
              <p role="note" className="text-muted-foreground mt-2 text-xs">
                Synthetic sample-role preview only. It does not enforce or prove
                server authorization.
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <Choice
                label="Preview role"
                value={role}
                onChange={setRole}
                options={roles}
              />
              <Choice
                label="Preview layout"
                value={previewMode}
                onChange={(value) =>
                  setPreviewMode(value as "desktop" | "mobile")
                }
                options={["desktop", "mobile"]}
                renderOption={(value) =>
                  value === "desktop" ? "Desktop" : "Mobile"
                }
              />
              <Button
                variant="outline"
                onClick={() => {
                  setPreview(design);
                  notify("Preview refreshed from the current sample design.");
                }}
              >
                Refresh Preview
              </Button>
              <Button variant="ghost" onClick={() => navigate("Designer")}>
                Exit Preview
              </Button>
            </div>
          </div>
          {!preview.modules.some(previewCanRead) && (
            <Empty className="border">
              <EmptyHeader>
                <EmptyTitle>This role has no readable modules.</EmptyTitle>
                <EmptyDescription>
                  Grant department, module, and read access in Sample Access.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          <section
            aria-label="Workspace preview canvas"
            className={cn(
              "bg-muted/30 mx-auto w-full rounded-xl border p-4 transition-[max-width] motion-reduce:transition-none",
              previewMode === "mobile" ? "max-w-sm" : "max-w-none",
            )}
          >
            <p className="text-muted-foreground mb-4 text-xs font-medium uppercase">
              {previewMode === "desktop" ? "Desktop layout" : "Mobile layout"}
            </p>
            <div
              className={
                previewMode === "desktop"
                  ? "grid gap-5 md:grid-cols-2 xl:grid-cols-3"
                  : "grid gap-5"
              }
            >
              {preview.modules
                .filter(
                  (m) =>
                    previewCanRead(m) &&
                    !m.closed &&
                    !preview.departments.find((d) => d.id === m.department)
                      ?.closed,
                )
                .map((m) => (
                  <Card key={m.id} role="article" aria-label={m.name}>
                    <CardHeader>
                      <p className="text-muted-foreground text-xs">
                        {
                          preview.departments.find((d) => d.id === m.department)
                            ?.name
                        }
                      </p>
                      <h3 className="text-lg font-semibold">{m.name}</h3>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-4">
                      {m.fields
                        .filter((f) => !f.closed)
                        .map((f) => (
                          <PreviewField
                            key={f.id}
                            field={f}
                            disabled={
                              !previewCanWrite(m, "create") &&
                              !previewCanWrite(m, "update")
                            }
                          />
                        ))}
                      <p className="text-muted-foreground text-xs">
                        Preview inputs are temporary. Use Simulation to test
                        changes.
                      </p>
                    </CardContent>
                  </Card>
                ))}
            </div>
          </section>
        </>
      )}
      {section === "Versions" && (
        <>
          <div className="flex flex-wrap justify-between gap-4">
            <div>
              <h2
                ref={versionsHeading}
                tabIndex={-1}
                className="text-xl font-semibold"
              >
                Versions & local release history
              </h2>
              <p className="text-muted-foreground mt-1 text-sm">
                Keep checkpoints, compare designs, and restore with confidence.
              </p>
            </div>
            <Button
              variant="outline"
              disabled={pending || published.length < 2}
              onClick={(event) => {
                versionActionReturnFocus.current = event.currentTarget;
                setConfirm({ kind: "rollback", id: published.at(-2)!.id });
              }}
            >
              Roll back previous local release
            </Button>
          </div>
          {deletedVersion && (
            <Alert className="flex flex-wrap items-center justify-between gap-3">
              <span>{deletedVersion.version.label} deleted from this tab.</span>
              <Button
                size="sm"
                variant="outline"
                aria-label={`Undo delete ${deletedVersion.version.label}`}
                disabled={pending}
                onClick={async () => {
                  const result = await restoreDeletedVersion(
                    deletedVersion.version,
                    deletedVersion.index,
                  );
                  if (!result.ok) {
                    notify(result.error);
                    return;
                  }
                  notify(`${deletedVersion.version.label} restored.`);
                  setDeletedVersion(null);
                }}
              >
                Undo delete
              </Button>
            </Alert>
          )}
          <Card>
            <CardContent className="flex flex-wrap items-end gap-3">
              {[
                {
                  label: "Compare first version",
                  value: compareA,
                  set: setCompareA,
                },
                {
                  label: "Compare second version",
                  value: compareB,
                  set: setCompareB,
                },
              ].map((control) => (
                <Choice
                  key={control.label}
                  label={control.label}
                  value={control.value}
                  options={versions.map((version) => version.id)}
                  renderOption={(id) =>
                    versions.find((version) => version.id === id)?.label ?? id
                  }
                  onChange={control.set}
                />
              ))}
              <Button variant="outline" onClick={() => setComparing(true)}>
                Compare versions
              </Button>
            </CardContent>
          </Card>
          {comparing && (
            <Card aria-label="Version comparison">
              {(() => {
                const first = versions.find((item) => item.id === compareA);
                const second = versions.find((item) => item.id === compareB);
                if (!first || !second)
                  return (
                    <CardContent>
                      <Empty>
                        <EmptyHeader>
                          <EmptyTitle>
                            Select two versions to compare.
                          </EmptyTitle>
                        </EmptyHeader>
                      </Empty>
                    </CardContent>
                  );
                return (
                  <>
                    <CardHeader>
                      <h3 className="font-semibold">
                        {first.label} → {second.label}
                      </h3>
                    </CardHeader>
                    <CardContent>
                      <div className="text-muted-foreground mt-3 grid gap-2 text-sm md:grid-cols-2">
                        <p>
                          <strong className="text-foreground">Before:</strong>{" "}
                          {counts(first.design)}
                        </p>
                        <p>
                          <strong className="text-foreground">After:</strong>{" "}
                          {counts(second.design)}
                        </p>
                      </div>
                      <ul className="mt-4 flex list-inside list-disc flex-col gap-1 text-sm">
                        {changesFrom(first.design, second.design).map(
                          (change) => (
                            <li key={change}>{change}</li>
                          ),
                        )}
                      </ul>
                    </CardContent>
                  </>
                );
              })()}
            </Card>
          )}
          <Card>
            <CardContent className="divide-border divide-y p-0">
              {[...versions].reverse().map((v) => (
                <article
                  key={v.id}
                  aria-label={v.label}
                  className="flex flex-wrap justify-between gap-4 p-5"
                >
                  <div className="min-w-0">
                    <p className="text-muted-foreground text-xs font-medium uppercase">
                      {v.published ? "Local release" : "Checkpoint"}
                    </p>
                    {checkpointLabelEdit?.id === v.id ? (
                      <form
                        aria-label={`Edit checkpoint label ${v.label}`}
                        className="mt-2 flex flex-col gap-2"
                        onSubmit={async (event) => {
                          event.preventDefault();
                          if (pending || !checkpointLabelEdit) return;
                          const label = checkpointLabelEdit.value.trim();
                          if (!label) {
                            setCheckpointLabelEdit({
                              ...checkpointLabelEdit,
                              error: "Checkpoint label is required",
                            });
                            return;
                          }
                          if (checkpointLabelEdit.value.length > 80) {
                            setCheckpointLabelEdit({
                              ...checkpointLabelEdit,
                              error:
                                "Checkpoint label must be 80 characters or fewer",
                            });
                            return;
                          }
                          const result = await updateVersions((current) =>
                            current.map((version) =>
                              version.id === v.id
                                ? { ...version, label }
                                : version,
                            ),
                          );
                          if (!result.ok) {
                            setCheckpointLabelEdit({
                              ...checkpointLabelEdit,
                              error: result.error,
                            });
                            return;
                          }
                          setCheckpointLabelEdit(null);
                          notify("Checkpoint label updated in this tab.");
                        }}
                      >
                        <LabeledField label="Checkpoint label">
                          {(controlId) => (
                            <Input
                              id={controlId}
                              autoFocus
                              required
                              maxLength={80}
                              value={checkpointLabelEdit.value}
                              onChange={(event) =>
                                setCheckpointLabelEdit({
                                  ...checkpointLabelEdit,
                                  value: event.target.value,
                                  error: "",
                                })
                              }
                            />
                          )}
                        </LabeledField>
                        {checkpointLabelEdit.error && (
                          <Alert variant="destructive" role="alert">
                            {checkpointLabelEdit.error}
                          </Alert>
                        )}
                        <div className="flex gap-2">
                          <Button size="sm" type="submit" disabled={pending}>
                            Save label
                          </Button>
                          <Button
                            size="sm"
                            type="button"
                            variant="ghost"
                            disabled={pending}
                            onClick={() => setCheckpointLabelEdit(null)}
                          >
                            Cancel label edit
                          </Button>
                        </div>
                      </form>
                    ) : (
                      <h3 className="mt-1 font-semibold">{v.label}</h3>
                    )}
                    <p className="text-muted-foreground mt-2 text-xs">
                      {v.date} · {counts(v.design)}
                    </p>
                    <p className="mt-2 text-sm">
                      {v.note || "No version note provided."}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {!v.published && checkpointLabelEdit?.id !== v.id && (
                      <Button
                        variant="outline"
                        disabled={pending}
                        onClick={() =>
                          setCheckpointLabelEdit({
                            id: v.id,
                            value: v.label,
                            error: "",
                          })
                        }
                      >
                        Edit checkpoint label
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      disabled={pending}
                      onClick={(event) => {
                        versionActionReturnFocus.current = event.currentTarget;
                        setConfirm({ kind: "restore", id: v.id });
                      }}
                    >
                      Restore version
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={
                        pending ||
                        v.id === published.at(-1)?.id ||
                        versions.length === 1
                      }
                      onClick={(event) => {
                        versionActionReturnFocus.current = event.currentTarget;
                        setConfirm({ kind: "delete", id: v.id });
                      }}
                    >
                      Delete version
                    </Button>
                  </div>
                </article>
              ))}
            </CardContent>
          </Card>
        </>
      )}
      <AlertDialog
        open={Boolean(confirm && confirmVersion)}
        onOpenChange={(open) => !open && !pending && closeVersionConfirm()}
      >
        {confirm && confirmVersion && (
          <AlertDialogContent
            finalFocus={() => {
              const returnTarget = versionActionReturnFocus.current;
              return returnTarget?.isConnected
                ? returnTarget
                : versionsHeading.current;
            }}
            className="max-xl:[&_button]:min-h-11 max-xl:[&_button]:min-w-11 max-xl:[&_input:not([type=checkbox]):not([type=radio])]:min-h-11 max-xl:[&_select]:min-h-11"
          >
            <AlertDialogHeader>
              <AlertDialogTitle>
                {confirm.kind === "delete"
                  ? `Delete ${confirmVersion.label}?`
                  : confirm.kind === "rollback"
                    ? `Roll back to ${confirmVersion.label}?`
                    : `Restore ${confirmVersion.label}?`}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {confirm.kind === "delete"
                  ? `Delete the ${confirmVersion.published ? "local release" : "checkpoint"} ${confirmVersion.label} from this tab? An immediate undo remains available.`
                  : confirm.kind === "rollback"
                    ? `Roll back the draft to ${confirmVersion.label} and create a new local release snapshot? The design replacement remains undoable.`
                    : `Restore the draft from ${confirmVersion.label}? The design replacement remains undoable.`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button
                variant="outline"
                disabled={pending}
                onClick={closeVersionConfirm}
              >
                Cancel {confirm.kind === "delete" ? "deletion" : confirm.kind}
              </Button>
              <Button
                variant={confirm.kind === "delete" ? "destructive" : "default"}
                disabled={pending}
                onClick={apply}
              >
                {confirm.kind === "delete"
                  ? `Delete ${confirmVersion.label}`
                  : confirm.kind === "rollback"
                    ? `Roll back to ${confirmVersion.label}`
                    : `Restore ${confirmVersion.label}`}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </div>
  );
}
