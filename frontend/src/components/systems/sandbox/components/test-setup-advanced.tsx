"use client";

import { useId } from "react";
import { AdvancedSection } from "@/components/ui/advanced-section";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import type { SandboxDocumentDesign, SandboxTrigger } from "../domain/document";
import type { SandboxTestRun } from "../state/api";
import { SetupRow } from "./test-setup-rows";

/**
 * The rare Test controls, last in the Setup pane and closed by default
 * (October Test classification): which triggers run, and the recent results
 * with Clear results. Opening a recent result puts its module and event in
 * the setup, so the result pane can show it.
 */
export function TestSetupAdvanced({
  design,
  moduleTriggers,
  triggerMode,
  triggerIds,
  runs,
  shownRunId,
  busy,
  clearing,
  onTriggerMode,
  onTriggerIds,
  onOpenRun,
  onClear,
}: {
  design: SandboxDocumentDesign;
  moduleTriggers: readonly SandboxTrigger[];
  triggerMode: "all" | "selected";
  triggerIds: readonly string[];
  runs: readonly SandboxTestRun[];
  shownRunId: string | undefined;
  busy: boolean;
  clearing: boolean;
  onTriggerMode: (mode: "all" | "selected") => void;
  onTriggerIds: (ids: string[]) => void;
  onOpenRun: (run: SandboxTestRun) => void;
  onClear: () => void;
}) {
  const triggerModeId = useId();
  return (
    <AdvancedSection
      storageKey="sandbox.test"
      summary={
        triggerMode === "selected"
          ? "Chosen triggers, Recent results"
          : "Triggers to run, Recent results"
      }
    >
      <div className="grid gap-2">
        <SetupRow id={triggerModeId} label="Triggers to run">
          <NativeSelect
            id={triggerModeId}
            value={triggerMode}
            onChange={(change) =>
              onTriggerMode(change.target.value as "all" | "selected")
            }
          >
            <NativeSelectOption value="all">
              All enabled triggers
            </NativeSelectOption>
            <NativeSelectOption value="selected">
              Choose triggers
            </NativeSelectOption>
          </NativeSelect>
        </SetupRow>
        {triggerMode === "selected"
          ? moduleTriggers.map((recordTrigger) => (
              <label
                key={recordTrigger.id}
                htmlFor={`sandbox-test-trigger-${recordTrigger.id}`}
                className="flex min-h-11 items-center gap-2 text-sm xl:min-h-8 @min-[22rem]/setup:ml-[calc(7rem+0.75rem)]"
              >
                <Checkbox
                  id={`sandbox-test-trigger-${recordTrigger.id}`}
                  checked={triggerIds.includes(recordTrigger.id)}
                  onCheckedChange={(checked) =>
                    onTriggerIds(
                      checked
                        ? [...triggerIds, recordTrigger.id]
                        : triggerIds.filter((id) => id !== recordTrigger.id),
                    )
                  }
                />
                {recordTrigger.name}
              </label>
            ))
          : null}
      </div>
      <section aria-label="Recent test results" className="grid gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-medium">Recent results</h4>
          {runs.length > 0 && (
            <Button
              variant="ghost"
              className="min-h-11"
              disabled={busy}
              onClick={onClear}
            >
              {clearing ? "Clearing results…" : "Clear results"}
            </Button>
          )}
        </div>
        {runs.length ? (
          <div className="grid max-h-64 gap-1 overflow-y-auto">
            {runs.map((item) => {
              const testedModule = design.modules.find(
                (entry) => entry.id === item.input.moduleId,
              );
              return (
                <Button
                  key={item.id}
                  aria-pressed={shownRunId === item.id}
                  variant="ghost"
                  // A run for a removed module cannot match any setup.
                  disabled={!testedModule || testedModule.closed}
                  className="h-auto min-h-11 justify-start px-3 py-2 text-left whitespace-normal hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)] aria-pressed:bg-[color-mix(in_oklab,var(--ink)_14%,transparent)]"
                  onClick={() => onOpenRun(item)}
                >
                  <span className="min-w-0">
                    <span className="block truncate">
                      {testedModule?.name ?? "Unavailable module"}
                    </span>
                    <span className="text-muted-foreground block text-xs">
                      {new Date(item.createdAt).toLocaleString()} ·{" "}
                      {item.result.issues.length
                        ? "Needs attention"
                        : "Test complete"}
                    </span>
                  </span>
                </Button>
              );
            })}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            No saved test results yet.
          </p>
        )}
      </section>
    </AdvancedSection>
  );
}
