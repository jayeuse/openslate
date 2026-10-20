"use client";
import { useLayoutEffect, useState } from "react";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { authMeOptions } from "../../openview/adapters/openview-queries";
import { createMemorySeed } from "../memory/seed";
import { createMemoryCommsRuntime } from "../adapters/memory-client";
import { createCommsQueryScope } from "../adapters/comms-queries";
import type { LiveCommsRuntime } from "../adapters/live-runtime";
import {
  CommsClientStateProvider,
  useCommsClient,
} from "../state/client-context";
import {
  CommsWorkspaceProvider,
  useCommsWorkspace,
} from "../state/use-comms-workspace";
import type { CommsGroup } from "../domain/groups";
import { CommsToolsDialog, type CommsToolsDialogProps } from "./tools-dialog";
import { Button } from "@/components/ui/button";

// Loaded only with the three explicitly deferred tools. Keep their existing
// example world for this admission, never a mirror of HTTP bootstrap/messages.
const examples = new WeakMap<
  LiveCommsRuntime,
  ReturnType<typeof createExample>
>();
function createExample(
  live: LiveCommsRuntime,
  cache: QueryClient,
  role: "admin" | "member" | "guest",
) {
  const owner = live.scope.context;
  const initial = createMemorySeed(owner, {
    role,
    display_name: "Example operator",
  });
  const memory = createMemoryCommsRuntime({ owner, initial });
  const scope = createCommsQueryScope(cache, owner, {
    kind: "example-tools",
    client: memory.client,
  });
  live.scope.signal.addEventListener(
    "abort",
    () => {
      scope.dispose();
      memory.dispose();
      examples.delete(live);
    },
    { once: true },
  );
  return {
    memory,
    scope,
    groups: Object.values(initial.groups).map((group): CommsGroup => ({
      id: group.id,
      name: group.name,
      tone: 0,
      memberIds: Object.values(initial.people)
        .filter((person) => person.group_ids.includes(group.id))
        .map((person) => person.user_id),
    })),
    catalog: {
      departments: Object.values(initial.departments),
      modules: Object.values(initial.modules),
      fields: Object.values(initial.records).flatMap((record) =>
        record.fields.map((field) => ({
          id: field.field_id,
          label: field.label,
        })),
      ),
    },
  };
}
export function ExampleTools({
  embedded,
  view,
  opener,
  onClose,
}: CommsToolsDialogProps) {
  const { live } = useCommsClient();
  const cache = useQueryClient();
  const identity = useQuery({ ...authMeOptions(), enabled: false });
  const role = identity.data?.currentOrganization?.role;
  const [example, setExample] = useState<ReturnType<
    typeof createExample
  > | null>(null);
  useLayoutEffect(() => {
    setExample(null);
    if (!live || !role || live.scope.signal.aborted) return;
    let current = examples.get(live);
    if (!current) {
      current = createExample(live, cache, role);
      examples.set(live, current);
    }
    setExample(current);
    const scope = current.scope;
    return current.memory.subscribe(() => {
      if (scope.signal.aborted) return;
      void cache.invalidateQueries({
        queryKey: scope.keys.bootstrap,
        exact: true,
      });
      void cache.invalidateQueries({
        queryKey: scope.keys.all,
        predicate: (query) => query.queryKey[5] === "read",
      });
    });
  }, [live, role, cache]);
  if (!example || !live || live.scope.signal.aborted)
    return <p role="status">Loading example tools…</p>;
  // Deliberately omit live channel/thread/message IDs; the tool chooses only
  // from its existing seed. No server body, name, or draft enters that world.
  return (
    <BoundExample
      example={example}
      embedded={embedded}
      view={view}
      opener={opener}
      onClose={onClose}
    />
  );
}
function BoundExample({
  example,
  ...props
}: CommsToolsDialogProps & { example: ReturnType<typeof createExample> }) {
  const bootstrap = useQuery(example.scope.bootstrapOptions());
  return (
    <CommsClientStateProvider
      value={{
        organizationName: "Example workspace",
        groups: example.groups,
        catalog: example.catalog,
        generation: 0,
        client: example.memory.client,
        live: null,
        scope: example.scope,
        bootstrap: bootstrap.data,
        error: bootstrap.isError
          ? "Example tools could not be loaded. Try again."
          : "",
        reload: () => {
          void bootstrap.refetch();
        },
      }}
    >
      <ExampleWorkspace {...props} />
    </CommsClientStateProvider>
  );
}
function ExampleWorkspace(props: CommsToolsDialogProps) {
  const { commsResource, workspace } = useCommsWorkspace();
  if (!commsResource.data)
    return (
      <div role={commsResource.error ? "alert" : "status"}>
        {commsResource.error || "Loading example tools…"}
        {commsResource.error && (
          <Button onClick={commsResource.reload}>Retry example tools</Button>
        )}
      </div>
    );
  return (
    <CommsWorkspaceProvider value={workspace}>
      <CommsToolsDialog {...props} />
    </CommsWorkspaceProvider>
  );
}
