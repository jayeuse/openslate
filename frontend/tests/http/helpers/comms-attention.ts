import { createMemorySeed } from "../../support/comms-memory/memory/seed";
import { createMemoryCommsRuntime } from "../../support/comms-memory/memory-client";
import type * as C from "../../../src/components/systems/comms/contract/types";
import { pageOf } from "../../helpers/pagination";
import { defaultSignedInIdentity, expect, type Page } from "./test";

type Emissions = { desktop: { title: string; body: string }[]; sound: number };

/** Counts desktop alerts and sounds in shared localStorage, so one read sees every tab. */
export async function installAttentionBrowser(
  page: Page,
  permission: NotificationPermission = "granted",
): Promise<void> {
  await page.addInitScript((permission) => {
    const list = (): unknown[] =>
      JSON.parse(localStorage.getItem("attention-desktop") ?? "[]");
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: class {
        static readonly permission = permission;
        static async requestPermission() {
          return permission;
        }
        onclick: (() => void) | null = null;
        constructor(title: string, options?: NotificationOptions) {
          localStorage.setItem(
            "attention-desktop",
            JSON.stringify([...list(), { title, body: options?.body ?? "" }]),
          );
        }
        close() {}
      },
    });
    HTMLMediaElement.prototype.play = async () => {
      const count = Number(localStorage.getItem("attention-sound") ?? 0);
      localStorage.setItem("attention-sound", String(count + 1));
    };
  }, permission);
}

export function attentionEmissions(page: Page): Promise<Emissions> {
  return page.evaluate(() => ({
    desktop: JSON.parse(localStorage.getItem("attention-desktop") ?? "[]"),
    sound: Number(localStorage.getItem("attention-sound") ?? 0),
  }));
}

/**
 * Waits until the leader tab has taken its unread baseline (it records the
 * `baseline` notice ids as already seen) and holds the one event stream. A
 * notice added before then is part of the baseline, never an alert.
 */
export async function attentionBaselined(
  tabs: Page[],
  orgId: string,
  baseline: string[],
): Promise<void> {
  const key = `openslate-comms-alerted:v1:${defaultSignedInIdentity.id}:${orgId}`;
  await expect
    .poll(async () => {
      const seen: unknown = await tabs[0].evaluate(
        (key) => JSON.parse(localStorage.getItem(key) ?? "[]"),
        key,
      );
      const streams = await Promise.all(
        tabs.map((tab) =>
          tab.evaluate(
            () =>
              (
                Reflect.get(window, "__openViewStreamState") as () => {
                  active: number;
                }
              )().active,
          ),
        ),
      );
      return (
        Array.isArray(seen) &&
        baseline.every((id) => seen.includes(id)) &&
        streams.reduce((sum, active) => sum + active, 0) === 1
      );
    })
    .toBe(true);
}

const noticeId = (n: number, prefix = "95") =>
  `${prefix}000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export function commsNotice(
  n: number,
  orgId: string,
  conversationId: string,
  kind: "comms-mention" | "comms-direct" = "comms-mention",
) {
  const message = noticeId(n, "96");
  return {
    id: noticeId(n),
    kind,
    subject_type: "comms_message",
    subject_id: message,
    org_id: orgId,
    conversation_id: conversationId,
    message_id: message,
    status: "unread",
    scheduled_for: null,
    created_at: "2026-10-21T08:00:00Z",
    read_at: null,
  };
}

/** Comms reads a non-Comms route makes, with DTOs from the frozen memory fixture. */
export async function installAttentionApi(
  page: Page,
  options: {
    orgId: string;
    unread: number;
    mutedMentions?: number;
    personal?: Partial<C.PersonalPreferences["notifications"]>;
  },
) {
  const owner = { user_id: defaultSignedInIdentity.id, org_id: options.orgId };
  const memory = createMemoryCommsRuntime({
    owner,
    initial: createMemorySeed(owner, {
      role: "admin",
      display_name: "Attention owner",
    }),
  });
  const initial = await memory.client.bootstrap();
  const room = initial.conversations.find(
    (row) => row.conversation.kind === "channel",
  )!;
  // The seed has one channel; a renamed copy stands for a muted second one.
  const quiet = {
    ...room,
    conversation: {
      ...room.conversation,
      id: "94000000-0000-4000-8000-0000000000bb",
      name: "quiet-room",
    },
  };
  const counted = (
    row: C.ConversationSummary,
    unread: number,
    mentions: number,
    muted: boolean,
  ): C.ConversationSummary => ({
    ...row,
    preferences: { ...row.preferences, notify: muted ? "mute" : "all" },
    last_read_seq: 0,
    high_water_seq: unread,
    unread_count: unread,
    mention_count: mentions,
    first_unread_seq: unread ? 1 : null,
  });
  const state = {
    room: room.conversation.id,
    unread: options.unread,
    notifications: [] as ReturnType<typeof commsNotice>[],
    bootstrapReads: 0,
    listReads: 0,
    preferenceReads: 0,
  };
  const settings = await memory.client.getSettings({ kind: "workspace" });
  const channel = await memory.client.getSettings({
    kind: "channel",
    id: state.room,
  });
  const personal = (await memory.client.getPersonalPreferences()).data;
  memory.dispose();
  const headers = { ETag: '"attention-1"', "Cache-Control": "no-store" };
  await page.route(
    (url) =>
      url.pathname.startsWith("/api/comms/") ||
      url.pathname === "/api/notifications",
    (route) => {
      const url = new URL(route.request().url());
      if (route.request().headers()["x-org"] !== options.orgId)
        return route.fallback();
      if (url.pathname === "/api/notifications") {
        state.listReads += 1;
        const unread = url.searchParams.get("status") === "unread";
        const items = state.notifications.filter(
          (item) => !unread || item.status === "unread",
        );
        return route.fulfill({
          json: pageOf(items, {
            limit: Number(url.searchParams.get("limit")),
            offset: Number(url.searchParams.get("offset")),
          }),
        });
      }
      if (url.pathname === "/api/comms/bootstrap") {
        state.bootstrapReads += 1;
        return route.fulfill({
          headers,
          json: {
            ...initial,
            conversations: [
              counted(room, state.unread, 0, false),
              counted(quiet, 5, options.mutedMentions ?? 0, true),
            ],
          },
        });
      }
      if (url.pathname === "/api/comms/preferences") {
        state.preferenceReads += 1;
        return route.fulfill({
          headers,
          json: {
            ...personal,
            notifications: { ...personal.notifications, ...options.personal },
          },
        });
      }
      if (url.pathname === "/api/comms/settings/workspace")
        return route.fulfill({ headers, json: settings.data });
      if (url.pathname === `/api/comms/settings/channel/${state.room}`)
        return route.fulfill({ headers, json: channel.data });
      return route.fulfill({ status: 404, json: { detail: "Not found" } });
    },
  );
  return state;
}
