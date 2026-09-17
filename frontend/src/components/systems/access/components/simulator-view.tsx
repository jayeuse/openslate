"use client";

import { useState } from "react";
import {
  CheckCircle2,
  CircleSlash2,
  GitBranch,
  ShieldQuestion,
} from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from "@/components/ui/native-select";

import type { AccessController } from "../state/controller";
import type { AccessScopeRef, EffectiveAccessResult } from "../domain/policy";

export type SimulatorViewProps = { controller: AccessController };

function groupByProduct<T extends { product: string }>(items: readonly T[]) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.product) ?? [];
    group.push(item);
    groups.set(item.product, group);
  }
  return groups;
}

function traceLabel(entry: EffectiveAccessResult["trace"][number]): string {
  if (entry.overriddenByRuleId) return `overridden ${entry.outcome}`;
  if (entry.outcome === "inherit") return "inherited";
  return entry.outcome;
}

type SimulationScopeEntry = AccessScopeRef & { parentId?: string };

function simulationScopePath(
  scopeCatalog: readonly SimulationScopeEntry[],
  selectedScope: SimulationScopeEntry,
): AccessScopeRef[] {
  const scopesById = new Map(scopeCatalog.map((scope) => [scope.id, scope]));
  const path: AccessScopeRef[] = [];
  const seen = new Set<string>();
  let current: SimulationScopeEntry | undefined = selectedScope;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift({ kind: current.kind, id: current.id });
    current = current.parentId ? scopesById.get(current.parentId) : undefined;
  }
  return path;
}

export function SimulatorView({ controller }: SimulatorViewProps) {
  const { state, actions, permissionCatalog, scopeCatalog } = controller;
  const [identityId, setIdentityId] = useState(state.identities[0]?.id ?? "");
  const [permissionId, setPermissionId] = useState(
    permissionCatalog[0]?.id ?? "",
  );
  const [scopeId, setScopeId] = useState(scopeCatalog[0]?.id ?? "");
  const [evaluationTime] = useState(() => new Date().toISOString());
  const [result, setResult] = useState<EffectiveAccessResult | null>(null);
  const [error, setError] = useState("");

  const selectedScope = scopeCatalog.find((scope) => scope.id === scopeId);
  const compatiblePermissions = permissionCatalog.filter(
    (permission) => permission.product === selectedScope?.product,
  );
  const selectedPermission = compatiblePermissions.find(
    (permission) => permission.id === permissionId,
  );
  function evaluate() {
    if (!identityId || !permissionId || !selectedScope) {
      setResult(null);
      setError("Choose a known identity, resource, and action.");
      return;
    }
    const scopePath = simulationScopePath(scopeCatalog, selectedScope);
    const outcome = actions.resolveAccess({
      identityId,
      permissionId,
      scopePath,
      now: evaluationTime,
    });
    setError("");
    setResult(outcome);
  }

  return (
    <section aria-labelledby="simulator-title" className="flex flex-col gap-3">
      <div>
        <h2
          id="simulator-title"
          className="text-xl font-semibold tracking-tight"
        >
          Access simulator
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Explain a deterministic access decision without changing policy.
        </p>
      </div>

      <Alert variant="warning">
        <ShieldQuestion aria-hidden="true" className="mr-2 inline" />
        This simulator is read-only. Unknown identities, resources, actions, or
        policy references fail closed to deny.
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>Evaluation input</CardTitle>
        </CardHeader>
        <CardContent>
          <FieldGroup className="grid gap-4 lg:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="simulator-identity">Identity</FieldLabel>
              <NativeSelect
                id="simulator-identity"
                className="w-full [&>select]:min-h-11"
                value={identityId}
                onChange={(event) => {
                  setIdentityId(event.target.value);
                  setResult(null);
                }}
              >
                {state.identities.map((identity) => (
                  <NativeSelectOption key={identity.id} value={identity.id}>
                    {identity.name} · {identity.kind}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="simulator-resource">Resource</FieldLabel>
              <NativeSelect
                id="simulator-resource"
                className="w-full [&>select]:min-h-11"
                value={scopeId}
                onChange={(event) => {
                  const nextScopeId = event.target.value;
                  const nextScope = scopeCatalog.find(
                    (scope) => scope.id === nextScopeId,
                  );
                  const nextPermission = permissionCatalog.find(
                    (permission) => permission.product === nextScope?.product,
                  );
                  setScopeId(nextScopeId);
                  setPermissionId(nextPermission?.id ?? "");
                  setResult(null);
                }}
              >
                {[...groupByProduct(scopeCatalog).entries()].map(
                  ([product, scopes]) => (
                    <NativeSelectOptGroup key={product} label={product}>
                      {scopes.map((scope) => (
                        <NativeSelectOption key={scope.id} value={scope.id}>
                          {scope.name} · {scope.kind}
                        </NativeSelectOption>
                      ))}
                    </NativeSelectOptGroup>
                  ),
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
                  setPermissionId(event.target.value);
                  setResult(null);
                }}
              >
                {[...groupByProduct(compatiblePermissions).entries()].map(
                  ([product, permissions]) => (
                    <NativeSelectOptGroup key={product} label={product}>
                      {permissions.map((permission) => (
                        <NativeSelectOption
                          key={permission.id}
                          value={permission.id}
                        >
                          {permission.name}
                        </NativeSelectOption>
                      ))}
                    </NativeSelectOptGroup>
                  ),
                )}
              </NativeSelect>
              <FieldDescription>
                {selectedPermission?.id ?? "No action selected"}
              </FieldDescription>
            </Field>
            <div className="lg:col-span-3">
              <Button
                type="button"
                className="min-h-11 w-full sm:w-auto"
                onClick={evaluate}
              >
                Evaluate access
              </Button>
            </div>
          </FieldGroup>
        </CardContent>
      </Card>

      {error ? (
        <Alert role="alert" variant="destructive">
          Denied safely: {error}
        </Alert>
      ) : null}

      {result ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <Card aria-label="Simulator result">
            <CardHeader className="flex-row items-center gap-3">
              {result.decision === "allow" ? (
                <CheckCircle2 aria-hidden="true" />
              ) : (
                <CircleSlash2 aria-hidden="true" />
              )}
              <div>
                <CardTitle className="capitalize">{result.decision}</CardTitle>
                <p className="text-muted-foreground text-sm">
                  Deterministic policy result
                </p>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div>
                <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  Reason
                </p>
                <p className="mt-1 text-sm">{result.reason}</p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  Source
                </p>
                <p className="mt-1 text-sm">
                  {result.source
                    ? `${result.source.ruleId}${result.source.locked ? " · locked ancestor" : ""}`
                    : "Default or protected-role policy"}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  Prerequisites checked
                </p>
                <ul className="mt-2 flex flex-col gap-2">
                  {result.prerequisites.map((prerequisite) => (
                    <li
                      key={prerequisite.id}
                      className="flex flex-col gap-1 rounded-lg border p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-medium">
                          {prerequisite.label}
                        </span>
                        <Badge
                          variant={
                            prerequisite.passed ? "success" : "destructive"
                          }
                        >
                          {prerequisite.passed ? "Passed" : "Failed"}
                        </Badge>
                      </div>
                      <span className="text-muted-foreground text-xs">
                        {prerequisite.reason}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="text-muted-foreground mt-2 text-xs">
                  Evaluated at {evaluationTime} so repeated checks in this view
                  use the same clock.
                </p>
              </div>
              {result.invalid ? (
                <Badge variant="destructive">
                  Invalid input or rule reference · failed closed
                </Badge>
              ) : null}
            </CardContent>
          </Card>

          <Card aria-label="Evaluation trace">
            <CardHeader className="flex-row items-center gap-2">
              <GitBranch aria-hidden="true" />
              <CardTitle>Ordered trace</CardTitle>
            </CardHeader>
            <CardContent>
              {result.trace.length ? (
                <ol className="flex flex-col gap-3">
                  {result.trace.map((entry, index) => {
                    const label = traceLabel(entry);
                    const subject = entry.subject;
                    const subjectName = (() => {
                      if (subject.kind === "everyone") return "Everyone";
                      const subjectId = subject.id;
                      if (subject.kind === "role")
                        return (
                          state.roles.find((role) => role.id === subjectId)
                            ?.name ?? subjectId
                        );
                      if (subject.kind === "group")
                        return (
                          state.groups.find((group) => group.id === subjectId)
                            ?.name ?? subjectId
                        );
                      return (
                        state.identities.find(
                          (identity) => identity.id === subjectId,
                        )?.name ?? subjectId
                      );
                    })();
                    const scopeName =
                      scopeCatalog.find(
                        (scope) =>
                          scope.kind === entry.scope.kind &&
                          scope.id === entry.scope.id,
                      )?.name ?? entry.scope.id;
                    return (
                      <li
                        key={`${entry.ruleId}:${index}`}
                        className="grid grid-cols-[2rem_minmax(0,1fr)] items-start gap-3 rounded-lg border p-3 sm:grid-cols-[2rem_minmax(0,1fr)_auto]"
                      >
                        <span className="bg-muted flex size-8 items-center justify-center rounded-full text-xs font-semibold">
                          {index + 1}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-mono text-xs">
                            {entry.ruleId}
                          </p>
                          <p className="mt-1 text-sm">
                            {entry.subject.kind}: {subjectName} ·{" "}
                            {entry.scope.kind}: {scopeName}
                          </p>
                          <p className="text-muted-foreground mt-1 text-xs">
                            Scope specificity {entry.scopeSpecificity} · Subject
                            priority {entry.subjectPriority}. {entry.reason}
                            {entry.overriddenByRuleId
                              ? ` Overridden by ${entry.overriddenByRuleId}.`
                              : ""}
                          </p>
                        </div>
                        <Badge
                          className="col-start-2 sm:col-start-3"
                          variant={
                            label.includes("invalid")
                              ? "destructive"
                              : label.includes("expired") ||
                                  label.includes("overridden")
                                ? "warning"
                                : "secondary"
                          }
                        >
                          {entry.selected ? `Selected · ${label}` : label}
                        </Badge>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className="text-muted-foreground text-sm">
                  No individual rule was evaluated. The decision came from a
                  protected role or default deny.
                </p>
              )}
              <p className="text-muted-foreground mt-4 text-xs">
                Trace labels distinguish inherited, overridden, expired,
                not-started, invalid, and directly applied rules.
              </p>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </section>
  );
}
