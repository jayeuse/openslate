"use client";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { createCommsConfiguration } from "../domain/configuration-model";
import type {
  Bootstrap,
  CapabilityCheck,
  Member,
  Settings,
} from "../contract/types";
import type { Presence } from "../domain/view-model";
import { useCommsClient } from "./client-context";
import { loadWorkspace } from "./workspace-view";
import { useCommsRead, useCommsRefusals } from "./runtime";
type CommsWorkspace = Awaited<ReturnType<typeof loadWorkspace>>;

const empty = {
  client: null,
  bootstrap: undefined as Bootstrap | undefined,
  presence: {} as Presence,
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
  const [lastGood, setLastGood] = useState<CommsWorkspace>();
  const resource = useCommsRead(
    `workspace:${binding.groups.map((group) => group.id).join(",")}`,
    (client, signal) => loadWorkspace(client, signal, binding.groups),
  );
  useLayoutEffect(() => {
    if (resource.data) setLastGood(resource.data);
  }, [resource.data]);
  const data =
    binding.client && resource.data?.client === binding.client
      ? resource.data
      : undefined;
  return {
    commsResource: {
      ...resource,
      data,
      hydrated: data !== undefined || lastGood !== undefined,
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
  const refusals = useCommsRefusals();
  const visible = useMemo(() => {
    if (!value || !refusals || !Object.values(refusals).some(Boolean))
      return value;
    const allowed = (id: string) => !refusals.bootstrap && !refusals[id];
    const conversations = value.bootstrap?.conversations.filter((row) =>
      allowed(row.conversation.id),
    );
    const members = Object.fromEntries(
      Object.entries(value.members).filter(([id]) => allowed(id)),
    );
    const people = new Set(
      Object.values(members).flatMap((rows) =>
        rows.map((person) => person.user_id),
      ),
    );
    const messages = value.messages.filter((message) =>
      allowed(message.conversation),
    );
    const records = new Set(
      messages.flatMap((message) =>
        message.recordId ? [message.recordId] : [],
      ),
    );
    return {
      ...value,
      bootstrap: value.bootstrap && {
        ...value.bootstrap,
        conversations: conversations ?? [],
      },
      channels: value.channels.filter((channel) => allowed(channel.id)),
      directs: value.directs.filter((direct) => allowed(direct.id)),
      messages,
      members,
      threads: value.threads.filter((thread) => allowed(thread.conversation)),
      checks: Object.fromEntries(
        Object.entries(value.checks).filter(([id]) => allowed(id)),
      ),
      effective: Object.fromEntries(
        Object.entries(value.effective).filter(([id]) => allowed(id)),
      ),
      people: value.people.filter((person) => people.has(person.id)),
      records: value.records.filter((record) => records.has(record.id)),
    };
  }, [value, refusals]);
  if (!value)
    throw new Error("OpenComms requires its client-resolved workspace");
  return visible!;
}
