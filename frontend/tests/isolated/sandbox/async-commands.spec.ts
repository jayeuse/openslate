import { expect, test } from "@playwright/test";
import {
  applySandboxRuntimeCommand,
  emptySandboxSimulation,
  initialSandboxVersions,
} from "../../../src/components/systems/sandbox/state/async";
import {
  createSampleRuntime,
  type SampleDecoder,
} from "../../../src/components/systems/shared/runtime/sample-runtime";
import {
  initialDesign,
  initialSandboxHistory,
  type Design,
} from "../../../src/components/systems/sandbox/domain/model";

const decode: SampleDecoder = <T>(_key: string, value: unknown, initial: T) =>
  value === undefined ? initial : (value as T);

function runtime() {
  return createSampleRuntime(decode, {
    "sandbox.design": initialSandboxHistory,
    "sandbox.versions": initialSandboxVersions,
    "sandbox.simulation": emptySandboxSimulation,
  });
}

function changedDesign(name: string): Design {
  return {
    ...initialDesign,
    departments: initialDesign.departments.map((department, index) =>
      index === 0 ? { ...department, name } : department,
    ),
  };
}

test("sandbox design commands evaluate functional updates against latest state", async () => {
  const sample = runtime();
  const pending = sample.execute(
    (draft) =>
      applySandboxRuntimeCommand(draft, {
        type: "change-design",
        update: (design) =>
          changedDesign(`${design.departments[0].name} + later`),
      }),
    { keys: ["sandbox.design"] },
  );
  sample.commit((draft) =>
    draft.update("sandbox.design", initialSandboxHistory, {
      ...initialSandboxHistory,
      present: changedDesign("Intervening edit"),
    }),
  );
  await expect(pending).resolves.toMatchObject({ ok: true });
  const stored = sample.getSnapshot()["sandbox.design"] as {
    present: Design;
  };
  expect(stored.present.departments[0].name).toBe("Intervening edit + later");
});

test("import stages its recovery checkpoint and design replacement atomically", async () => {
  const sample = runtime();
  const imported = changedDesign("Imported operations");
  const result = await sample.execute(
    (draft) =>
      applySandboxRuntimeCommand(draft, {
        type: "import",
        file: {
          kind: "openslate-sandbox",
          schemaVersion: 1,
          design: imported,
        },
      }),
    { keys: ["sandbox.design", "sandbox.versions"] },
  );
  expect(result).toMatchObject({ ok: true });
  const snapshot = sample.getSnapshot();
  expect((snapshot["sandbox.design"] as { present: Design }).present).toEqual(
    imported,
  );
  expect(snapshot["sandbox.versions"]).toHaveLength(2);
  expect(
    (snapshot["sandbox.versions"] as { label: string }[]).at(-1)?.label,
  ).toBe("Before import");
});

test("release rejection leaves design and versions untouched", async () => {
  const sample = runtime();
  const invalid = {
    ...initialDesign,
    relationships: [
      {
        id: "broken-link",
        name: "Broken",
        source: "missing-module",
        target: initialDesign.modules[0].id,
        cardinality: "One-to-many",
      },
    ],
  };
  sample.commit((draft) =>
    draft.update("sandbox.design", initialSandboxHistory, {
      ...initialSandboxHistory,
      present: invalid,
    }),
  );
  const beforeVersions = sample.getSnapshot()["sandbox.versions"];
  const result = await sample.execute(
    (draft) => applySandboxRuntimeCommand(draft, { type: "release", note: "" }),
    { keys: ["sandbox.design", "sandbox.versions"] },
  );
  expect(result).toMatchObject({ ok: false });
  expect(sample.getSnapshot()["sandbox.versions"]).toBe(beforeVersions);
  expect(
    (sample.getSnapshot()["sandbox.design"] as { present: Design }).present,
  ).toEqual(invalid);
});

test("rollback publishes the restored design and local release together", async () => {
  const sample = runtime();
  const target = changedDesign("Rollback target");
  const targetVersion = {
    id: "checkpoint-target",
    label: "Target checkpoint",
    design: target,
    published: false,
    date: "Test",
  };
  sample.commit((draft) =>
    draft.update("sandbox.versions", initialSandboxVersions, [
      ...initialSandboxVersions,
      targetVersion,
    ]),
  );
  const notifications: unknown[] = [];
  sample.subscribe(() => notifications.push(sample.getSnapshot()));
  const result = await sample.execute(
    (draft) =>
      applySandboxRuntimeCommand(draft, {
        type: "rollback-version",
        id: targetVersion.id,
      }),
    { keys: ["sandbox.design", "sandbox.versions"] },
  );
  expect(result).toMatchObject({ ok: true });
  expect(notifications).toHaveLength(1);
  const snapshot = sample.getSnapshot();
  expect((snapshot["sandbox.design"] as { present: Design }).present).toEqual(
    target,
  );
  expect(
    (snapshot["sandbox.versions"] as { label: string }[]).at(-1)?.label,
  ).toBe("Rollback to Target checkpoint");
});

test("version deletion protects the latest published release while allowing newer checkpoints", async () => {
  const latestCheckpoint = {
    id: "newest-checkpoint",
    label: "Newest checkpoint",
    design: initialDesign,
    published: false,
    date: "Test",
  };
  const withCheckpoint = runtime();
  withCheckpoint.commit((draft) =>
    draft.update("sandbox.versions", initialSandboxVersions, [
      ...initialSandboxVersions,
      latestCheckpoint,
    ]),
  );

  await expect(
    withCheckpoint.execute(
      (draft) =>
        applySandboxRuntimeCommand(draft, {
          type: "delete-version",
          id: latestCheckpoint.id,
        }),
      { keys: ["sandbox.versions"] },
    ),
  ).resolves.toMatchObject({ ok: true });

  const protectedRelease = runtime();
  protectedRelease.commit((draft) =>
    draft.update("sandbox.versions", initialSandboxVersions, [
      ...initialSandboxVersions,
      latestCheckpoint,
    ]),
  );
  await expect(
    protectedRelease.execute(
      (draft) =>
        applySandboxRuntimeCommand(draft, {
          type: "delete-version",
          id: initialSandboxVersions[0].id,
        }),
      { keys: ["sandbox.versions"] },
    ),
  ).resolves.toMatchObject({ ok: false });

  const soleVersion = runtime();
  soleVersion.commit((draft) =>
    draft.update("sandbox.versions", initialSandboxVersions, [
      latestCheckpoint,
    ]),
  );
  await expect(
    soleVersion.execute(
      (draft) =>
        applySandboxRuntimeCommand(draft, {
          type: "delete-version",
          id: latestCheckpoint.id,
        }),
      { keys: ["sandbox.versions"] },
    ),
  ).resolves.toMatchObject({ ok: false });
});
