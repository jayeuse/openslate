import type { Page } from "@playwright/test";
import { createMemorySeed } from "../../support/comms-memory/memory/seed";
import { createMemoryCommsRuntime } from "../../support/comms-memory/memory-client";
import { installCommsLiveApi } from "./comms-live-api";
import { defaultOrganization } from "./test";

/**
 * Answers `/api/comms` for `userId` in `defaultOrganization` with the seeded
 * Comms world (an `operations` channel, already read, in an organization the
 * account administers). Journeys that
 * only pass through Comms use it instead of a Comms-specific fake. A later call
 * for another account replaces this world for the page's later requests, so a
 * journey that changes the signed-in account calls it again at that moment
 * with `workspaceEvents: false` (the event stream is already replaced).
 */
export function installSeededComms(
  page: Page,
  userId: string,
  options: { workspaceEvents?: boolean } = {},
) {
  const owner = { user_id: userId, org_id: defaultOrganization.org_id };
  const initial = createMemorySeed(owner, {
    role: "admin",
    display_name: "Seeded Comms owner",
  });
  // The account has read the seeded history, so the shell shows no unread
  // badge and the OpenComms link keeps its plain name.
  initial.users[userId].last_read_seq = { ...initial.high_water_seq };
  return installCommsLiveApi(page, {
    userId,
    organizationId: owner.org_id,
    workspaceEvents: options.workspaceEvents,
    runtime: createMemoryCommsRuntime({ owner, initial }),
  });
}
