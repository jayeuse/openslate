import { expect, test } from "@playwright/test";
import {
  clearKeptTriggerDrafts,
  readKeptTriggerDraft,
  triggerDraftStorageKey,
  triggerSaveFailure,
  writeKeptTriggerDraft,
} from "../../../src/components/systems/sandbox/components/use-trigger-draft";
import { SandboxCommandError } from "../../../src/components/systems/sandbox/state/commands";
import { triggerStepErrors } from "../../../src/components/systems/sandbox/domain/trigger-rules";
import { triggerEditsHoldMove } from "../../../src/components/systems/sandbox/helpers/work-in-progress";
import {
  configuredSandboxDesign,
  sandboxDocumentFromDesign,
} from "../../helpers/sandbox-fixtures";

// Phase 1 of the Sandbox follow-up pass (docs/specs/sandbox-followup-pass.md):
// unsaved trigger edits survive moves and reloads.

/** An in-memory Storage with the parts the draft code uses. */
function memoryStorage(entries: Record<string, string> = {}) {
  const values = new Map(Object.entries(entries));
  return {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    keys: () => [...values.keys()],
  };
}

test("unsaved triggers hold a move only when it leaves Triggers or the Sandbox", () => {
  const rows: Array<[string, string | null, boolean]> = [
    ["Triggers", "Build", true],
    ["Triggers", null, true],
    ["Build", null, true],
    ["Build", "Test", false],
    ["Build", "Triggers", false],
    ["History", "Triggers", false],
  ];
  for (const [from, to, held] of rows)
    expect(triggerEditsHoldMove(from, to), `${from} → ${to}`).toBe(held);
});

test("kept trigger edits read back only when they still parse against the draft", () => {
  const document = sandboxDocumentFromDesign(configuredSandboxDesign);
  const key = triggerDraftStorageKey("user-1", "org-1");
  const edited = [{ ...document.triggers[0]!, name: "Kept name" }];
  const storage = memoryStorage();

  writeKeptTriggerDraft(storage, key, { base: "[]", triggers: edited });
  expect(readKeptTriggerDraft(storage, key, document)?.triggers[0]?.name).toBe(
    "Kept name",
  );

  for (const damaged of [
    "not json",
    JSON.stringify({ version: 2, base: "[]", triggers: edited }),
    JSON.stringify({ version: 1, base: "[]", triggers: [{ id: 7 }] }),
  ]) {
    storage.setItem(key, damaged);
    expect(readKeptTriggerDraft(storage, key, document)).toBeNull();
  }

  writeKeptTriggerDraft(storage, key, null);
  expect(storage.getItem(key)).toBeNull();
});

test("sign-out clears one account's kept trigger edits and no other's", () => {
  const mine = triggerDraftStorageKey("a", "org-1");
  const mineOtherOrg = triggerDraftStorageKey("a", null);
  // "a.b" must not match the prefix of "a".
  const other = triggerDraftStorageKey("a.b", "org-1");
  const storage = memoryStorage({
    [mine]: "{}",
    [mineOtherOrg]: "{}",
    [other]: "{}",
    unrelated: "{}",
  });
  clearKeptTriggerDrafts("a", storage);
  expect(storage.keys().sort()).toEqual([other, "unrelated"].sort());
});

test("a fixed value that does not fit its field is reported on its step", () => {
  const document = sandboxDocumentFromDesign(configuredSandboxDesign);
  const recordTrigger = document.triggers[0]!;
  const condition = recordTrigger.conditionGroup.conditions[0]!;
  const requestNumber = document.design.modules
    .flatMap((module) => module.fields.map((field) => ({ module, field })))
    .find(({ field }) => field.name === "Request number")!;
  const incomplete = {
    ...recordTrigger,
    conditionGroup: {
      ...recordTrigger.conditionGroup,
      conditions: [
        {
          ...condition,
          field: {
            moduleId: requestNumber.module.id,
            fieldId: requestNumber.field.id,
          },
          value: { kind: "literal" as const, value: "" },
        },
      ],
    },
  };
  expect([...triggerStepErrors(incomplete, document.design)]).toEqual([
    [`condition:${condition.id}`, "Request number is required."],
  ]);
  expect([...triggerStepErrors(recordTrigger, document.design)]).toEqual([]);
});

test("a refused trigger save keeps the request's reference with the draft's words", () => {
  // S1-C4, D1.6 (docs/specs/system-health.md): the page's save failure keeps
  // the failed request's reference; a local failure has none (S1-C5).
  const reference = "019a4c2e-7b1d-7c3e-9f00-4f9c2e1a0b2c";
  const words =
    "The trigger change could not be saved. Your draft is still available.";
  expect(
    triggerSaveFailure(
      new SandboxCommandError(
        "This Sandbox change could not be saved.",
        reference,
      ),
    ),
  ).toEqual({ message: words, reference });
  expect(triggerSaveFailure(new Error("Sandbox is still loading."))).toEqual({
    message: words,
    reference: undefined,
  });
});
