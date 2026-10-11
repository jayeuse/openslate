import { expect, test } from "@playwright/test";

import { ApiContractError } from "../../../src/lib/api";
import {
  defaultSecurityEventsRequest,
  getAccessSecurityEvent,
  listAccessSecurityEvents,
} from "../../../src/components/systems/access/adapters/security-events-api";
import { installFetch, pageOf } from "./fixtures";

// Security events are a privileged read: a page or a detail with one
// unsupported fact is refused whole, so the feed shows "could not be loaded"
// instead of trusting it. The http journeys keep the invalid-outcome page
// ("Events malformed ${malformed.title} response is unavailable rather than
// trusted") and the shared detail failure branch ("Events cold unavailable and
// detail failure offer explicit recovery with no invented facts").

const person = "00000000-0000-4000-8000-000000000001";

// The same events as securityEvent(index) in tests/http/helpers/security-events.ts.
function event(index: number, patch: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(700 + index).padStart(12, "0")}`,
    occurred_at: `2026-10-06T${String(12 - index).padStart(2, "0")}:00:00Z`,
    event_type: "identity.sign_in",
    outcome: "success",
    source: "identity",
    operation_id: "00000000-0000-4000-8000-000000000900",
    actor_id: person,
    subject_id: person,
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

test("security events list sends the default request and accepts recorded and empty facts", async () => {
  const items = [
    event(0),
    event(1, {
      actor_id: null,
      subject_id: null,
      request_method: null,
      request_path: null,
      metadata: {},
    }),
  ];
  const mock = installFetch(() => Response.json(pageOf(items)));
  try {
    const page = await listAccessSecurityEvents(defaultSecurityEventsRequest);
    expect(page.items).toEqual(items);
    expect(String(mock.requests[0]?.input)).toBe(
      "/api/security-events?limit=10&offset=0&search=&sort_by=occurred_at&sort_order=desc",
    );
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
  } finally {
    mock.restore();
  }
});

for (const row of [
  { name: "an invalid outcome", item: event(0, { outcome: "unknown" }) },
  {
    name: "a naive occurrence time",
    item: event(0, { occurred_at: "2026-10-06T12:00:00" }),
  },
  {
    name: "a person that is not a UUID",
    item: event(0, { actor_id: "email@example.invalid" }),
  },
  { name: "an unknown field", item: event(0, { internal_note: "hidden" }) },
  {
    name: "a label that is not text",
    item: event(0, { labels: { stage: 1 } }),
  },
])
  test(`security events list refuses ${row.name}`, async () => {
    const mock = installFetch(() => Response.json(pageOf([row.item])));
    try {
      await expect(
        listAccessSecurityEvents(defaultSecurityEventsRequest),
      ).rejects.toBeInstanceOf(ApiContractError);
      expect(mock.requests).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

test("a security event detail is read by its own ID", async () => {
  const mock = installFetch(() => Response.json(event(1)));
  try {
    await expect(getAccessSecurityEvent(event(1).id)).resolves.toEqual(
      event(1),
    );
    expect(String(mock.requests[0]?.input)).toBe(
      `/api/security-events/${event(1).id}`,
    );
  } finally {
    mock.restore();
  }
});

// Moved from the http journey "Events detail identity mismatch cannot show
// another event's facts" with the same input: the detail of the "Sign-in
// failure" row (event 1) answered with event 2.
test("a security event detail for another ID is refused", async () => {
  const mock = installFetch(() => Response.json(event(2)));
  try {
    await expect(getAccessSecurityEvent(event(1).id)).rejects.toBeInstanceOf(
      ApiContractError,
    );
    expect(mock.requests).toHaveLength(1);
  } finally {
    mock.restore();
  }
});
