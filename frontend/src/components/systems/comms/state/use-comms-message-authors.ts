"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import {
  queryOptions,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  personCardKey,
  personCardOptions,
} from "@/components/profile/adapters/profile-queries";
import type { PersonCardViewer } from "@/components/profile/adapters/profile-api";
import { authMeOptions } from "../../openview/adapters/openview-queries";
import { currentOrganizationId } from "@/lib/organization-context";
import { useWorkspaceInteractionSuspended } from "../../shared/runtime/workspace-identity";
import type { Person } from "../../shared/data/sample-people";
import type { Message } from "../contract/types";
import { useCommsClient } from "./client-context";
import { BURST } from "./bounded";

function clearCards(
  cache: QueryClient,
  viewer: PersonCardViewer,
  ids: Iterable<string>,
  refetch: boolean,
) {
  for (const id of ids) {
    const queryKey = personCardKey(viewer, id);
    const query = cache.getQueryCache().find({ queryKey, exact: true });
    if (!query) continue;
    // Cancel first so an old response cannot repopulate the invalidated identity.
    void cache.cancelQueries({ queryKey, exact: true });
    query.setState({
      data: undefined,
      dataUpdatedAt: 0,
      isInvalidated: true,
      status: query.state.error ? "error" : "pending",
    });
    // Existing refusals stay errors and disabled until the shared card's Retry.
    if (refetch) void cache.invalidateQueries({ queryKey, exact: true });
  }
}

/**
 * Resolve only absent, already-known author IDs through the shared D36 card cache.
 * Any org-bound row that names a person (a message author, an admission user) fits.
 */
export function useCommsMessageAuthors(
  messages: readonly Pick<Message, "org_id" | "author_id">[],
  people: readonly Pick<Person, "id">[],
) {
  const { client, scope } = useCommsClient();
  const cache = useQueryClient();
  const suspended = useWorkspaceInteractionSuspended();
  const identity = useQuery({ ...authMeOptions(), enabled: false });
  const role = identity.data?.currentOrganization?.role;
  const viewerId = client?.context.user_id ?? "";
  const viewer = useMemo<PersonCardViewer>(
    () => ({ id: viewerId, role: role ?? "guest" }),
    [viewerId, role],
  );
  const admitted =
    !!client &&
    !!scope &&
    !scope.signal.aborted &&
    !suspended &&
    !identity.error &&
    identity.data?.id === client.context.user_id &&
    !!role &&
    identity.data.currentOrganization?.orgId === client.context.org_id &&
    currentOrganizationId() === client.context.org_id;
  const allIds = [
    ...new Set(
      messages
        .filter((message) => message.org_id === client?.context.org_id)
        .map((message) => message.author_id),
    ),
  ].sort();
  const missing = admitted
    ? allIds.filter((id) => !people.some((person) => person.id === id))
    : [];
  const idsKey = allIds.join(","),
    missingKey = missing.join(",");
  const seen = useRef<{ viewer: PersonCardViewer; ids: Set<string> } | null>(
    null,
  );
  // At most BURST card reads are in flight: the rest start as those settle.
  const unsettled = missing.filter(
    (id) =>
      cache.getQueryState(personCardKey(viewer, id))?.status !== "success" &&
      cache.getQueryState(personCardKey(viewer, id))?.status !== "error",
  );
  const starting = new Set(unsettled.slice(0, BURST));
  const reads = useQueries({
    queries: missing.map((id) =>
      queryOptions({
        ...personCardOptions(viewer, id),
        enabled: (query) =>
          admitted &&
          !query.state.error &&
          (query.state.status === "success" || starting.has(id)),
      }),
    ),
    combine: (results) => ({
      names: results.flatMap((result, index) => {
        const card = result.isSuccess ? result.data : undefined;
        return card &&
          card.viewer.id === viewer.id &&
          card.viewer.role === viewer.role &&
          card.targetId === missing[index]
          ? [[card.targetId, card.data.display_name] as const]
          : [];
      }),
      refused: results.flatMap((result, index) =>
        result.isError ? [missing[index]] : [],
      ),
    }),
  });
  useLayoutEffect(() => {
    const previous = seen.current;
    if (
      previous &&
      (!admitted ||
        previous.viewer.id !== viewer.id ||
        previous.viewer.role !== viewer.role)
    ) {
      clearCards(cache, previous.viewer, previous.ids, false);
      seen.current = null;
    }
    if (admitted) {
      seen.current ??= { viewer: { ...viewer }, ids: new Set() };
      for (const id of missingKey.split(",").filter(Boolean))
        seen.current.ids.add(id);
    }
  }, [admitted, cache, viewer, missingKey]);
  useLayoutEffect(() => {
    for (const id of reads.refused) {
      const query = cache
        .getQueryCache()
        .find({ queryKey: personCardKey(viewer, id), exact: true });
      if (query?.state.error && query.state.data !== undefined)
        query.setState({ data: undefined, dataUpdatedAt: 0 });
    }
  }, [cache, viewer, reads.refused]);
  useEffect(() => {
    // A runtime retired between render and this effect cannot subscribe.
    if (!admitted || !client || !scope || scope.signal.aborted) return;
    return client.events.subscribe({
      on_event(event) {
        if (
          scope.signal.aborted ||
          currentOrganizationId() !== client.context.org_id
        )
          return;
        if (["grants", "membership", "structure"].includes(event.event)) {
          clearCards(
            cache,
            viewer,
            new Set([
              ...idsKey.split(",").filter(Boolean),
              ...(seen.current?.ids ?? []),
            ]),
            true,
          );
        }
      },
      on_connection() {},
      on_error() {},
    });
  }, [admitted, client, scope, cache, viewer, idsKey]);
  return useMemo(
    () => new Map(admitted ? reads.names : []),
    [admitted, reads.names],
  );
}
