import { person, listPage, type User } from "./access-api";
import type { SecurityEvent, SecurityEventOutcome } from "../../../src/lib/api";
import { mockManageSecurity } from "./manage-security";
import { deferredMfaResponse, mockMfa, mfaUserA } from "./mfa";
import type { Page, Route } from "./test";

export const historicalPersonId = "00000000-0000-4000-8000-000000000099";
export const eventOperationId = "00000000-0000-4000-8000-000000000900";
export const unsafeEventCanary = "CONTROLLED_UNDISPLAYED_EVENT_METADATA";

export function securityEvent(
  index: number,
  patch: Partial<SecurityEvent> = {},
): SecurityEvent {
  return {
    id: `00000000-0000-4000-8000-${String(700 + index).padStart(12, "0")}`,
    occurred_at: `2026-10-06T${String(12 - index).padStart(2, "0")}:00:00Z`,
    event_type: "identity.sign_in",
    outcome: "success",
    source: "identity",
    operation_id: eventOperationId,
    actor_id: mfaUserA,
    subject_id: mfaUserA,
    labels: {},
    fingerprint: null,
    reason: null,
    request_id: null,
    request_method: "POST",
    request_path: "/api/auth/login",
    metadata: { ip_address: "198.51.100.42" },
    ...patch,
  };
}

export function mixedSecurityEvents(): SecurityEvent[] {
  return [
    securityEvent(0),
    securityEvent(1, {
      event_type: "identity.sign_in_failure",
      outcome: "failure",
      actor_id: null,
      subject_id: null,
      fingerprint: "a".repeat(64),
      reason: "credentials_rejected",
      metadata: {
        ip_address: "198.51.100.42",
        bucket_start: "2026-10-06T11:00:00Z",
        bucket_end: "2026-10-06T12:00:00Z",
        internal_note: unsafeEventCanary,
      },
    }),
    securityEvent(2, {
      event_type: "identity.password_change",
      outcome: "partial",
      reason: null,
      metadata: {
        ip_address: "2001:db8::42",
        stage: "local_commit",
        internal_note: unsafeEventCanary,
      },
    }),
    securityEvent(3, {
      event_type: "identity.lockout",
      outcome: "denied",
      actor_id: null,
      subject_id: null,
      metadata: { ip_address: null },
    }),
    securityEvent(4, {
      event_type: "identity.recovery_request",
      outcome: "attempt",
      actor_id: null,
      subject_id: null,
      request_path: "/api/auth/recovery/request",
      metadata: { ip_address: null },
    }),
    securityEvent(5, {
      event_type: "internal.controlled_check",
      subject_id: historicalPersonId,
      actor_id: null,
      metadata: { ip_address: null },
    }),
  ];
}

type HeldRead = ReturnType<typeof deferredMfaResponse>;
export type SecurityEventsFixture = Awaited<
  ReturnType<typeof mockSecurityEvents>
>;

function matchesEvent(event: SecurityEvent, query: URLSearchParams) {
  const search = (query.get("search") ?? "").trim().toLowerCase();
  const type = query.get("event_type");
  const outcome = query.get("outcome");
  const person = query.get("person_id");
  const after = query.get("occurred_after");
  const before = query.get("occurred_before");
  const operation = query.get("operation_id");
  return (
    (!search ||
      [event.event_type, event.source, event.reason, event.request_path]
        .join(" ")
        .toLowerCase()
        .includes(search)) &&
    (!type || event.event_type === type) &&
    (!outcome || event.outcome === outcome) &&
    (!person || event.actor_id === person || event.subject_id === person) &&
    (!after || Date.parse(event.occurred_at) >= Date.parse(after)) &&
    (!before || Date.parse(event.occurred_at) < Date.parse(before)) &&
    (!operation || event.operation_id === operation)
  );
}

export async function mockSecurityEvents(page: Page) {
  const auth = await mockMfa(page);
  const security = await mockManageSecurity(page);
  const state = {
    auth,
    security,
    role: "admin" as "admin" | "member" | "guest",
    manager: false,
    events: mixedSecurityEvents(),
    listStatus: 200,
    detailStatus: 200,
    usersStatus: 200,
    malformedList: null as unknown,
    malformedDetail: null as unknown,
    reads: [] as URLSearchParams[],
    details: [] as string[],
    userReads: 0,
    userQueries: [] as URLSearchParams[],
    directory: [
      person({
        id: mfaUserA,
        email: "unshown-person@example.invalid",
        username: "mara",
        role: "admin",
        display_name: "Mara",
      }),
    ] as User[],
    sessionReads: 0,
    commands: [] as { method: string; path: string }[],
    holdList: null as HeldRead | null,
    holdDetail: null as HeldRead | null,
  };
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({
      json: {
        id: auth.userId,
        role: state.role,
        access: state.manager
          ? [
              {
                department_id: historicalPersonId,
                module_id: null,
                level: "manage",
              },
            ]
          : [],
      },
    }),
  );
  await page.route("**/api/auth/session", async (route) => {
    state.sessionReads += 1;
    await route.fallback();
  });
  await page.route(/\/api\/users(?:\?|$)/, async (route) => {
    state.userReads += 1;
    const url = new URL(route.request().url());
    state.userQueries.push(new URLSearchParams(url.searchParams));
    const users = state.directory
      .slice()
      .filter((user) => {
        const selected = url.searchParams.getAll("ids");
        const search = (url.searchParams.get("search") ?? "").toLowerCase();
        return (
          (!selected.length || selected.includes(user.id)) &&
          (!search ||
            `${user.username}\n${user.display_name ?? ""}\n${user.email}`
              .toLowerCase()
              .includes(search))
        );
      })
      .sort(
        (left, right) =>
          left.username.localeCompare(right.username) ||
          left.id.localeCompare(right.id),
      )
      .map((user) => ({
        ...user,
        active_session_count: 0,
        mfa_verified_totp: null,
        mfa_observed_at: null,
        last_sign_in_at: null,
        last_active_at: null,
      }));
    await route.fulfill({
      status: state.usersStatus,
      json:
        state.usersStatus === 200
          ? listPage(users, url)
          : { detail: "Directory unavailable" },
    });
  });
  async function failRead(route: Route, status: number) {
    await route.fulfill({
      status,
      headers: { "Cache-Control": "no-store" },
      json: {
        detail: { code: "controlled_refusal", message: unsafeEventCanary },
      },
    });
  }
  await page.route(/\/api\/security-events(?:\?|$)/, async (route) => {
    if (route.request().method() !== "GET") {
      state.commands.push({
        method: route.request().method(),
        path: "/security-events",
      });
      await failRead(route, 405);
      return;
    }
    const query = new URL(route.request().url()).searchParams;
    state.reads.push(new URLSearchParams(query));
    const status = state.listStatus;
    const malformed = state.malformedList;
    const direction = query.get("sort_order") === "asc" ? 1 : -1;
    const key = query.get("sort_by") ?? "occurred_at";
    const filtered = state.events.filter((event) => matchesEvent(event, query));
    filtered.sort(
      (a, b) =>
        direction *
        (String(a[key as keyof SecurityEvent]).localeCompare(
          String(b[key as keyof SecurityEvent]),
        ) || a.id.localeCompare(b.id)),
    );
    const limit = Number(query.get("limit") ?? "10");
    const offset = Number(query.get("offset") ?? "0");
    const items = structuredClone(filtered.slice(offset, offset + limit));
    const hold = state.holdList;
    state.holdList = null;
    if (hold) {
      hold.start();
      await hold.waiting;
    }
    if (status !== 200) {
      await failRead(route, status);
      return;
    }
    await route.fulfill({
      headers: { "Cache-Control": "no-store" },
      json: malformed ?? {
        items,
        pagination: {
          limit,
          offset,
          count: items.length,
          total: filtered.length,
          has_more: offset + items.length < filtered.length,
        },
      },
    });
  });
  await page.route(/\/api\/security-events\/[^/?]+$/, async (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1) ?? "";
    state.details.push(id);
    const status = state.detailStatus;
    const found = structuredClone(
      state.events.find((event) => event.id === id),
    );
    const malformed = state.malformedDetail;
    const hold = state.holdDetail;
    state.holdDetail = null;
    if (hold) {
      hold.start();
      await hold.waiting;
    }
    if (status !== 200 || !found) {
      await failRead(route, status === 200 ? 404 : status);
      return;
    }
    await route.fulfill({
      headers: { "Cache-Control": "no-store" },
      json: malformed ?? found,
    });
  });
  return state;
}

export function matchingPageEvents(outcome: SecurityEventOutcome = "success") {
  return Array.from({ length: 25 }, (_, index) =>
    securityEvent(30 + index, {
      occurred_at: `2026-10-06T07:${String(index).padStart(2, "0")}:00Z`,
      event_type: "identity.sign_in",
      outcome,
    }),
  );
}
