"use client";

import { useEffect, useId, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import type {
  SandboxDocumentDesign,
  SandboxFieldValue,
} from "../domain/document";
import type { SandboxAutomation } from "../domain/document";
import type { SandboxTestEvent, SandboxTestRun } from "../state/api";

type Props = {
  design: SandboxDocumentDesign;
  automations: readonly SandboxAutomation[];
  runs: readonly SandboxTestRun[];
  onRun: (input: {
    moduleId: string;
    values: Record<string, SandboxFieldValue>;
    event: SandboxTestEvent;
    automationIds?: string[];
  }) => Promise<void>;
  onClear: () => Promise<void>;
};

function moduleFields(design: SandboxDocumentDesign, moduleId: string) {
  return (
    design.modules
      .find((item) => item.id === moduleId)
      ?.fields.filter((field) => !field.closed) ?? []
  );
}

function defaultValues(
  design: SandboxDocumentDesign,
  moduleId: string,
): Record<string, SandboxFieldValue> {
  return Object.fromEntries(
    moduleFields(design, moduleId).map((field) => [
      field.id,
      field.config.defaultValue,
    ]),
  );
}

export function TestWorkspace({
  design,
  automations,
  runs,
  onRun,
  onClear,
}: Props) {
  const initialModule = design.modules.find((item) => !item.closed)?.id ?? "";
  const [moduleId, setModuleId] = useState(initialModule);
  const [values, setValues] = useState<Record<string, SandboxFieldValue>>(() =>
    defaultValues(design, initialModule),
  );
  const [eventKind, setEventKind] =
    useState<SandboxTestEvent["kind"]>("record-created");
  const [fieldId, setFieldId] = useState("");
  const [frequency, setFrequency] = useState<"daily" | "weekly">("daily");
  const [time, setTime] = useState("09:00");
  const [weekday, setWeekday] = useState("1");
  const [previousValue, setPreviousValue] = useState("");
  const [automationMode, setAutomationMode] = useState<"all" | "selected">(
    "all",
  );
  const [automationIds, setAutomationIds] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState("");
  const moduleLabelId = useId();
  const eventLabelId = useId();
  const changedFieldLabelId = useId();
  const previousValueLabelId = useId();
  const frequencyLabelId = useId();
  const timeLabelId = useId();
  const weekdayLabelId = useId();
  const automationModeLabelId = useId();

  useEffect(() => {
    if (
      moduleId &&
      design.modules.some((item) => item.id === moduleId && !item.closed)
    )
      return;
    const next = design.modules.find((item) => !item.closed)?.id ?? "";
    setModuleId(next);
    setValues(defaultValues(design, next));
  }, [design, moduleId]);

  const fields = moduleFields(design, moduleId);
  const numericFields = fields.filter(
    (field) =>
      field.config.kind === "number" || field.config.kind === "integer",
  );
  const eventFields =
    eventKind === "threshold-crossed" ? numericFields : fields;
  const moduleAutomations = automations.filter((automation) =>
    automation.trigger.kind === "schedule"
      ? automation.trigger.moduleId === moduleId
      : automation.trigger.moduleId === moduleId,
  );
  const event: SandboxTestEvent =
    eventKind === "record-created"
      ? { kind: eventKind }
      : eventKind === "schedule"
        ? {
            kind: eventKind,
            frequency,
            time,
            ...(frequency === "weekly" ? { weekday: Number(weekday) } : {}),
          }
        : eventKind === "field-changed"
          ? { kind: eventKind, fieldId: fieldId || fields[0]?.id || "" }
          : {
              kind: eventKind,
              fieldId: fieldId || numericFields[0]?.id || "",
              previousValue: Number(previousValue),
            };

  async function run() {
    if (!moduleId) {
      setError("Add a module with fields before running a test.");
      return;
    }
    if (
      (event.kind === "field-changed" || event.kind === "threshold-crossed") &&
      !event.fieldId
    ) {
      setError(
        event.kind === "threshold-crossed"
          ? "Add a number field before testing a threshold."
          : "Choose the field that changes.",
      );
      return;
    }
    if (
      event.kind === "threshold-crossed" &&
      (previousValue.trim() === "" || !Number.isFinite(Number(previousValue)))
    ) {
      setError("Enter the previous number before running this test.");
      return;
    }
    setPending(true);
    setError("");
    try {
      await onRun({
        moduleId,
        values,
        event,
        ...(automationMode === "selected" ? { automationIds } : {}),
      });
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The test could not run. Try again.",
      );
    } finally {
      setPending(false);
    }
  }

  async function clear() {
    if (clearing) return;
    setClearing(true);
    setError("");
    try {
      await onClear();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Test results could not be cleared. Try again.",
      );
    } finally {
      setClearing(false);
    }
  }

  return (
    <section aria-labelledby="sandbox-test-title" className="grid gap-5">
      <div>
        <h2 id="sandbox-test-title" className="text-xl font-semibold">
          Test your setup
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Enter temporary values and see what your enabled automations would do.
          Nothing is added to your live workspace.
        </p>
      </div>
      {error ? (
        <Alert variant="destructive" role="alert">
          {error}
        </Alert>
      ) : null}
      <Card>
        <CardContent className="grid gap-4 pt-6">
          <Field>
            <FieldLabel htmlFor={moduleLabelId}>Module</FieldLabel>
            <NativeSelect
              id={moduleLabelId}
              value={moduleId}
              onChange={(event) => {
                setModuleId(event.target.value);
                setValues(defaultValues(design, event.target.value));
                setFieldId("");
              }}
            >
              {design.modules
                .filter((item) => !item.closed)
                .map((item) => (
                  <NativeSelectOption key={item.id} value={item.id}>
                    {item.name}
                  </NativeSelectOption>
                ))}
            </NativeSelect>
          </Field>
          <fieldset className="grid gap-3">
            <legend className="text-sm font-medium">
              Temporary field values
            </legend>
            {fields.map((field) => {
              const fieldControlId = `sandbox-test-${field.id}`;
              const value = values[field.id] ?? null;
              return (
                <Field key={field.id}>
                  <FieldLabel htmlFor={fieldControlId}>{field.name}</FieldLabel>
                  {field.config.kind === "checkbox" ? (
                    <NativeSelect
                      id={fieldControlId}
                      value={String(value === true)}
                      onChange={(event) =>
                        setValues({
                          ...values,
                          [field.id]: event.target.value === "true",
                        })
                      }
                    >
                      <NativeSelectOption value="true">Yes</NativeSelectOption>
                      <NativeSelectOption value="false">No</NativeSelectOption>
                    </NativeSelect>
                  ) : field.config.kind === "select" ? (
                    <NativeSelect
                      id={fieldControlId}
                      value={typeof value === "string" ? value : ""}
                      onChange={(event) =>
                        setValues({
                          ...values,
                          [field.id]: event.target.value || null,
                        })
                      }
                    >
                      <NativeSelectOption value="">
                        Choose a value
                      </NativeSelectOption>
                      {field.config.options.map((option) => (
                        <NativeSelectOption key={option} value={option}>
                          {option}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  ) : (
                    <Input
                      id={fieldControlId}
                      type={
                        field.config.kind === "number" ||
                        field.config.kind === "integer"
                          ? "number"
                          : field.config.kind === "date"
                            ? "date"
                            : field.config.kind === "datetime"
                              ? "datetime-local"
                              : "text"
                      }
                      value={value === null ? "" : String(value)}
                      onChange={(event) =>
                        setValues({
                          ...values,
                          [field.id]:
                            field.config.kind === "number" ||
                            field.config.kind === "integer"
                              ? event.target.value === ""
                                ? null
                                : Number(event.target.value)
                              : event.target.value,
                        })
                      }
                    />
                  )}
                </Field>
              );
            })}
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={eventLabelId}>When</FieldLabel>
              <NativeSelect
                id={eventLabelId}
                value={eventKind}
                onChange={(event) => {
                  setEventKind(event.target.value as SandboxTestEvent["kind"]);
                  setFieldId("");
                  setPreviousValue("");
                }}
              >
                <NativeSelectOption value="record-created">
                  An item is added
                </NativeSelectOption>
                <NativeSelectOption value="field-changed">
                  A field changes
                </NativeSelectOption>
                <NativeSelectOption value="threshold-crossed">
                  A number crosses a threshold
                </NativeSelectOption>
                <NativeSelectOption value="schedule">
                  A schedule runs
                </NativeSelectOption>
              </NativeSelect>
            </Field>
            {eventKind === "field-changed" ||
            eventKind === "threshold-crossed" ? (
              <Field>
                <FieldLabel htmlFor={changedFieldLabelId}>
                  Changed field
                </FieldLabel>
                <NativeSelect
                  id={changedFieldLabelId}
                  value={fieldId || eventFields[0]?.id || ""}
                  onChange={(event) => setFieldId(event.target.value)}
                >
                  {eventFields.map((field) => (
                    <NativeSelectOption key={field.id} value={field.id}>
                      {field.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
            ) : null}
            {eventKind === "threshold-crossed" ? (
              <Field>
                <FieldLabel htmlFor={previousValueLabelId}>
                  Previous value
                </FieldLabel>
                <Input
                  id={previousValueLabelId}
                  type="number"
                  value={previousValue}
                  onChange={(event) => setPreviousValue(event.target.value)}
                />
              </Field>
            ) : null}
            {eventKind === "schedule" ? (
              <>
                <Field>
                  <FieldLabel htmlFor={frequencyLabelId}>Frequency</FieldLabel>
                  <NativeSelect
                    id={frequencyLabelId}
                    value={frequency}
                    onChange={(event) =>
                      setFrequency(event.target.value as "daily" | "weekly")
                    }
                  >
                    <NativeSelectOption value="daily">Daily</NativeSelectOption>
                    <NativeSelectOption value="weekly">
                      Weekly
                    </NativeSelectOption>
                  </NativeSelect>
                </Field>
                <Field>
                  <FieldLabel htmlFor={timeLabelId}>Time</FieldLabel>
                  <Input
                    id={timeLabelId}
                    type="time"
                    value={time}
                    onChange={(event) => setTime(event.target.value)}
                  />
                </Field>
                {frequency === "weekly" ? (
                  <Field>
                    <FieldLabel htmlFor={weekdayLabelId}>Day</FieldLabel>
                    <NativeSelect
                      id={weekdayLabelId}
                      value={weekday}
                      onChange={(event) => setWeekday(event.target.value)}
                    >
                      {[1, 2, 3, 4, 5, 6, 7].map((day) => (
                        <NativeSelectOption key={day} value={String(day)}>
                          Day {day}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </Field>
                ) : null}
              </>
            ) : null}
          </div>
          <fieldset className="grid gap-2">
            <legend className="text-sm font-medium">Automations</legend>
            <Field>
              <FieldLabel htmlFor={automationModeLabelId}>
                Automations to test
              </FieldLabel>
              <NativeSelect
                id={automationModeLabelId}
                value={automationMode}
                onChange={(event) =>
                  setAutomationMode(event.target.value as "all" | "selected")
                }
              >
                <NativeSelectOption value="all">
                  All enabled automations
                </NativeSelectOption>
                <NativeSelectOption value="selected">
                  Choose automations
                </NativeSelectOption>
              </NativeSelect>
            </Field>
            {automationMode === "selected"
              ? moduleAutomations.map((automation) => (
                  <label
                    key={automation.id}
                    htmlFor={`sandbox-test-automation-${automation.id}`}
                    className="flex min-h-11 items-center gap-2 text-sm"
                  >
                    <Checkbox
                      id={`sandbox-test-automation-${automation.id}`}
                      checked={automationIds.includes(automation.id)}
                      onCheckedChange={(checked) =>
                        setAutomationIds(
                          checked
                            ? [...automationIds, automation.id]
                            : automationIds.filter(
                                (id) => id !== automation.id,
                              ),
                        )
                      }
                    />
                    {automation.name}
                  </label>
                ))
              : null}
          </fieldset>
          <Button
            className="min-h-11"
            disabled={pending || clearing || !moduleId}
            onClick={() => void run()}
          >
            Run test
          </Button>
        </CardContent>
      </Card>
      <section aria-label="Recent test results" className="grid gap-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-semibold">Recent results</h3>
          {runs.length ? (
            <Button
              variant="ghost"
              className="min-h-11"
              disabled={pending || clearing}
              onClick={() => void clear()}
            >
              {clearing ? "Clearing results…" : "Clear results"}
            </Button>
          ) : null}
        </div>
        {runs.length ? (
          runs.map((run) => (
            <Card key={run.id}>
              <CardHeader>
                <CardTitle className="text-base">Test result</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 text-sm">
                {run.result.issues.length ? (
                  <Alert variant="destructive">
                    {run.result.issues.map((issue) => issue.message).join(" ")}
                  </Alert>
                ) : null}
                {run.result.automationTraces.length ? (
                  <ul className="list-inside list-disc">
                    {run.result.automationTraces.map((trace) => (
                      <li key={`${run.id}-${trace.automationId}`}>
                        {trace.label}: {trace.outcome}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground">
                    No automation changes were expected.
                  </p>
                )}
                {run.result.routes.length ? (
                  <ul className="list-inside list-disc">
                    {run.result.routes.map((route, index) => (
                      <li key={`${run.id}-route-${index}`}>
                        {route.label}
                        {route.detail ? `: ${route.detail}` : ""}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {Object.keys(run.result.values).length ? (
                  <dl className="grid gap-1">
                    <dt className="font-medium">Resulting field values</dt>
                    {Object.entries(run.result.values).map(([field, value]) => (
                      <dd key={field} className="text-muted-foreground">
                        {moduleFields(design, run.input.moduleId).find(
                          (item) => item.id === field,
                        )?.name ?? "Unavailable field"}
                        : {value === null ? "No value" : String(value)}
                      </dd>
                    ))}
                  </dl>
                ) : null}
              </CardContent>
            </Card>
          ))
        ) : (
          <p className="text-muted-foreground text-sm">
            Run a test to see the expected outcome here.
          </p>
        )}
      </section>
    </section>
  );
}
