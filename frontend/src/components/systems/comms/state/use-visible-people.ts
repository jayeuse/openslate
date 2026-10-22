"use client";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Person } from "../../shared/data/sample-people";
import { useCommsClient } from "./client-context";
import { useCommsWorkspaceView } from "./use-comms-workspace";
import { isCommsReadRefusal } from "./runtime";
import { commsPerson, complete } from "./workspace-view";
import { BURST, limited } from "./bounded";

/**
 * Everyone in the viewer's conversations, for a people picker. It is read
 * only once a picker opens (`enabled`), never on the cold load; until then,
 * and while it loads, the people of the open conversations are offered.
 */
export function useVisiblePeople(enabled: boolean): Person[] {
  const { scope, client, bootstrap } = useCommsClient();
  const { people } = useCommsWorkspaceView();
  const rooms = (bootstrap?.conversations ?? []).map(
    ({ conversation }) => conversation.id,
  );
  const read = useQuery({
    // Not keyed by the room list: a new or seeded conversation does not read
    // everyone again; the cached union refreshes when it goes stale.
    queryKey: [...(scope?.keys.all ?? ["comms-unadmitted"]), "people"],
    enabled: enabled && !!scope && !!client && rooms.length > 0,
    queryFn: ({ signal }) => {
      if (!scope || !client) throw new Error("Organization is not admitted");
      return scope.read(
        "people",
        (signal) =>
          limited(rooms, BURST, (id) =>
            complete((offset) =>
              client.listMembers(id, { limit: 100, offset }, { signal }),
            ).catch((error: unknown) => {
              // A conversation that left meanwhile has no visible people.
              if (isCommsReadRefusal(error)) return [];
              throw error;
            }),
          ).then((pages) => pages.flat()),
        signal,
      );
    },
  });
  const members = read.data;
  return useMemo(() => {
    const union = new Map(people.map((person) => [person.id, person]));
    for (const member of members ?? [])
      if (!union.has(member.user_id))
        union.set(member.user_id, {
          ...commsPerson(
            member.user_id,
            member.display_name,
            member.departments,
          ),
          groupIds: [],
        });
    return [...union.values()];
  }, [people, members]);
}
