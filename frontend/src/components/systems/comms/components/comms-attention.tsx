"use client";
import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import {
  hashKey,
  queryOptions,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useUserPreferences } from "@/components/theme-provider";
import { useWorkspaceNavigationRequest } from "@/components/workspace-navigation-guard";
import { isIanaTimezone } from "@/lib/date-time-display";
import { workspaceCalendarQueryOptions } from "../../manage/adapters/workspace-api";
import { notificationPresentation } from "../../platform/helpers/notification-kind";
import {
  listNotifications,
  type Notification as InboxItem,
} from "../../shared/adapters/notifications-api";
import { subscribeWorkspaceConnectionOwnership } from "../../shared/adapters/connection-set";
import { subscribeWorkspaceInvalidations } from "../../shared/adapters/invalidation-events";
import {
  registerWorkspaceSessionClear,
  useAdmittedWorkspaceScope,
  useWorkspaceInteractionSuspended,
} from "../../shared/runtime/workspace-identity";
import { bootstrap } from "../adapters/message-api";
import { getPersonalPreferences } from "../adapters/preferences-api";
import { getSettings } from "../adapters/settings-api";
import type { Bootstrap, CommsContext, SettingsScope } from "../contract/types";
import { attentionPolicy, minuteIn, unreadTotal } from "../domain/attention";

const keys = (context: CommsContext) =>
  ["comms-attention", context.user_id, context.org_id] as const;
const bootstrapKey = (context: CommsContext) =>
  [...keys(context), "bootstrap"] as const;
const personalOptions = (context: CommsContext) =>
  queryOptions({
    queryKey: [...keys(context), "personal"],
    queryFn: async ({ signal }) =>
      (await getPersonalPreferences(context, { signal })).data.notifications,
  });
const sharedOptions = (context: CommsContext, scope: SettingsScope) =>
  queryOptions({
    queryKey: [
      ...keys(context),
      "shared",
      scope.kind === "workspace" ? scope.kind : scope.id,
    ],
    queryFn: async ({ signal }) =>
      (await getSettings(context, scope, { signal })).data.effective,
  });
const onComms = (pathname: string) =>
  pathname === "/comms" || pathname.startsWith("/comms/");
const storage = {
  read(key: string): unknown {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "null");
    } catch {
      return null;
    }
  },
  write(key: string, value: unknown) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* Blocked storage: the in-memory copy below keeps this tab's memory. */
    }
  },
};
const alertedPrefix = (user: string) => `openslate-comms-alerted:v1:${user}:`;
// Union with localStorage, so blocked storage cannot replay the newest alerts.
const alertedInTab = new Map<string, string[]>();
function alerted(key: string) {
  const stored = storage.read(key);
  return new Set([
    ...(alertedInTab.get(key) ?? []),
    ...(Array.isArray(stored)
      ? stored.filter((id): id is string => typeof id === "string")
      : []),
  ]);
}
function rememberAlerted(key: string, ids: string[]) {
  if (!ids.length) return;
  const next = [...new Set([...alerted(key), ...ids])].slice(-100);
  alertedInTab.set(key, next);
  storage.write(key, next);
}
// A tab baselines each account and organization once. The mark is taken
// before the read, so a regained leadership never re-reads the inbox.
const baselined = new Set<string>();
function clearAlerted(user: string) {
  for (const key of [...alertedInTab.keys(), ...baselined])
    if (key.startsWith(alertedPrefix(user))) {
      alertedInTab.delete(key);
      baselined.delete(key);
    }
  try {
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (key?.startsWith(alertedPrefix(user))) localStorage.removeItem(key);
    }
  } catch {
    /* Nothing persisted to clear. */
  }
}

/**
 * Current-organization unread messages for the shell. `/comms` already keeps
 * its live bootstrap current, so it is mirrored there instead of read twice.
 */
export function useCommsUnreadCount(): number | undefined {
  const context = useAdmittedWorkspaceScope();
  const suspended = useWorkspaceInteractionSuspended();
  const pathname = usePathname();
  const client = useQueryClient();
  const user = context?.user_id,
    org = context?.org_id;
  useEffect(() => {
    if (!user || !org) return;
    const source = ["comms", user, org, "bootstrap"];
    const target = bootstrapKey({ user_id: user, org_id: org });
    const copy = () => {
      const data = client.getQueryData<Bootstrap>(source);
      if (data) client.setQueryData(target, data);
    };
    copy();
    const hash = hashKey(source);
    return client.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.query.queryHash === hash) copy();
    });
  }, [client, user, org]);
  const query = useQuery({
    queryKey: context ? bootstrapKey(context) : ["comms-attention", "none"],
    queryFn: ({ signal }) => bootstrap(context!, { signal }),
    enabled: Boolean(context) && !suspended && !onComms(pathname),
  });
  const data = query.data;
  // Timed mutes are judged at the read that produced this count.
  const count = data ? unreadTotal(data, query.dataUpdatedAt) : 0;
  // Read only while there is something to badge; cached for every route.
  const personal = useQuery({
    ...personalOptions(context ?? { user_id: "", org_id: "" }),
    enabled: Boolean(context) && !suspended && count > 0,
  });
  const shared = useQuery({
    ...sharedOptions(context ?? { user_id: "", org_id: "" }, {
      kind: "workspace",
    }),
    enabled: Boolean(context) && !suspended && count > 0,
  });
  if (!context || suspended || !data) return undefined;
  if (count === 0) return 0;
  // Never show a badge before the badges preference is known.
  if (personal.isPending || shared.isPending) return undefined;
  if (
    personal.data &&
    shared.data &&
    !attentionPolicy(shared.data, personal.data, null).badges
  )
    return 0;
  return count;
}

let chimeUri: string | undefined;
/** A short generated tone; no asset request and no autoplay before an alert. */
function chime() {
  if (chimeUri) return chimeUri;
  const rate = 8000,
    length = 1200,
    bytes = new Uint8Array(44 + length),
    view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) =>
    [...value].forEach((char, index) =>
      view.setUint8(offset + index, char.charCodeAt(0)),
    );
  text(0, "RIFF");
  view.setUint32(4, 36 + length, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, "data");
  view.setUint32(40, length, true);
  for (let i = 0; i < length; i++)
    bytes[44 + i] =
      128 +
      Math.round(
        Math.sin((2 * Math.PI * 880 * i) / rate) * 48 * (1 - i / length),
      );
  chimeUri = `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
  return chimeUri;
}

function permitted() {
  try {
    return (
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    );
  } catch {
    return false;
  }
}

/**
 * Tab title count, focused-conversation record, and leader-only desktop alert
 * and sound. Alerts carry only the notification kind and conversation label.
 */
export function CommsAttention() {
  const context = useAdmittedWorkspaceScope();
  const suspended = useWorkspaceInteractionSuspended();
  const count = useCommsUnreadCount();
  const client = useQueryClient();
  const router = useRouter();
  const requestNavigation = useWorkspaceNavigationRequest();
  const { regional } = useUserPreferences();
  const pathname = usePathname();
  const search = useSearchParams();
  const conversation = onComms(pathname) ? search.get("conversation") : null;
  const latest = useRef<{ open: (href: Route) => void; zone: string }>({
    open: () => {},
    zone: "",
  });
  useEffect(() => {
    latest.current = {
      open(href) {
        const go = () => router.push(href);
        if (requestNavigation(href, go)) go();
      },
      zone:
        regional?.timezone && isIanaTimezone(regional.timezone)
          ? regional.timezone
          : "",
    };
  });

  const prefix = count ? `(${count > 99 ? "99+" : count}) ` : "";
  useEffect(() => {
    const strip = (title: string) => title.replace(/^\(\d+\+?\) /, "");
    const apply = () => {
      const next = prefix + strip(document.title);
      if (document.title !== next) document.title = next;
    };
    apply();
    // Route metadata can replace the title after this effect runs.
    const observer = new MutationObserver(apply);
    observer.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => {
      observer.disconnect();
      document.title = strip(document.title);
    };
  }, [prefix]);

  const user = context?.user_id,
    org = context?.org_id;
  useEffect(() => {
    if (!user || !org) return;
    const key = `openslate-comms-focus:v1:${user}:${org}`;
    const tab = crypto.randomUUID();
    const ours = () => {
      const value = storage.read(key);
      return (
        typeof value === "object" &&
        value !== null &&
        "tab" in value &&
        value.tab === tab
      );
    };
    const record = () => {
      if (
        conversation &&
        document.visibilityState === "visible" &&
        document.hasFocus()
      )
        storage.write(key, { tab, conversation });
      else if (ours()) storage.write(key, null);
    };
    const leave = () => {
      if (ours()) storage.write(key, null);
    };
    record();
    window.addEventListener("focus", record);
    window.addEventListener("blur", record);
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", record);
    return () => {
      window.removeEventListener("focus", record);
      window.removeEventListener("blur", record);
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", record);
      leave();
    };
  }, [user, org, conversation]);

  const away = !onComms(pathname);
  useEffect(() => {
    if (!user || !org || suspended || !away) return;
    const key = bootstrapKey({ user_id: user, org_id: org });
    // Approved exception to the no-focus-refetch rule: reads made in another
    // tab send no stream event here, so a stale count refreshes on return.
    const visible = () => {
      const state = client.getQueryState(key);
      if (
        document.visibilityState === "visible" &&
        state &&
        Date.now() - state.dataUpdatedAt > 30_000
      )
        void client.refetchQueries({ queryKey: key, exact: true });
    };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [client, user, org, suspended, away]);

  useEffect(
    () =>
      user
        ? registerWorkspaceSessionClear(user, () => clearAlerted(user))
        : undefined,
    [user],
  );

  useEffect(() => {
    if (!user || !org || suspended) return;
    const scope = { user_id: user, org_id: org };
    const seenKey = `${alertedPrefix(user)}${org}`;
    let leader = false,
      running: Promise<void> | null = null,
      seedPending = false,
      again = false,
      alive = true;
    // Outside the bell's keys: its cold-read cancellation must not drop a baseline.
    const unread = async () =>
      (
        await client.fetchQuery({
          queryKey: [...keys(scope), "unread"],
          queryFn: ({ signal }) =>
            listNotifications({ limit: 10, status: "unread" }, signal),
          staleTime: 0,
        })
      ).items.filter(
        (item): item is Extract<InboxItem, { subjectType: "comms_message" }> =>
          item.subjectType === "comms_message" && item.orgId === org,
      );
    /** True once the alert decision completed; a failed read leaves it unseen. */
    async function alert(
      item: Extract<InboxItem, { subjectType: "comms_message" }>,
    ): Promise<boolean> {
      const row = client
        .getQueryData<Bootstrap>(bootstrapKey(scope))
        ?.conversations.find(
          (summary) => summary.conversation.id === item.conversationId,
        )?.conversation;
      const focused = storage.read(`openslate-comms-focus:v1:${user}:${org}`);
      if (
        typeof focused === "object" &&
        focused !== null &&
        "conversation" in focused &&
        focused.conversation === item.conversationId
      )
        return true;
      const [personal, shared, calendar] = await Promise.all([
        client.fetchQuery(personalOptions(scope)),
        client.fetchQuery(
          sharedOptions(
            scope,
            row?.kind === "channel"
              ? { kind: "channel", id: row.id }
              : { kind: "workspace" },
          ),
        ),
        latest.current.zone
          ? null
          : client.fetchQuery({
              ...workspaceCalendarQueryOptions(),
              staleTime: 30_000,
            }),
      ]);
      const zone = latest.current.zone || calendar?.timezone || "";
      const policy = attentionPolicy(
        shared,
        personal,
        zone ? minuteIn(zone, Date.now()) : null,
      );
      if (!alive || !leader) return false;
      const presentation = notificationPresentation(item);
      if (policy.desktop && permitted())
        try {
          const notice = new Notification("OpenComms", {
            tag: item.id,
            body: !policy.preview
              ? "New activity in OpenComms"
              : row?.kind === "channel"
                ? `${presentation.label} in ${row.name}`
                : presentation.label,
          });
          notice.onclick = () => {
            window.focus();
            notice.close();
            if (presentation.href)
              latest.current.open(presentation.href as Route);
          };
        } catch {
          /* A browser that refuses construction shows no alert. */
        }
      if (policy.sound) void new Audio(chime()).play().catch(() => {});
      return true;
    }
    // Unread notices present when this tab takes over were not new to it,
    // even if leadership moves again before the read returns.
    const baseline = async () => {
      try {
        rememberAlerted(
          seenKey,
          (await unread()).map((item) => item.id),
        );
      } catch (error) {
        baselined.delete(seenKey);
        throw error;
      }
    };
    const check = async () => {
      const items = await unread();
      if (!alive || !leader) return;
      const known = alerted(seenKey);
      const fresh = items.filter((item) => !known.has(item.id));
      // Only the newest three alert; an older backlog is recorded silently.
      rememberAlerted(
        seenKey,
        fresh.slice(3).map((item) => item.id),
      );
      for (const item of fresh.slice(0, 3)) {
        if (!(await alert(item))) return;
        rememberAlerted(seenKey, [item.id]);
      }
    };
    const run = () => {
      if (running) return;
      running = (async () => {
        while (alive && (seedPending || (again && leader))) {
          const seed = seedPending;
          if (seed) seedPending = false;
          else again = false;
          // A failed read is retried by the next notification event.
          await (seed ? baseline() : check()).catch(() => {});
        }
        running = null;
      })();
    };
    const stopOwnership = subscribeWorkspaceConnectionOwnership(
      scope,
      (state) => {
        const became = state.isLeader && !leader;
        leader = state.isLeader;
        if (became && !baselined.has(seenKey)) {
          baselined.add(seenKey);
          seedPending = true;
          run();
        }
      },
    );
    const stopEvents = subscribeWorkspaceInvalidations((event) => {
      if (
        event.type !== "invalidate" ||
        event.entity !== "in_app_notifications"
      )
        return;
      void client.invalidateQueries({ queryKey: bootstrapKey(scope) });
      if (!leader) return;
      again = true;
      run();
    });
    return () => {
      alive = false;
      stopOwnership();
      stopEvents();
    };
  }, [client, user, org, suspended]);
  return null;
}
