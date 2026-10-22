import { expect, test } from "@playwright/test";
import { withBootstrap } from "../../../src/components/systems/comms/state/workspace-view";
import type * as C from "../../../src/components/systems/comms/contract/types";
import { direct, org, user } from "./structure-fixtures";

const preferences = {
  notify: "all",
  mute: { kind: "off" },
  starred: false,
  hidden: false,
  manual_unread: false,
} as const;
const summary = (
  conversation: C.Conversation,
  unread = 0,
): C.ConversationSummary => ({
  conversation,
  preferences,
  last_read_seq: 0,
  high_water_seq: unread,
  unread_count: unread,
  mention_count: 0,
  first_unread_seq: unread ? 1 : null,
});
const named = direct as C.DirectConversation;
const former: C.DirectConversation = {
  ...named,
  id: "00000000-0000-4000-8000-000000000031",
  participant_ids: [user, "00000000-0000-4000-8000-000000000032"],
  participants: [
    { user_id: user, display_name: "Owner" },
    { user_id: "00000000-0000-4000-8000-000000000032", display_name: null },
  ],
};
// Only the fields the bootstrap projection reads; the rest of a loaded
// workspace does not take part in it.
const loaded = {
  client: { context: { org_id: org, user_id: user } },
  blocks: [] as C.DirectBlock[],
  configuration: { preferences: {} },
} as unknown as Parameters<typeof withBootstrap>[0];
const bootstrap = (rows: C.ConversationSummary[]): C.Bootstrap => ({
  org_id: org,
  user_id: user,
  categories: [],
  conversations: rows,
});

test("direct rows are named from bootstrap participants and follow the live bootstrap", () => {
  const view = withBootstrap(
    loaded,
    bootstrap([summary(named), summary(former, 2)]),
  );
  expect(view.directs).toEqual([
    { id: named.id, user: "Peer", read: true, blocked: false },
    { id: former.id, user: "Former member", read: false, blocked: false },
  ]);
  // A later bootstrap (here: the second direct was read) needs no other read.
  const later = withBootstrap(
    loaded,
    bootstrap([summary(named), summary(former)]),
  );
  expect(later.directs.map((row) => row.read)).toEqual([true, true]);
  expect(later.configuration.preferences[user].readAt).toEqual({
    [named.id]: Number.MAX_SAFE_INTEGER,
    [former.id]: Number.MAX_SAFE_INTEGER,
  });
});
