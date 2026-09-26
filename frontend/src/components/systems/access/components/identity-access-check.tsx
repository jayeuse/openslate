"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  CircleSlash2,
  LoaderCircle,
  ShieldQuestion,
} from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { ApiError } from "@/lib/api";

import type { AccessCheckReason, AccessCheckResponse } from "../state/api";
import type { AccessController } from "../state/controller";
import {
  accessCheckSelectionKey,
  createSimulatorCheckState,
  simulatorCheckReducer,
  simulatorCheckStateForSelection,
} from "../state/simulator-check";

export type IdentityAccessCheckProps = {
  controller: AccessController;
  identityId: string;
};

const reasonDescriptions: Record<AccessCheckReason, string> = {
  administrator_protected: "Administrator access is protected.",
  principal_inactive: "This identity is inactive.",
  principal_deleted: "This identity has been removed.",
  principal_expired: "This identity has expired.",
  invalid_input: "The check could not be validated, so access was denied.",
  invalid_rule: "An access rule could not be validated, so access was denied.",
  rule_allow: "An access rule allows this action.",
  rule_deny: "An access rule denies this action.",
  legacy_role_allow: "The identity’s assigned role allows this action.",
  default_deny: "No access rule or role allows this action.",
};

function sourceDescription(result: AccessCheckResponse): string {
  if (result.source_rule_id) return "Access rule";

  if (result.reason === "administrator_protected")
    return "Protected administrator access";
  if (result.reason === "legacy_role_allow") return "Assigned role";
  if (result.reason === "default_deny") return "Workspace default policy";
  return "Workspace access policy";
}

function checkedAtLabel(checkedAt: string): string {
  return new Date(checkedAt).toLocaleString();
}

function userFacingCheckError(error: unknown): string {
  if (
    error instanceof Error &&
    error.message.includes("selected identity is no longer available")
  ) {
    return "That identity is no longer available. Refresh Access, then try again.";
  }
  if (
    error instanceof Error &&
    error.message.includes("selected action is no longer available")
  ) {
    return "That action is no longer available. Refresh Access, then try again.";
  }
  if (error instanceof ApiError) {
    if (error.status === 401)
      return "Your session has expired. Sign in again, then retry the check.";
    if (error.status === 403)
      return "An Access administrator account is required to run this check.";
    if (error.status === 404 || error.status === 409)
      return "The identity changed while checking. Refresh Access, then try again.";
    if (error.status === 503)
      return "Access policy data is temporarily unavailable. Try again shortly.";
  }
  return "Access could not be checked. Try again; if it keeps failing, ask an Access administrator.";
}

function detailLabel(result: AccessCheckResponse): string {
  if (
    result.principal_kind === "service" &&
    result.policy_decision === "allow" &&
    !result.runtime_supported
  ) {
    return "Sign-in unavailable";
  }
  return result.policy_decision === "allow" ? "Allowed" : "Denied";
}

export function IdentityAccessCheck({
  controller,
  identityId: selectedIdentityId,
}: IdentityAccessCheckProps) {
  const { state, actions, permissionCatalog, scopeCatalog } = controller;
  const [requestedPermissionId, setRequestedPermissionId] = useState(
    permissionCatalog[0]?.id ?? "",
  );
  const [requestedScopeId, setRequestedScopeId] = useState(
    scopeCatalog.find((scope) => scope.kind === "workspace")?.id ?? "",
  );
  const activeCheck = useRef<AbortController | null>(null);
  const generation = useRef(0);

  const identity = state.identities.find(
    (candidate) => candidate.id === selectedIdentityId,
  );
  const identityId = identity?.id ?? "";
  const workspaceScopes = scopeCatalog.filter(
    (scope) => scope.kind === "workspace",
  );
  const selectedScope =
    workspaceScopes.find((scope) => scope.id === requestedScopeId) ??
    workspaceScopes[0];
  const scopeId = selectedScope?.id ?? "";
  const compatiblePermissions = permissionCatalog.filter(
    (permission) => permission.product === selectedScope?.product,
  );
  const selectedPermission =
    compatiblePermissions.find(
      (permission) => permission.id === requestedPermissionId,
    ) ?? compatiblePermissions[0];
  const permissionId = selectedPermission?.id ?? "";

  const selectionKey = accessCheckSelectionKey({
    selection: { identityId, permissionId, scopeId },
    identityCatalog: state.identities,
    permissionCatalog: compatiblePermissions,
    scopeCatalog: workspaceScopes,
  });
  const [checkState, dispatchCheck] = useReducer(
    simulatorCheckReducer,
    selectionKey,
    createSimulatorCheckState,
  );
  const selectionKeyRef = useRef(selectionKey);
  const previousSelectionKey = useRef(selectionKey);
  const { result, error, status } = simulatorCheckStateForSelection(
    checkState,
    selectionKey,
  );

  function clearCheck() {
    generation.current += 1;
    activeCheck.current?.abort();
    activeCheck.current = null;
    dispatchCheck({ type: "cleared" });
  }

  useEffect(() => {
    selectionKeyRef.current = selectionKey;
    if (previousSelectionKey.current === selectionKey) return;
    previousSelectionKey.current = selectionKey;
    generation.current += 1;
    activeCheck.current?.abort();
    activeCheck.current = null;
    dispatchCheck({ type: "selection-changed", selectionKey });
  }, [selectionKey]);

  useEffect(
    () => () => {
      generation.current += 1;
      activeCheck.current?.abort();
    },
    [],
  );

  async function evaluate() {
    if (!identityId || !permissionId || !selectedScope) {
      clearCheck();
      dispatchCheck({
        type: "failed",
        selectionKey,
        error: "Choose an identity, resource, and action before checking.",
      });
      return;
    }

    activeCheck.current?.abort();
    const request = new AbortController();
    const requestSelectionKey = selectionKey;
    const requestGeneration = ++generation.current;
    activeCheck.current = request;
    dispatchCheck({ type: "started", selectionKey: requestSelectionKey });

    try {
      const nextResult = await actions.checkAccess(
        identityId,
        permissionId,
        request.signal,
      );
      if (
        request.signal.aborted ||
        generation.current !== requestGeneration ||
        requestSelectionKey !== selectionKeyRef.current
      )
        return;
      dispatchCheck({
        type: "succeeded",
        selectionKey: requestSelectionKey,
        result: nextResult,
      });
    } catch (checkError) {
      if (
        request.signal.aborted ||
        generation.current !== requestGeneration ||
        requestSelectionKey !== selectionKeyRef.current
      )
        return;
      dispatchCheck({
        type: "failed",
        selectionKey: requestSelectionKey,
        error: userFacingCheckError(checkError),
      });
    } finally {
      if (activeCheck.current === request) activeCheck.current = null;
    }
  }

  const serviceRuntimeUnavailable =
    result?.principal_kind === "service" &&
    result.policy_decision === "allow" &&
    !result.runtime_supported;
  const resultTitle = result ? detailLabel(result) : "";
  const source = result ? sourceDescription(result) : "";
  const checkStatusMessage =
    status === "checking"
      ? "Checking access…"
      : status === "complete"
        ? "Access check complete."
        : "";

  return (
    <section
      aria-labelledby="identity-check-title"
      className="flex flex-col gap-3"
    >
      <div>
        <h3 id="identity-check-title" className="font-semibold">
          Check access
        </h3>
        <p className="text-muted-foreground mt-1 text-sm">
          See whether {identity?.name ?? "this identity"} can perform an action.
          This does not change access.
        </p>
      </div>
      {!controller.availability.simulator ? (
        <Alert variant="warning">
          Access checks will be available after policy enforcement is live.
        </Alert>
      ) : null}

      <div className="min-w-0 space-y-5">
        <Card>
          <CardContent className="p-4">
            <FieldGroup className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="simulator-resource">Resource</FieldLabel>
                <NativeSelect
                  id="simulator-resource"
                  className="w-full [&>select]:min-h-11"
                  value={scopeId}
                  onChange={(event) => {
                    clearCheck();
                    setRequestedScopeId(event.target.value);
                  }}
                >
                  {workspaceScopes.length ? (
                    workspaceScopes.map((scope) => (
                      <NativeSelectOption key={scope.id} value={scope.id}>
                        {scope.name}
                      </NativeSelectOption>
                    ))
                  ) : (
                    <NativeSelectOption value="">
                      No supported resources
                    </NativeSelectOption>
                  )}
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="simulator-action">Action</FieldLabel>
                <NativeSelect
                  id="simulator-action"
                  className="w-full [&>select]:min-h-11"
                  value={permissionId}
                  onChange={(event) => {
                    clearCheck();
                    setRequestedPermissionId(event.target.value);
                  }}
                >
                  {compatiblePermissions.length ? (
                    compatiblePermissions.map((permission) => (
                      <NativeSelectOption
                        key={permission.id}
                        value={permission.id}
                      >
                        {permission.name}
                      </NativeSelectOption>
                    ))
                  ) : (
                    <NativeSelectOption value="">
                      No actions available
                    </NativeSelectOption>
                  )}
                </NativeSelect>
              </Field>
              <div className="sm:col-span-2">
                <Button
                  type="button"
                  className="min-h-11 w-full"
                  disabled={
                    !controller.availability.simulator ||
                    !identityId ||
                    !permissionId ||
                    !scopeId ||
                    status === "checking"
                  }
                  onClick={() => void evaluate()}
                >
                  {status === "checking" ? (
                    <>
                      <LoaderCircle
                        aria-hidden="true"
                        className="animate-spin motion-reduce:animate-none"
                      />
                      Checking access…
                    </>
                  ) : status === "error" ? (
                    "Try again"
                  ) : (
                    "Check access"
                  )}
                </Button>
              </div>
            </FieldGroup>
            <p className="text-muted-foreground mt-4 text-xs leading-relaxed">
              <ShieldQuestion
                aria-hidden="true"
                className="mr-1 inline size-4"
              />
              This read-only check uses current workspace policy. Workspace is
              the only supported resource.
            </p>
          </CardContent>
        </Card>
        <div className="min-w-0 space-y-4">
          <p
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="sr-only"
          >
            {checkStatusMessage}
          </p>
          {error ? (
            <Alert role="alert" aria-live="assertive" variant="destructive">
              {error}
            </Alert>
          ) : null}

          {result ? (
            <Card aria-label="Access check result" className="overflow-hidden">
              <CardHeader
                className={`flex-row items-center gap-4 border-b px-5 py-6 sm:px-6 [&>svg]:size-8 ${serviceRuntimeUnavailable ? "bg-amber-500/5" : result.policy_decision === "allow" ? "bg-success/5" : "bg-destructive/5"}`}
              >
                {serviceRuntimeUnavailable ? (
                  <ShieldQuestion aria-hidden="true" />
                ) : result.policy_decision === "allow" ? (
                  <CheckCircle2 aria-hidden="true" />
                ) : (
                  <CircleSlash2 aria-hidden="true" />
                )}
                <div>
                  <CardTitle
                    className={`text-2xl font-semibold tracking-tight ${serviceRuntimeUnavailable ? "text-foreground" : result.policy_decision === "allow" ? "text-success" : "text-destructive"}`}
                  >
                    {resultTitle}
                  </CardTitle>
                  <p className="text-muted-foreground text-sm">
                    {identity?.name ?? "Selected identity"} ·{" "}
                    {selectedPermission?.name ?? "Selected action"} · Workspace
                  </p>
                </div>
              </CardHeader>
              <CardContent className="grid gap-5 border-b px-5 py-5 sm:grid-cols-2 sm:px-6">
                {serviceRuntimeUnavailable ? (
                  <Alert variant="warning" className="sm:col-span-2">
                    Policy permits, but service sign-in is unavailable.
                  </Alert>
                ) : null}
                <div>
                  <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                    Reason
                  </p>
                  <p className="mt-1 text-sm">
                    {reasonDescriptions[result.reason]}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                    Source
                  </p>
                  <p className="mt-1 text-sm">{source}</p>
                </div>
              </CardContent>
              <CardContent
                aria-label="Access decision explanation"
                className="px-5 pb-5 sm:px-6"
              >
                <details className="group">
                  <summary className="focus-visible:outline-ring flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 focus-visible:outline-2 focus-visible:outline-offset-2">
                    <h3 className="text-sm font-semibold">Check context</h3>
                    <ChevronDown
                      aria-hidden="true"
                      className="size-4 group-open:rotate-180"
                    />
                  </summary>
                  <dl className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                        Identity
                      </dt>
                      <dd className="mt-1 text-sm">
                        {identity?.name ?? "Unknown identity"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                        Action
                      </dt>
                      <dd className="mt-1 text-sm">
                        {selectedPermission?.name ?? "Unknown action"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                        Resource
                      </dt>
                      <dd className="mt-1 text-sm">Workspace</dd>
                    </div>
                    {result.principal_kind === "service" ? (
                      <div>
                        <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                          Service sign-in
                        </dt>
                        <dd className="mt-1 text-sm">
                          {result.runtime_supported
                            ? "Available"
                            : "Unavailable"}
                        </dd>
                      </div>
                    ) : null}
                  </dl>
                </details>
                <details className="group mt-4 border-t pt-2">
                  <summary className="focus-visible:outline-ring flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2">
                    <span>Technical details</span>
                    <ChevronDown
                      aria-hidden="true"
                      className="size-4 shrink-0 transition-transform group-open:rotate-180 motion-reduce:transition-none"
                    />
                  </summary>
                  <dl className="mt-3 grid gap-4 sm:grid-cols-2">
                    <div>
                      <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                        Policy revision
                      </dt>
                      <dd className="mt-1 text-sm">{result.policy_revision}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                        Action ID
                      </dt>
                      <dd className="mt-1 text-sm break-all">
                        {result.permission_id}
                      </dd>
                    </div>
                    <div className="sm:col-span-2">
                      <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                        Source rule ID
                      </dt>
                      <dd className="mt-1 text-sm break-all">
                        {result.source_rule_id ?? "No individual rule"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                        Checked at
                      </dt>
                      <dd className="mt-1 text-sm">
                        <time dateTime={result.checked_at}>
                          {checkedAtLabel(result.checked_at)}
                        </time>
                      </dd>
                    </div>
                  </dl>
                </details>
              </CardContent>
            </Card>
          ) : (
            <div className="flex flex-col items-center justify-center gap-3 px-4 py-6 text-center">
              <ShieldQuestion
                aria-hidden="true"
                className="text-muted-foreground size-6"
              />
              <h3 className="font-semibold">
                {status === "checking"
                  ? "Checking current access…"
                  : error
                    ? "No result available"
                    : "Understand a permission before you change it"}
              </h3>
              <p className="text-muted-foreground max-w-md text-sm">
                When someone cannot view or change something, check here to see
                whether a role, an access rule, or the workspace default
                explains why.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
