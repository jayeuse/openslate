import { z } from "zod";
import { createActivityRead } from "./memory/activity";
import { createAccessGrantOperations } from "./memory/access-grants";
import { createDirectCandidateRead } from "./memory/direct-candidates";
import type { CommsClient } from "@/components/systems/comms/contract/client";
import * as S from "@/components/systems/comms/contract/schemas";
import type * as C from "@/components/systems/comms/contract/types";
import { conversationAccess } from "./domain/access";
import {
  assertRequestActive,
  createMemoryAvailability,
  type MemoryCapabilityTarget,
  type MemoryClientBinding,
} from "./memory/availability";
import { createConfigurationOperations } from "./memory/configuration-operations";
import { createConversationOperations } from "./memory/conversation-operations";
import { compare, projectConversation } from "./memory/conversation-structure";
import { createMemoryFileResources } from "./memory/files";
import { createMessageFamily, projectReadSummary } from "./memory/messages";
import type { MemoryCommsState } from "./memory/model";
import {
  createOperationalResources,
  type OperationalResources,
} from "./memory/operational-resources";
import { createOperationalFamily } from "./memory/operations";
import { createLazyProtectedTools } from "./memory/lazy-protected-tools";
import type { createProtectedToolResources } from "./memory/protected-tools";
import { invalidMemoryState } from "./memory/snapshot";
import { createMemoryStore } from "./memory/store";
import type { MemoryRestoration, MemorySnapshot } from "./memory/store-types";

export interface MemoryOwnedClientDependencies {
  readonly binding: MemoryClientBinding;
  readonly operational: OperationalResources;
  readonly protectedTools: ReturnType<typeof createLazyProtectedTools>;
}

/** Compose real family Picks; this factory owns no state, resource or policy cache. */
export function createMemoryCommsClient(
  input: MemoryOwnedClientDependencies,
): CommsClient {
  const { binding, operational, protectedTools } = input;
  const { handle } = binding;
  const dependencies = operational.sendDependenciesFor(handle);
  if (binding.authority !== dependencies.authority) return invalidMemoryState();
  const client: CommsClient = {
    ...createActivityRead(binding),
    ...createDirectCandidateRead(binding),
    ...createAccessGrantOperations(binding),
    ...createConversationOperations(binding),
    ...createConfigurationOperations(binding),
    ...createMessageFamily(binding, dependencies),
    ...createOperationalFamily(binding, operational),
    ...protectedTools.bind(binding),
    context: handle.context,
    events: Object.freeze({ subscribe: handle.events.subscribe }),
    async bootstrap(options) {
      assertRequestActive(options);
      return handle.read((world, context) => {
        const categories = Object.values(world.categories)
          .filter((category) => category.org_id === context.org_id)
          .sort(
            (a, b) => compare(a.position, b.position) || compare(a.id, b.id),
          )
          .map((category) => ({
            category,
            preferences: world.users[context.user_id]?.categories[
              category.id
            ] ?? { collapsed: false, mute: { kind: "off" } },
          }));
        const conversations = Object.values(world.conversations)
          .filter(
            (row) =>
              conversationAccess(world, context, row.id).level !== "none",
          )
          .map((row) => ({
            conversation: projectConversation(world, context, row.id),
            ...projectReadSummary(world, context, row.id),
          }))
          .sort(
            (a, b) =>
              compare(
                a.conversation.kind === "channel" ? a.conversation.position : 0,
                b.conversation.kind === "channel" ? b.conversation.position : 0,
              ) || compare(a.conversation.id, b.conversation.id),
          );
        const parsed = S.bootstrapSchema.safeParse({
          ...context,
          categories,
          conversations,
        });
        if (!parsed.success) return invalidMemoryState();
        assertRequestActive(options);
        return parsed.data;
      });
    },
  };
  return Object.freeze(client);
}

export interface MemoryRuntimeSeed {
  owner: C.CommsContext;
  initial: MemoryCommsState;
  snapshot?: unknown;
}
export interface MemoryRuntimeOptions {
  clock?: () => number;
  uuid?: () => string;
  beforeScheduleSend?: (jobId: string, signal: AbortSignal) => Promise<void>;
  verifyConfirmation?: Parameters<
    typeof createProtectedToolResources
  >[0]["verifyConfirmation"];
}
export interface MemoryCommsRuntime {
  readonly client: CommsClient;
  readonly restoration: MemoryRestoration;
  /** Internal acknowledgement fence for the caller bridge, not a public API. */
  readonly admissionCycle: number;
  suspendAdmission(): number;
  acceptAdmission(ticket: number, input: unknown): boolean;
  refreshOwnerDisplayName(context: C.CommsContext, name: string): void;
  exportSnapshot(): MemorySnapshot;
  subscribe(listener: () => void): () => void;
  dispose(): void;
  readonly controls: {
    failNextSend(): void;
    setConnectionDropped(dropped: boolean): void;
    denyCapability(target: MemoryCapabilityTarget | null): void;
    setTokenExpired(expired: boolean): void;
    pumpDue(options?: C.RequestOptions): Promise<void>;
    expireTransient(options?: C.RequestOptions): Promise<void>;
    /**
     * A client acting as another active person of the same world, so a test
     * can change what the browser's owner sees (for example a manager's grant).
     */
    clientFor(userId: string): CommsClient;
  };
}

const admissionSchema = z.strictObject({
  context: S.commsContextSchema,
  role: z.enum(["admin", "member", "guest"]),
  display_name: z.string(),
});
function cancelled(): never {
  throw Object.assign(new Error("OpenComms operation cancelled"), {
    kind: "cancelled" as const,
  });
}

/** Explicit local sample owner. No browser storage writer, global hook or server auth. */
export function createMemoryCommsRuntime(
  seed: MemoryRuntimeSeed,
  options: MemoryRuntimeOptions = {},
): MemoryCommsRuntime {
  const clock = options.clock ?? Date.now;
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  const store = createMemoryStore({ ...seed, clock, uuid });
  try {
    const owner = Object.freeze(S.commsContextSchema.parse(seed.owner));
    const availability = createMemoryAvailability(owner);
    let browserHandle = store.bind(owner);
    const ownerBinding = Object.freeze({
      handle: browserHandle,
      authority: availability.authority,
    });
    const files = createMemoryFileResources(store);
    const operational = createOperationalResources(store, {
      files,
      clock,
      ownerBinding,
      beforeScheduleSend: options.beforeScheduleSend,
    });
    const protectedTools = createLazyProtectedTools({
      store,
      files,
      clock,
      verifyConfirmation: options.verifyConfirmation,
    });
    let client = createMemoryCommsClient({
      binding: ownerBinding,
      operational,
      protectedTools,
    });
    let disposed = false;
    let admissionOpen = true;
    let cycle = 0;
    let pendingTicket: number | undefined;
    const assertOpen = () => {
      if (disposed) cancelled();
    };
    const assertBrowser = () => {
      assertOpen();
      if (!admissionOpen) cancelled();
    };
    const matchesOwner = (context: C.CommsContext) =>
      context.org_id === owner.org_id && context.user_id === owner.user_id;

    return Object.freeze({
      get client() {
        assertBrowser();
        return client;
      },
      restoration: store.restoration,
      get admissionCycle() {
        return cycle;
      },
      suspendAdmission() {
        assertOpen();
        const ticket = ++cycle;
        pendingTicket = ticket;
        admissionOpen = false;
        // The latch/cycle and handle fence precede every dependency abort callback.
        // Resource anchors and already-claimed job handles are deliberately untouched.
        browserHandle.dispose();
        return ticket;
      },
      acceptAdmission(ticket: number, input: unknown) {
        if (
          disposed ||
          admissionOpen ||
          ticket !== cycle ||
          ticket !== pendingTicket
        )
          return false;
        const parsed = admissionSchema.safeParse(input);
        if (!parsed.success || !matchesOwner(parsed.data.context)) return false;
        const person = store.exportSnapshot().state.people[owner.user_id];
        if (!person?.active || person.org_id !== owner.org_id) return false;
        // Consume before notification callbacks can reenter this cycle.
        pendingTicket = undefined;
        store.updateAdmittedOwner(owner, {
          role: parsed.data.role,
          display_name: parsed.data.display_name,
        });
        // A notification may have disposed or suspended the owner again. Never reopen it.
        if (!disposed && cycle === ticket) {
          const nextHandle = store.bind(owner);
          try {
            const dependencies = operational.sendDependenciesFor(nextHandle);
            const binding = Object.freeze({
              handle: nextHandle,
              authority: dependencies.authority,
            });
            const nextClient = createMemoryCommsClient({
              binding,
              operational,
              protectedTools,
            });
            browserHandle = nextHandle;
            client = nextClient;
            admissionOpen = true;
          } catch (error) {
            nextHandle.dispose();
            throw error;
          }
        }
        return true;
      },
      refreshOwnerDisplayName(context: C.CommsContext, name: string) {
        assertOpen();
        const parsed = S.commsContextSchema.safeParse(context);
        if (
          !parsed.success ||
          !matchesOwner(parsed.data) ||
          typeof name !== "string"
        )
          return;
        const person = store.exportSnapshot().state.people[owner.user_id];
        if (!person?.active || person.display_name === name) return;
        store.updateAdmittedOwner(owner, {
          role: person.role,
          display_name: name,
        });
      },
      exportSnapshot: store.exportSnapshot,
      subscribe: store.subscribe,
      dispose() {
        if (disposed) return;
        disposed = true;
        admissionOpen = false;
        pendingTicket = undefined;
        cycle += 1;
        // Fence the entire store before any resource's abort handlers can reenter.
        store.dispose();
        protectedTools.dispose();
        operational.dispose();
        files.dispose();
      },
      controls: Object.freeze({
        failNextSend() {
          assertOpen();
          store.failNextSend();
        },
        setConnectionDropped(dropped: boolean) {
          assertBrowser();
          store.setConnectionDropped(browserHandle, dropped);
        },
        denyCapability(target: MemoryCapabilityTarget | null) {
          assertOpen();
          availability.controls.denyCapability(target);
        },
        setTokenExpired(expired: boolean) {
          assertBrowser();
          store.setTokenExpired(browserHandle, expired);
        },
        pumpDue(request?: C.RequestOptions) {
          return operational.pumpDue(request);
        },
        expireTransient(request?: C.RequestOptions) {
          return operational.expireTransient(request);
        },
        clientFor(userId: string) {
          assertOpen();
          const handle = store.bind({ org_id: owner.org_id, user_id: userId });
          const dependencies = operational.sendDependenciesFor(handle);
          return createMemoryCommsClient({
            binding: Object.freeze({
              handle,
              authority: dependencies.authority,
            }),
            operational,
            protectedTools,
          });
        },
      }),
    });
  } catch (error) {
    store.dispose();
    throw error;
  }
}
