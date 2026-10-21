"use client";
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { authMeOptions } from "../../openview/adapters/openview-queries";
import {
  listAccessGroups,
  listAccessDepartments,
  listAccessModules,
} from "../../access/state/api";
import { currentOrganizationId } from "@/lib/organization-context";
import {
  registerWorkspaceSessionClear,
  useVerifiedWorkspaceOrganizationId,
  useVerifiedWorkspaceUserId,
  useWorkspaceInteractionSuspended,
} from "../../shared/runtime/workspace-identity";
import {
  createLiveCommsRuntime,
  type LiveCommsRuntime,
} from "../adapters/live-runtime";
import type { createCommsQueryScope } from "../adapters/comms-queries";
import type { CommsViewClient } from "../contract/client";
import type { Bootstrap } from "../contract/types";
import type { CommsGroup } from "../domain/groups";
import { complete } from "./workspace-view";
import {
  clearCommsDraftTextStore,
  commsDraftOrganizationLeft,
} from "./draft-text";
import { managedDepartmentIds } from "../../openview/domain/manage-access";

export type CommsClientState = {
  organizationName: string | undefined;
  groups: CommsGroup[];
  catalog: {
    departments: { id: string; name: string }[];
    modules: { id: string; name: string }[];
    fields: { id: string; label: string }[];
  };
  generation: number;
  client: CommsViewClient | null;
  live: LiveCommsRuntime | null;
  scope: ReturnType<typeof createCommsQueryScope> | null;
  bootstrap: Bootstrap | undefined;
  error: string;
  reload: () => void;
  requestCatalog?: () => void;
  retryCatalog?: () => void;
  catalogStatus?: "idle" | "loading" | "error" | "ready";
};
const ClientContext = createContext<CommsClientState | null>(null);
export const CommsClientStateProvider = ClientContext.Provider;
const emptyCatalog: CommsClientState["catalog"] = {
  departments: [],
  modules: [],
  fields: [],
};

export function CommsClientProvider({ children }: { children: ReactNode }) {
  const userId = useVerifiedWorkspaceUserId(),
    orgId = useVerifiedWorkspaceOrganizationId();
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
  const cache = useQueryClient();
  const suspended = useWorkspaceInteractionSuspended();
  const identity = useQuery({ ...authMeOptions(), enabled: false });
  const [runtime, setRuntime] = useState<LiveCommsRuntime | null>(null);
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);
  const [catalogOwner, setCatalogOwner] = useState<CommsViewClient | null>(
    null,
  );
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  const role = identity.data?.currentOrganization?.role;
  const organization = identity.data?.currentOrganization?.orgId;
  useLayoutEffect(() => {
    const clear = () => {
      clearCommsDraftTextStore(userId, orgId);
    };
    const unregister = registerWorkspaceSessionClear(userId, clear);
    return () => {
      unregister();
      if (commsDraftOrganizationLeft(currentOrganizationId(), orgId)) clear();
    };
  }, [userId, orgId]);
  useLayoutEffect(() => {
    let retired = false;
    let owned: LiveCommsRuntime | undefined;
    const dispose = () => {
      retired = true;
      owned?.dispose();
    };
    const unregister = registerWorkspaceSessionClear(userId, dispose);
    setRuntime(null);
    setError("");
    if (!suspended && !identity.isError)
      void cache
        .cancelQueries({ queryKey: authMeOptions().queryKey, exact: true })
        .then(() =>
          retired
            ? undefined
            : cache.fetchQuery({ ...authMeOptions(), staleTime: 0 }),
        )
        .then((account) => {
          if (retired || !account) return;
          if (
            account.id !== userId ||
            account.currentOrganization?.orgId !== orgId
          )
            throw new Error("Organization changed");
          owned = createLiveCommsRuntime(cache, {
            user_id: userId,
            org_id: orgId,
          });
          setRuntime(owned);
          void owned.start().catch(() => {});
        })
        .catch(() => {
          if (!retired)
            setError("Your organization could not be verified. Try again.");
        });
    return () => {
      unregister();
      dispose();
    };
  }, [
    cache,
    userId,
    orgId,
    suspended,
    identity.isError,
    role,
    organization,
    generation,
  ]);
  const admitted =
    !suspended && !identity.isError && runtime && !runtime.scope.signal.aborted
      ? runtime
      : null;
  const bootstrap = useQuery({
    ...(admitted?.scope.bootstrapOptions() ?? {
      queryKey: ["comms", "unadmitted", "unadmitted", "bootstrap"] as const,
      queryFn: skipToken,
    }),
    enabled: !!admitted,
  });
  const catalogRequested = !!admitted && catalogOwner === admitted.client;
  const requestCatalog = useCallback(() => {
    if (admitted) setCatalogOwner(admitted.client);
  }, [admitted]);
  const catalog = useQuery({
    queryKey: [
      ...(admitted?.scope.keys.all ?? ["comms-unadmitted", userId, orgId]),
      "catalog",
    ],
    enabled: catalogRequested,
    queryFn: ({ signal }) => {
      if (!admitted) throw new Error("Organization is not admitted");
      return admitted.scope.read(
        "catalog",
        async (signal) => {
          if (currentOrganizationId() !== orgId)
            throw new DOMException("Organization changed", "AbortError");
          const managed = managedDepartmentIds(identity.data);
          const [groups, departments, modules] = await Promise.all([
            managed === "all" || managed.size > 0
              ? complete((offset) =>
                  listAccessGroups({ limit: 100, offset, signal }),
                )
              : [],
            complete((offset) =>
              listAccessDepartments({ limit: 100, offset, signal }),
            ),
            complete((offset) =>
              listAccessModules({ limit: 100, offset, signal }),
            ),
          ]);
          if (currentOrganizationId() !== orgId)
            throw new DOMException("Organization changed", "AbortError");
          return {
            groups: groups.map((group): CommsGroup => ({
              id: group.id,
              name: group.name,
              memberIds: group.member_ids,
              tone: 0,
            })),
            catalog: {
              departments: departments.map((row) => ({
                id: row.id,
                name: row.department_name,
              })),
              modules: modules.map((row) => ({
                id: row.id,
                name: row.module_name,
              })),
              fields: [],
            },
          };
        },
        signal,
      );
    },
  });
  return (
    <ClientContext.Provider
      value={{
        organizationName:
          identity.data?.currentOrganization?.orgId === orgId
            ? identity.data.currentOrganization.name
            : undefined,
        groups: catalogRequested ? (catalog.data?.groups ?? []) : [],
        catalog: catalogRequested
          ? (catalog.data?.catalog ?? emptyCatalog)
          : emptyCatalog,
        generation,
        client: admitted?.client ?? null,
        live: admitted,
        scope: admitted?.scope ?? null,
        bootstrap: admitted ? bootstrap.data : undefined,
        error:
          error ||
          (admitted && bootstrap.isError
            ? "Conversations could not be loaded. Try again."
            : ""),
        reload,
        requestCatalog,
        retryCatalog: () => {
          void catalog.refetch();
        },
        catalogStatus: !catalogRequested
          ? "idle"
          : catalog.isError
            ? "error"
            : catalog.data
              ? "ready"
              : "loading",
      }}
    >
      {children}
    </ClientContext.Provider>
  );
}
export function useCommsClient() {
  const value = useContext(ClientContext);
  if (!value) throw new Error("OpenComms requires its admitted client");
  return value;
}
