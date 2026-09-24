import type { AccessCheckResponse } from "./api";
import type {
  PermissionCatalogEntry,
  ScopeCatalogEntry,
} from "../domain/controller-utils";
import type { AccessIdentity } from "../domain/policy";

export type SimulatorCheckStatus = "idle" | "checking" | "error" | "complete";

export type SimulatorCheckState = {
  selectionKey: string;
  status: SimulatorCheckStatus;
  result: AccessCheckResponse | null;
  error: string;
};

export type SimulatorCheckAction =
  | { type: "selection-changed"; selectionKey: string }
  | { type: "cleared" }
  | { type: "started"; selectionKey: string }
  | {
      type: "succeeded";
      selectionKey: string;
      result: AccessCheckResponse;
    }
  | { type: "failed"; selectionKey: string; error: string };

export function createSimulatorCheckState(
  selectionKey: string,
): SimulatorCheckState {
  return { selectionKey, status: "idle", result: null, error: "" };
}

export function simulatorCheckReducer(
  state: SimulatorCheckState,
  action: SimulatorCheckAction,
): SimulatorCheckState {
  if (action.type === "selection-changed") {
    return action.selectionKey === state.selectionKey
      ? state
      : createSimulatorCheckState(action.selectionKey);
  }
  if (action.type === "cleared")
    return createSimulatorCheckState(state.selectionKey);
  if (action.type === "started") {
    if (action.selectionKey !== state.selectionKey) return state;
    return {
      ...createSimulatorCheckState(state.selectionKey),
      status: "checking",
    };
  }
  if (action.type === "succeeded") {
    if (action.selectionKey !== state.selectionKey) return state;
    return {
      selectionKey: state.selectionKey,
      status: "complete",
      result: action.result,
      error: "",
    };
  }
  if (action.selectionKey !== state.selectionKey) return state;
  return {
    selectionKey: state.selectionKey,
    status: "error",
    result: null,
    error: action.error,
  };
}

export function simulatorCheckStateForSelection(
  state: SimulatorCheckState,
  selectionKey: string,
): SimulatorCheckState {
  return state.selectionKey === selectionKey
    ? state
    : createSimulatorCheckState(selectionKey);
}

export function accessCheckSelectionKey({
  selection,
  identityCatalog,
  permissionCatalog,
  scopeCatalog,
}: {
  selection: { identityId: string; permissionId: string; scopeId: string };
  identityCatalog: readonly AccessIdentity[];
  permissionCatalog: readonly PermissionCatalogEntry[];
  scopeCatalog: readonly ScopeCatalogEntry[];
}): string {
  return JSON.stringify({
    selection: [
      selection.identityId,
      selection.permissionId,
      selection.scopeId,
    ],
    identityCatalog: identityCatalog.map((identity) => [
      identity.id,
      identity.name,
      identity.kind,
      identity.status,
      identity.roleId,
      identity.groupIds,
      identity.expiresAt ?? null,
      "ownerId" in identity ? identity.ownerId : null,
      "sponsorId" in identity ? identity.sponsorId : null,
    ]),
    permissionCatalog: permissionCatalog.map((permission) => [
      permission.id,
      permission.name,
      permission.product,
    ]),
    scopeCatalog: scopeCatalog.map((scope) => [
      scope.id,
      scope.name,
      scope.product,
    ]),
  });
}
