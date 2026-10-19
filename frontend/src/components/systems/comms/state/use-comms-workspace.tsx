"use client";
import { createContext, useContext, useState, type ReactNode } from "react";

import { useSampleResource } from "../../shared/runtime/sample-async";
import { createCommsConfiguration } from "../domain/configuration-model";
import type { CapabilityCheck, Member, Settings } from "../contract/types";
import type { Presence } from "../domain/view-model";
import { useCommsClient } from "./client-context";
import { loadWorkspace } from "./workspace-view";
import { isCommsReadRefusal } from "./runtime";
type CommsWorkspace = Awaited<ReturnType<typeof loadWorkspace>>;

const empty = {
  presence: {} as Presence,
  removedCount: 0,
  configuration: createCommsConfiguration(),
  people: [],
  roles: [],
  categories: [],
  channels: [],
  messages: [],
  threads: [],
  directs: [],
  records: [],
  account: { presence: "Offline" },
  checks: {} as Record<string, CapabilityCheck>,
  members: {} as Record<string, Member[]>,
  effective: {} as Record<string, Settings>,
};

export function useCommsWorkspace() {
  const binding = useCommsClient();
  const [refused, setRefused] = useState(false);
  const [lastGood, setLastGood] = useState<CommsWorkspace>();
  const resource = useSampleResource<CommsWorkspace>({
    keys: ["comms-memory-v1"],
    queryKey: binding.client
      ? `${binding.client.context.user_id}:${binding.client.context.org_id}:${binding.generation}`
      : "unadmitted",
    load: async (signal) => {
      if (!binding.client)
        return Promise.reject(new Error("Organization is not admitted"));
      try {
        const value = await loadWorkspace(
          binding.client,
          signal,
          binding.groups,
        );
        if (!signal.aborted) {
          setRefused(false);
          setLastGood(value);
        }
        return value;
      } catch (error) {
        if (!signal.aborted && isCommsReadRefusal(error)) setRefused(true);
        throw error;
      }
    },
  });
  const data =
    !refused && binding.client && resource.data?.client === binding.client
      ? resource.data
      : undefined;
  return {
    commsResource: {
      ...resource,
      data,
      hydrated: lastGood !== undefined,
      status: binding.error
        ? "error"
        : !binding.client
          ? "loading"
          : resource.status,
      error: binding.error || resource.error,
      reload: binding.error ? binding.reload : resource.reload,
    },
    // Retained only to preserve mounted drafts. The page conceals this tree
    // until the current binding has produced an authorized read model.
    workspace: data ?? lastGood ?? empty,
    client: binding.client,
  };
}

type WorkspaceView = ReturnType<typeof useCommsWorkspace>["workspace"];
const WorkspaceContext = createContext<WorkspaceView | null>(null);
export function CommsWorkspaceProvider({
  value,
  children,
}: {
  value: WorkspaceView;
  children: ReactNode;
}) {
  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}
export function useCommsWorkspaceView() {
  const value = useContext(WorkspaceContext);
  if (!value)
    throw new Error("OpenComms requires its client-resolved workspace");
  return value;
}
