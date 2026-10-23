"use client";

import { useId } from "react";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import type { SandboxDocumentField } from "../domain/document";
import type { TestEventDraft } from "../domain/test-setup";
import type { SandboxTestEvent } from "../state/api";
import { SetupRow, setupErrorId, setupErrorProps } from "./test-setup-rows";
import { weekdayOptions } from "./trigger-flow";

/**
 * When and its settings, as label-left rows of the Setup pane. The changed
 * field and the previous value take their ids from the workspace, which
 * focuses them when Run test finds them missing.
 */
export function TestEventRows({
  draft,
  fields,
  changedFieldId,
  previousValueId,
  errors,
  onChange,
}: {
  draft: TestEventDraft;
  fields: readonly SandboxDocumentField[];
  changedFieldId: string;
  previousValueId: string;
  /** What Run test found missing, by control id. */
  errors: ReadonlyMap<string, string>;
  onChange: (next: TestEventDraft) => void;
}) {
  const eventId = useId();
  const frequencyId = useId();
  const timeId = useId();
  const weekdayId = useId();
  const eventFields =
    draft.kind === "threshold-crossed"
      ? fields.filter(
          (field) =>
            field.config.kind === "number" || field.config.kind === "integer",
        )
      : fields;
  const changedFieldError = errors.get(changedFieldId);
  const previousValueError = errors.get(previousValueId);
  return (
    <>
      <SetupRow id={eventId} label="When">
        <NativeSelect
          id={eventId}
          value={draft.kind}
          onChange={(change) =>
            onChange({
              ...draft,
              kind: change.target.value as SandboxTestEvent["kind"],
              fieldId: "",
              previousValue: "",
            })
          }
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
      </SetupRow>
      {draft.kind === "field-changed" || draft.kind === "threshold-crossed" ? (
        <SetupRow
          id={changedFieldId}
          label="Changed field"
          error={changedFieldError}
        >
          <NativeSelect
            id={changedFieldId}
            {...setupErrorProps(
              setupErrorId(changedFieldId),
              changedFieldError,
            )}
            value={draft.fieldId || eventFields[0]?.id || ""}
            onChange={(change) =>
              onChange({ ...draft, fieldId: change.target.value })
            }
          >
            {eventFields.map((field) => (
              <NativeSelectOption key={field.id} value={field.id}>
                {field.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </SetupRow>
      ) : null}
      {draft.kind === "threshold-crossed" ? (
        <SetupRow
          id={previousValueId}
          label="Previous value"
          error={previousValueError}
        >
          <Input
            id={previousValueId}
            type="number"
            {...setupErrorProps(
              setupErrorId(previousValueId),
              previousValueError,
            )}
            value={draft.previousValue}
            onChange={(change) =>
              onChange({ ...draft, previousValue: change.target.value })
            }
          />
        </SetupRow>
      ) : null}
      {draft.kind === "schedule" ? (
        <>
          <SetupRow id={frequencyId} label="Frequency">
            <NativeSelect
              id={frequencyId}
              value={draft.frequency}
              onChange={(change) =>
                onChange({
                  ...draft,
                  frequency: change.target.value as "daily" | "weekly",
                })
              }
            >
              <NativeSelectOption value="daily">Daily</NativeSelectOption>
              <NativeSelectOption value="weekly">Weekly</NativeSelectOption>
            </NativeSelect>
          </SetupRow>
          <SetupRow id={timeId} label="Time">
            <Input
              id={timeId}
              type="time"
              value={draft.time}
              onChange={(change) =>
                onChange({ ...draft, time: change.target.value })
              }
            />
          </SetupRow>
          {draft.frequency === "weekly" ? (
            <SetupRow id={weekdayId} label="Day">
              <NativeSelect
                id={weekdayId}
                value={draft.weekday}
                onChange={(change) =>
                  onChange({ ...draft, weekday: change.target.value })
                }
              >
                {weekdayOptions.map((day) => (
                  <NativeSelectOption key={day.value} value={day.value}>
                    {day.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </SetupRow>
          ) : null}
        </>
      ) : null}
    </>
  );
}
