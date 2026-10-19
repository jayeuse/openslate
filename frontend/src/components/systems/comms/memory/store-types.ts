import type {
  CommsContext,
  CommsEvent,
  EventObserver,
} from "../contract/types";
import type { MemoryCommsState, MemoryPerson } from "./model";

/** Internal family/store boundary; not a second public CommsClient. */
export type MemoryVersionKey = string;
export type MemoryRestoration =
  "empty" | "restored" | "recovered" | "refused_owner";
export interface MemorySnapshot {
  format: 1;
  owner: CommsContext;
  state: MemoryCommsState;
}
export interface MemoryPublication {
  recipient_ids: readonly string[];
  event: CommsEvent;
}
export interface MemoryExecution {
  readonly context: CommsContext;
  readonly now: number;
  readonly signal: AbortSignal;
  uuid(): string;
}
export type MemoryOutcome<Value> =
  | {
      kind: "commit";
      value: Value;
      version_keys: readonly MemoryVersionKey[];
      publications: readonly MemoryPublication[];
      /** Internal pre-install fault point, only for a newly accepted send. */
      failure_point?: "send";
    }
  | {
      kind: "unchanged";
      value: Value;
      version_keys: readonly MemoryVersionKey[];
    };
export interface MemoryCommand<Prepared, Value> {
  signal?: AbortSignal;
  conditions?: readonly {
    key: MemoryVersionKey;
    if_match: string | undefined;
  }[];
  /** No aggregate is exposed here; all authority is rechecked in the commit turn. */
  prepare?: (signal: AbortSignal) => Promise<Prepared>;
  authorize(
    current: Readonly<MemoryCommsState>,
    execution: MemoryExecution,
    prepared: Prepared,
  ): void;
  apply(
    draft: MemoryCommsState,
    execution: MemoryExecution,
    prepared: Prepared,
  ): MemoryOutcome<Value>;
  /**
   * Commit-only, trusted lexical pointer assignments to roots built in apply.
   * No allocation, mutation, callbacks, validation, abort/disposal or async work.
   * Cannot throw; runs after canonical install and before observers/events.
   */
  finalize?: () => undefined;
}
export interface MemoryCommandResult<Value> {
  value: Value;
  versions: Record<MemoryVersionKey, string>;
}
export interface MemoryHandle {
  readonly context: CommsContext;
  readonly lifetimeSignal: AbortSignal;
  /** Exact store/incarnation/open identity only; never an authorization decision. */
  isCurrentFor(store: MemoryStore): boolean;
  /** Projectors still own resource-level read policy; state is detached, not public. */
  read<Value>(
    project: (
      current: Readonly<MemoryCommsState>,
      context: CommsContext,
    ) => Value,
  ): Value;
  version(key: MemoryVersionKey): string;
  command<Prepared = undefined, Value = void>(
    command: MemoryCommand<Prepared, Value>,
  ): Promise<MemoryCommandResult<Value>>;
  readonly events: {
    subscribe(
      observer: EventObserver,
      options?: { signal?: AbortSignal },
    ): () => void;
  };
  dispose(): void;
}
export interface MemoryStore {
  readonly restoration: MemoryRestoration;
  bind(context: CommsContext): MemoryHandle;
  exportSnapshot(): MemorySnapshot;
  subscribe(listener: () => void): () => void;
  /** Live admission, not snapshot recovery or a new store incarnation. */
  updateAdmittedOwner(
    context: CommsContext,
    identity: Pick<MemoryPerson, "role" | "display_name">,
  ): void;
  reset(): void;
  dispose(): void;
  /** One local pre-commit 503, consumed only by an otherwise valid commit. */
  failNextCommit(): void;
  /** Owner-only simulation controls; never members of CommsClient. */
  failNextSend(): void;
  setTokenExpired(handle: MemoryHandle, expired: boolean): void;
  setConnectionDropped(handle: MemoryHandle, dropped: boolean): void;
}
export interface MemoryStoreOptions {
  owner: CommsContext;
  initial: MemoryCommsState;
  snapshot?: unknown;
  clock?: () => number;
  uuid?: () => string;
}
