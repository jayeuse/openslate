import * as S from "../contract/schemas";
import type * as C from "../contract/types";
import { notFound, policyFailure } from "../domain/access";
import { scopeKey } from "../domain/policy-scope";
import { invalidInput } from "../domain/settings";
import type { MemoryHandle } from "./store-types";

export type MemoryCapabilityTarget = Readonly<{
  scope: C.SettingsScope;
  capability: C.Capability;
}>;
export interface MemoryAvailabilityAuthority {
  assertCapabilityAvailable(
    context: C.CommsContext,
    target: MemoryCapabilityTarget,
  ): void;
  assertInspectionAvailable(
    context: C.CommsContext,
    scope: C.SettingsScope,
  ): void;
}
export interface MemoryClientBinding {
  readonly handle: MemoryHandle;
  readonly authority: MemoryAvailabilityAuthority;
}

export function capabilityDenied(): never {
  return policyFailure({
    status: 403,
    body: {
      detail: {
        code: "comms_capability_denied",
        message: "Capability required",
      },
    },
  });
}

/** Availability is checked only after the caller's genuine core decision. */
export function requireAvailable(
  binding: MemoryClientBinding,
  context: C.CommsContext,
  target: MemoryCapabilityTarget,
  decision: C.CapabilityDecision,
) {
  if (!decision.allowed) capabilityDenied();
  binding.authority.assertCapabilityAvailable(context, target);
}

export function assertRequestActive(options?: C.RequestOptions) {
  if (options?.signal?.aborted)
    throw Object.assign(new Error("OpenComms operation cancelled"), {
      kind: "cancelled" as const,
    });
}

/** Internal owner, shared by runtime composition and real family fixtures. */
export function createMemoryAvailability(input: C.CommsContext) {
  const parsed = S.commsContextSchema.safeParse(input);
  if (!parsed.success) return invalidInput();
  const context = Object.freeze(parsed.data);
  let denied: MemoryCapabilityTarget | null = null;
  const assertCurrent = (caller: C.CommsContext) => {
    if (caller.org_id !== context.org_id || caller.user_id !== context.user_id)
      notFound();
  };
  const authority: MemoryAvailabilityAuthority = {
    assertCapabilityAvailable(caller, target) {
      assertCurrent(caller);
      if (
        denied &&
        denied.capability === target.capability &&
        scopeKey(denied.scope) === scopeKey(target.scope)
      )
        capabilityDenied();
    },
    assertInspectionAvailable(caller, scope) {
      assertCurrent(caller);
      if (denied && scopeKey(denied.scope) === scopeKey(scope))
        capabilityDenied();
    },
  };
  return {
    authority,
    controls: {
      denyCapability(target: MemoryCapabilityTarget | null) {
        if (target === null) {
          denied = null;
          return;
        }
        const scope = S.settingsScopeSchema.safeParse(target.scope);
        const capability = S.capabilitySchema.safeParse(target.capability);
        if (!scope.success || !capability.success) return invalidInput();
        denied = { scope: scope.data, capability: capability.data };
      },
    },
  };
}
