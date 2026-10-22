import type { CommsViewClient } from "../contract/client";
import type * as C from "../contract/types";
import { complete } from "../state/workspace-view";
import { failureStatus } from "../contract/failure-status";

/** What one conversation needs once it is open: never read for unopened ones. */
export interface ConversationDetail {
  members: C.Member[];
  /** Absent when the viewer may read but holds no capability check (403). */
  check?: C.CapabilityCheck;
  /** Channel settings; a direct or group conversation uses the workspace's. */
  settings?: C.SettingsResponse;
  capabilities?: C.CapabilityConfiguration;
  pins: C.Message[];
}

/** The open conversation's members' presence; read beside, never before, it. */
export type ConversationPresence = Record<
  string,
  C.PresenceSnapshot["items"][number]["state"]
>;

type DetailClient = Pick<
  CommsViewClient,
  | "listMembers"
  | "getCapabilities"
  | "getSettings"
  | "getCapabilityConfiguration"
  | "listPins"
>;

/** Reads one conversation's members, access check, settings and pins at once. */
export async function loadConversationDetail(
  client: DetailClient,
  id: string,
  channel: boolean,
  signal: AbortSignal,
): Promise<ConversationDetail> {
  const options = { signal };
  const [members, check, settings, capabilities, pins] = await Promise.all([
    complete((offset) =>
      client.listMembers(id, { limit: 100, offset }, options),
    ),
    // A readable conversation may refuse the check itself; that is no refusal.
    client.getCapabilities(id, options).catch((error: unknown) => {
      if (failureStatus(error) === 403) return undefined;
      throw error;
    }),
    channel
      ? client
          .getSettings({ kind: "channel", id }, options)
          .then((response) => response.data)
      : undefined,
    channel
      ? client
          .getCapabilityConfiguration({ kind: "channel", id }, options)
          .then((response) => response.data)
      : undefined,
    complete((offset) => client.listPins(id, { limit: 100, offset }, options)),
  ]);
  return { members, check, settings, capabilities, pins };
}

/** Reads presence for the given people, 100 at a time, all at once. */
export async function loadConversationPresence(
  client: Pick<CommsViewClient, "getPresence">,
  userIds: readonly string[],
  signal: AbortSignal,
): Promise<ConversationPresence> {
  const pages = [];
  for (let offset = 0; offset < userIds.length; offset += 100)
    pages.push(
      client.getPresence(
        { user_ids: userIds.slice(offset, offset + 100) },
        { signal },
      ),
    );
  const presence: ConversationPresence = {};
  for (const page of await Promise.all(pages))
    for (const item of page.items) presence[item.user_id] = item.state;
  return presence;
}
