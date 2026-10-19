"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authMeOptions } from "../../openview/adapters/openview-queries";
import { useSampleRuntime } from "../../shared/runtime/sample-state";
import {
  registerWorkspaceSessionClear,
  useVerifiedWorkspaceOrganizationId,
  useVerifiedWorkspaceUserId,
  useWorkspaceInteractionSuspended,
} from "../../shared/runtime/workspace-identity";
import {
  createMemoryCommsRuntime,
  type MemoryCommsRuntime,
} from "../adapters/memory-client";
import type { CommsClient } from "../contract/client";
import type { Bootstrap } from "../contract/types";
import { createMemorySeed } from "../memory/seed";
import { releaseAllLocalAttachments } from "../../shared/runtime/local-attachments";
import type { CommsGroup } from "../domain/groups";

type ClientState = {
  groups: CommsGroup[];
  catalog: {
    departments: { id: string; name: string }[];
    modules: { id: string; name: string }[];
    fields: { id: string; label: string }[];
  };
  generation: number;
  client: CommsClient | null;
  bootstrap: Bootstrap | undefined;
  error: string;
  reload: () => void;
};
const ClientContext = createContext<ClientState | null>(null);
const snapshotKey = "comms-memory-v1";

/** SampleProvider persists one canonical snapshot; consumers only receive the client. */
export function CommsClientProvider({ children }: { children: ReactNode }) {
  const userId = useVerifiedWorkspaceUserId();
  const orgId = useVerifiedWorkspaceOrganizationId();
  return (
    <OwnedClient key={`${userId}:${orgId}`} userId={userId} orgId={orgId}>
      {children}
    </OwnedClient>
  );
}

function OwnedClient({
  userId,
  orgId,
  children,
}: {
  userId: string;
  orgId: string;
  children: ReactNode;
}) {
  const bridge = useSampleRuntime();
  const queryClient = useQueryClient();
  const suspended = useWorkspaceInteractionSuspended();
  // Observe the shell's identity cache, never create a second identity request/key.
  const identity = useQuery({ ...authMeOptions(), enabled: false });
  const owner = useRef<MemoryCommsRuntime | null>(null);
  const lifetime = useRef(0);
  const [groups, setGroups] = useState<CommsGroup[]>([]);
  const [catalog, setCatalog] = useState<ClientState["catalog"]>({
    departments: [],
    modules: [],
    fields: [],
  });
  const stopPersistence = useRef<(() => void) | undefined>(undefined);
  const admittedClient = useRef<CommsClient | null>(null);
  const readSequence = useRef(0);
  const [client, setClient] = useState<CommsClient | null>(null);
  const [generation, setGeneration] = useState(0);
  const [bootstrap, setBootstrap] = useState<Bootstrap>();
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const reload = useCallback(() => setRefresh((value) => value + 1), []);
  const readBootstrap = useCallback(async (current: CommsClient) => {
    const sequence = ++readSequence.current;
    try {
      const value = await current.bootstrap();
      if (
        admittedClient.current !== current ||
        sequence !== readSequence.current
      )
        return;
      setBootstrap(value);
      setError("");
    } catch {
      if (
        admittedClient.current !== current ||
        sequence !== readSequence.current
      )
        return;
      setBootstrap(undefined);
      setError("Conversations could not be loaded. Try again.");
    }
  }, []);

  useLayoutEffect(() => {
    const dispose = () => {
      lifetime.current += 1;
      admittedClient.current = null;
      readSequence.current += 1;
      stopPersistence.current?.();
      stopPersistence.current = undefined;
      owner.current?.dispose();
      owner.current = null;
      releaseAllLocalAttachments();
    };
    const unregister = registerWorkspaceSessionClear(userId, dispose);
    return () => {
      unregister();
      dispose();
    };
  }, [userId]);

  const observedRole = identity.data?.currentOrganization?.role;
  const observedOrganization = identity.data?.currentOrganization?.orgId;
  useLayoutEffect(() => {
    let retired = false;
    const started = lifetime.current;
    const active = () => !retired && lifetime.current === started;
    admittedClient.current = null;
    readSequence.current += 1;
    const ticket = owner.current?.suspendAdmission();
    setClient(null);
    setBootstrap(undefined);
    setError("");
    if (suspended) return;

    // A pre-verification request cannot reopen this admission cycle. This is the
    // same cancellation/fresh-read boundary used by the organization editor.
    void queryClient
      .cancelQueries({ queryKey: authMeOptions().queryKey, exact: true })
      .then(() =>
        !active()
          ? undefined
          : queryClient.fetchQuery({ ...authMeOptions(), staleTime: 0 }),
      )
      .then((account) => {
        if (!active() || !account) return;
        const membership = account.currentOrganization;
        if (account.id !== userId || membership?.orgId !== orgId) {
          setError("Your organization could not be verified. Try again.");
          return;
        }
        const context = { user_id: userId, org_id: orgId };
        const actor = {
          role: membership.role,
          display_name: account.displayName ?? account.username,
        };
        let runtime = owner.current;
        if (!runtime) {
          const initial = createMemorySeed(context, actor);
          runtime = createMemoryCommsRuntime({
            owner: context,
            initial,
            snapshot: bridge.getSnapshot()[snapshotKey],
          });
          owner.current = runtime;
          setGroups(
            Object.values(initial.groups).map((group, index) => ({
              id: group.id,
              name: group.name,
              tone: ((index % 4) + 1) as CommsGroup["tone"],
              memberIds: Object.values(initial.people)
                .filter((person) => person.group_ids.includes(group.id))
                .map((person) => person.user_id),
            })),
          );
          setCatalog({
            departments: Object.values(initial.departments),
            modules: Object.values(initial.modules),
            fields: Object.values(initial.records).flatMap((record) =>
              record.fields.map((field) => ({
                id: field.field_id,
                label: field.label,
              })),
            ),
          });
          const currentOwner = runtime;
          const persist = () => {
            if (owner.current !== currentOwner) return;
            bridge.commit((draft) => {
              draft.update<unknown>(
                snapshotKey,
                null,
                currentOwner.exportSnapshot(),
              );
            });
            if (admittedClient.current)
              void readBootstrap(admittedClient.current);
          };
          stopPersistence.current = runtime.subscribe(persist);
          persist();
        } else if (
          ticket === undefined ||
          !runtime.acceptAdmission(ticket, { context, ...actor })
        ) {
          setError("Your organization could not be verified. Try again.");
          return;
        }
        runtime.refreshOwnerDisplayName(context, actor.display_name);
        const current = runtime.client;
        admittedClient.current = current;
        setClient(current);
        setGeneration((value) => value + 1);
        void readBootstrap(current);
      })
      .catch(() => {
        if (active())
          setError("Your organization could not be verified. Try again.");
      });
    return () => {
      retired = true;
    };
  }, [
    bridge,
    orgId,
    userId,
    queryClient,
    suspended,
    observedRole,
    observedOrganization,
    refresh,
    readBootstrap,
  ]);

  useLayoutEffect(() => {
    if (!identity.isError || !admittedClient.current) return;
    admittedClient.current = null;
    readSequence.current += 1;
    owner.current?.suspendAdmission();
    setClient(null);
    setBootstrap(undefined);
    setError("Your organization could not be verified. Try again.");
  }, [identity.isError]);

  useEffect(() => {
    const account = identity.data;
    if (account?.id === userId && account.currentOrganization?.orgId === orgId)
      owner.current?.refreshOwnerDisplayName(
        { user_id: userId, org_id: orgId },
        account.displayName ?? account.username,
      );
  }, [identity.data, userId, orgId]);

  return (
    <ClientContext.Provider
      value={{
        groups,
        catalog,
        generation,
        client: suspended || identity.isError ? null : client,
        bootstrap: suspended || identity.isError ? undefined : bootstrap,
        error,
        reload,
      }}
    >
      {children}
    </ClientContext.Provider>
  );
}

export function useCommsClient() {
  const context = useContext(ClientContext);
  if (!context)
    throw new Error("OpenComms requires its scoped client provider");
  return context;
}
