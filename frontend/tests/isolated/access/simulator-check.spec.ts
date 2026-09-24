import { expect, test } from "@playwright/test";

import {
  accessCheckSelectionKey,
  createSimulatorCheckState,
  simulatorCheckReducer,
  simulatorCheckStateForSelection,
} from "../../../src/components/systems/access/state/simulator-check";
import type { AccessCheckResponse } from "../../../src/components/systems/access/state/api";
import type {
  PermissionCatalogEntry,
  ScopeCatalogEntry,
} from "../../../src/components/systems/access/domain/controller-utils";
import type { InternalIdentity } from "../../../src/components/systems/access/domain/policy";

const selectedIdentity: InternalIdentity = {
  kind: "internal",
  id: "removed-person",
  name: "Ari Kim",
  email: "ari@example.com",
  status: "active",
  roleId: "operator-role",
  groupIds: [],
  departmentIds: [],
  primaryDepartmentId: "",
  title: "Operator",
};
const fallbackIdentity: InternalIdentity = {
  ...selectedIdentity,
  id: "fallback-person",
  name: "Sam Rivera",
  email: "sam@example.com",
};
const workspace: ScopeCatalogEntry = {
  kind: "workspace",
  id: "workspace",
  name: "Workspace",
  product: "Sandbox/core",
};
const readPermission: PermissionCatalogEntry = {
  id: "records.read",
  name: "Read records",
  product: "Sandbox/core",
};
const writePermission: PermissionCatalogEntry = {
  id: "records.write",
  name: "Update records",
  product: "Sandbox/core",
};

function checkResult(principalId: string): AccessCheckResponse {
  return {
    principal_kind: "user",
    principal_id: principalId,
    permission_id: "records.read",
    scope_kind: "workspace",
    policy_decision: "allow",
    reason: "rule_allow",
    source_rule_id: null,
    policy_revision: 3,
    checked_at: "2026-09-23T00:00:00Z",
    runtime_supported: true,
  };
}

test("catalog removal hides a pending check result and binds the next result to fallback selections", async () => {
  const previousSelection = {
    identityId: selectedIdentity.id,
    permissionId: writePermission.id,
    scopeId: workspace.id,
  };
  const previousKey = accessCheckSelectionKey({
    selection: previousSelection,
    identityCatalog: [selectedIdentity, fallbackIdentity],
    permissionCatalog: [writePermission, readPermission],
    scopeCatalog: [workspace],
  });
  const pending = simulatorCheckReducer(
    createSimulatorCheckState(previousKey),
    { type: "started", selectionKey: previousKey },
  );
  let resolveOldCheck: (result: AccessCheckResponse) => void = () => {
    throw new Error("The old access check was not started.");
  };
  const oldResponse = new Promise<AccessCheckResponse>((resolve) => {
    resolveOldCheck = resolve;
  });

  const fallbackSelection = {
    identityId: fallbackIdentity.id,
    permissionId: readPermission.id,
    scopeId: workspace.id,
  };
  const refreshedKey = accessCheckSelectionKey({
    selection: fallbackSelection,
    identityCatalog: [fallbackIdentity],
    permissionCatalog: [readPermission],
    scopeCatalog: [workspace],
  });
  expect(refreshedKey).not.toBe(previousKey);

  const refreshed = simulatorCheckReducer(pending, {
    type: "selection-changed",
    selectionKey: refreshedKey,
  });
  expect(refreshed).toMatchObject({
    selectionKey: refreshedKey,
    status: "idle",
    result: null,
    error: "",
  });

  const staleCompletion = oldResponse.then((result) =>
    simulatorCheckReducer(refreshed, {
      type: "succeeded",
      selectionKey: previousKey,
      result,
    }),
  );
  resolveOldCheck(checkResult(selectedIdentity.id));
  expect(
    simulatorCheckStateForSelection(await staleCompletion, refreshedKey),
  ).toMatchObject({
    status: "idle",
    result: null,
  });

  const fallbackPending = simulatorCheckReducer(refreshed, {
    type: "started",
    selectionKey: refreshedKey,
  });
  let resolveFallbackCheck: (result: AccessCheckResponse) => void = () => {
    throw new Error("The fallback access check was not started.");
  };
  const fallbackResponse = new Promise<AccessCheckResponse>((resolve) => {
    resolveFallbackCheck = resolve;
  });
  const fallbackCompletion = fallbackResponse.then((result) =>
    simulatorCheckReducer(fallbackPending, {
      type: "succeeded",
      selectionKey: refreshedKey,
      result,
    }),
  );
  resolveFallbackCheck(checkResult(fallbackIdentity.id));
  expect(
    simulatorCheckStateForSelection(await fallbackCompletion, refreshedKey),
  ).toMatchObject({
    status: "complete",
    result: { principal_id: fallbackIdentity.id },
  });
});
