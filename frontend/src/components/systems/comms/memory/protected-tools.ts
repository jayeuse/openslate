import type * as C from "../contract/types";
import * as S from "../contract/schemas";
import { activePerson, policyFailure } from "../domain/access";
import { scopeManagementDecision } from "../domain/capabilities";
import { scopeChain, scopeKey } from "../domain/policy-scope";
import { invalidInput } from "../domain/settings";
import {
  assertRequestActive,
  requireAvailable,
  type MemoryClientBinding,
} from "./availability";
import { configurationKey, requireScopeRead } from "./configuration-mutation";
import { compare, page } from "./conversation-structure";
import { createRetentionTools, type RetentionTools } from "./retention-tools";
import {
  createConfigurationTools,
  type ConfigurationTools,
} from "./configuration-tools";
import { createExportTools, type ExportTools } from "./export-tools";
import type { MemoryFileResources } from "./files";
import type { MemoryCommsState } from "./model";
import { invalidMemoryState } from "./snapshot";
import type { MemoryExecution, MemoryHandle, MemoryStore } from "./store-types";

export type ProtectedToolOperations = RetentionTools &
  ConfigurationTools &
  ExportTools;
export interface ProtectedToolResources {
  dispose(): void;
}
type Purpose = "retention" | "purge" | "restore" | "template";
type Receipt = Readonly<{ committed: boolean }>;
type Preview = {
  handle: MemoryHandle;
  purpose: Purpose;
  proposal: string;
  witness: string;
  started: number;
  reservation?: Receipt;
};
export interface ToolInvocation {
  readonly started: number;
  prepare(signal: AbortSignal): Promise<void>;
  assert(): void;
}
export interface ToolReservation {
  assert(witness: string): void;
  release(): void;
}
/** Internal facets only; the exported resource object exposes no proof controls. */
export interface ToolSession {
  readonly binding: MemoryClientBinding;
  readonly store: MemoryStore;
  readonly files: MemoryFileResources;
  now(): number;
  active(options?: C.RequestOptions): void;
  signal(options?: C.RequestOptions): AbortSignal;
  admin(world: Readonly<MemoryCommsState>, scope?: C.SettingsScope): void;
  fresh(options?: C.RequestOptions | C.FreshAdminOptions): ToolInvocation;
  token(execution: MemoryExecution): string;
  describe(value: unknown): string;
  digest(value: string): Promise<string>;
  scopeWitness(
    world: Readonly<MemoryCommsState>,
    scope: C.SettingsScope,
  ): string;
  remember(
    token: string,
    purpose: Purpose,
    proposal: unknown,
    witness: string,
    started: number,
  ): void;
  reserve(
    token: string,
    purpose: Purpose,
    proposal: unknown,
    witness: string,
    receipt: Receipt,
  ): ToolReservation;
  precondition(supplied: string | undefined): string;
  conflict(): never;
  stale(): never;
  timePage<T extends { id: string; created_at: string; updated_at: string }>(
    rows: T[],
    request?: C.TimeListRequest,
  ): C.Page<T>;
}

const workspace = { kind: "workspace" } as const;
const bindings = new WeakMap<
  ProtectedToolResources,
  (binding: MemoryClientBinding) => ProtectedToolOperations
>();
function cancelled(): never {
  throw Object.assign(new Error("OpenComms operation cancelled"), {
    kind: "cancelled" as const,
  });
}
function conflict(): never {
  return policyFailure({
    status: 409,
    body: {
      detail: { code: "comms_conflict", message: "Preview unavailable" },
    },
  });
}
function stale(): never {
  return policyFailure({
    status: 412,
    body: {
      detail: {
        code: "comms_precondition_failed",
        message: "Resource changed",
      },
    },
  });
}
function freshRequired(): never {
  return policyFailure({
    status: 403,
    body: {
      detail: {
        code: "comms_fresh_admin_required",
        message: "Fresh confirmation required",
      },
    },
  });
}
function describe(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(describe).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => compare(a, b))
      .map(([key, item]) => `${JSON.stringify(key)}:${describe(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
async function digest(value: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function createProtectedToolResources(input: {
  store: MemoryStore;
  files: MemoryFileResources;
  clock: () => number;
  verifyConfirmation?: (
    marker: string,
    signal: AbortSignal,
  ) => Promise<unknown>;
}): ProtectedToolResources {
  const { store, files, clock } = input;
  files.assertCurrent(store);
  const anchor = store.bind(store.exportSnapshot().owner);
  const verify =
    input.verifyConfirmation ??
    (async (marker: string) => marker === "CONFIRM LOCAL SAMPLE");
  const previews = new Map<string, Preview>();
  const exports = createExportTools();
  const families = new Map<
    MemoryHandle,
    {
      authority: MemoryClientBinding["authority"];
      operations: ProtectedToolOperations;
      retire(): void;
    }
  >();
  let retired = false;
  const retire = () => {
    retired = true;
    previews.clear();
    exports.dispose();
    for (const family of [...families.values()]) family.retire();
  };
  anchor.lifetimeSignal.addEventListener("abort", retire, { once: true });
  const validTime = (started: number) => {
    const elapsed = clock() - started;
    return (
      Number.isFinite(started) &&
      Number.isFinite(elapsed) &&
      elapsed >= 0 &&
      elapsed < 60_000
    );
  };
  const prune = () => {
    for (const [key, entry] of previews)
      if (
        !entry.handle.isCurrentFor(store) ||
        !validTime(entry.started) ||
        entry.reservation?.committed
      )
        previews.delete(key);
  };
  const resources: ProtectedToolResources = {
    dispose() {
      if (!retired) anchor.dispose();
    },
  };
  bindings.set(resources, (binding) => {
    const { handle } = binding;
    const active = (options?: C.RequestOptions) => {
      assertRequestActive(options);
      if (
        retired ||
        !anchor.isCurrentFor(store) ||
        handle.lifetimeSignal.aborted
      )
        return cancelled();
      if (!handle.isCurrentFor(store)) return invalidMemoryState();
    };
    active();
    const cached = families.get(handle);
    if (cached) {
      if (cached.authority !== binding.authority) return invalidMemoryState();
      return cached.operations;
    }
    const session: ToolSession = {
      binding,
      store,
      files,
      now: clock,
      active,
      signal(options) {
        active(options);
        return AbortSignal.any([
          anchor.lifetimeSignal,
          handle.lifetimeSignal,
          ...(options?.signal ? [options.signal] : []),
        ]);
      },
      admin(world, scope = workspace) {
        active();
        if (activePerson(world, handle.context).role !== "admin")
          return policyFailure({
            status: 403,
            body: {
              detail: {
                code: "comms_admin_required",
                message: "Administrator required",
              },
            },
          });
        requireAvailable(
          binding,
          handle.context,
          { scope: workspace, capability: "manageWorkspace" },
          scopeManagementDecision(world, handle.context, workspace),
        );
        requireScopeRead(world, handle.context, scope);
      },
      fresh(options) {
        active(options);
        const started = clock();
        const marker =
          options && "password" in options ? options.password : undefined;
        return {
          started,
          async prepare(signal) {
            active({ signal });
            if (
              typeof marker !== "string" ||
              !marker.length ||
              marker.length > 256
            )
              return freshRequired();
            const answer = await verify(marker, signal);
            active({ signal });
            if (typeof answer !== "boolean") return invalidMemoryState();
            if (!answer) return freshRequired();
          },
          assert() {
            active(options);
            if (!validTime(started)) return freshRequired();
          },
        };
      },
      token(execution) {
        return `${execution.uuid()}${execution.uuid()}`.replaceAll("-", "");
      },
      describe,
      digest,
      scopeWitness(world, scope) {
        const chain = scopeChain(world, scope);
        return describe({
          actor: world.people[handle.context.user_id],
          authority: world.resource_versions.authority ?? 0,
          chain: chain.map((item) => ({
            scope: item,
            configuration: world.configuration[scopeKey(item)],
            version: world.resource_versions[configurationKey(item)] ?? 0,
            category:
              item.kind === "category" ? world.categories[item.id] : undefined,
            conversation:
              item.kind === "channel"
                ? world.conversations[item.id]
                : undefined,
            conversation_version:
              item.kind === "channel"
                ? (world.resource_versions[`conversation:${item.id}`] ?? 0)
                : undefined,
          })),
          setting_locks: world.setting_locks,
          capability_locks: world.capability_locks,
          dm_rule: world.dm_rule,
        });
      },
      remember(token, purpose, proposal, witness, started) {
        active();
        if (!validTime(started)) return conflict();
        prune();
        if (previews.has(token)) return invalidMemoryState();
        while (previews.size >= 32) {
          const oldest = previews.keys().next();
          if (oldest.done) return invalidMemoryState();
          previews.delete(oldest.value);
        }
        previews.set(token, {
          handle,
          purpose,
          proposal: describe(proposal),
          witness,
          started,
        });
      },
      reserve(token, purpose, proposal, witness, receipt) {
        active();
        prune();
        const entry = previews.get(token);
        if (
          !entry ||
          entry.handle !== handle ||
          entry.purpose !== purpose ||
          entry.proposal !== describe(proposal) ||
          entry.reservation
        )
          return conflict();
        if (entry.witness !== witness) return stale();
        entry.reservation = receipt;
        return {
          assert(currentWitness) {
            active();
            prune();
            if (
              previews.get(token) !== entry ||
              entry.reservation !== receipt ||
              receipt.committed
            )
              return conflict();
            if (entry.witness !== currentWitness) return stale();
          },
          release() {
            prune();
            if (
              previews.get(token) === entry &&
              entry.reservation === receipt
            ) {
              if (receipt.committed) previews.delete(token);
              else delete entry.reservation;
            }
          },
        };
      },
      precondition(supplied) {
        if (supplied === undefined)
          return policyFailure({
            status: 428,
            body: {
              detail: {
                code: "comms_precondition_required",
                message: "Version required",
              },
            },
          });
        if (!S.preconditionSchema.safeParse({ if_match: supplied }).success)
          return invalidInput();
        return supplied;
      },
      conflict,
      stale,
      timePage(rows, request = {}) {
        const parsed = S.timeListRequestSchema.safeParse(request);
        if (!parsed.success) return invalidInput();
        const { sort_by, sort_order } = parsed.data;
        rows.sort(
          (a, b) =>
            (sort_order === "asc" ? 1 : -1) *
            (compare(a[sort_by], b[sort_by]) || compare(a.id, b.id)),
        );
        return page(rows, parsed.data);
      },
    };
    const operations: ProtectedToolOperations = {
      ...createRetentionTools(session),
      ...createConfigurationTools(session),
      ...exports.bind(session),
    };
    const retireHandle = () => {
      for (const [key, preview] of previews)
        if (preview.handle === handle) previews.delete(key);
      families.delete(handle);
      handle.lifetimeSignal.removeEventListener("abort", retireHandle);
    };
    handle.lifetimeSignal.addEventListener("abort", retireHandle, {
      once: true,
    });
    families.set(handle, {
      authority: binding.authority,
      operations,
      retire: retireHandle,
    });
    return operations;
  });
  return resources;
}

export function createProtectedToolOperations(
  binding: MemoryClientBinding,
  resources: ProtectedToolResources,
): ProtectedToolOperations {
  const bind = bindings.get(resources);
  if (!bind) return invalidMemoryState();
  return bind(binding);
}
