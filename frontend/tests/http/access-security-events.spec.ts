import { authMeBody, expect, test, type Page } from "./helpers/test";
import { person } from "./helpers/access-api";
import { profilePreferences } from "./helpers/profile-api";
import { deferredMfaResponse, mfaUserA, mfaUserB } from "./helpers/mfa";
import {
  eventOperationId,
  historicalPersonId,
  matchingPageEvents,
  mockSecurityEvents as mockAccessSecurityEvents,
  securityEvent,
  unsafeEventCanary,
} from "./helpers/security-events";

test.use({ trace: "off", screenshot: "off", video: "off" });

function feed(page: Page) {
  return page.getByRole("region", { name: "Security events", exact: true });
}
function eventRows(page: Page) {
  return feed(page).getByRole("list", { name: "Security events", exact: true });
}
async function openFeed(page: Page) {
  await page.goto("/manage?view=audit&audit=security-events");
  await expect(feed(page)).toBeVisible();
  await expect(eventRows(page).getByText(/sign-in was accepted/)).toBeVisible();
}
async function filters(page: Page) {
  await feed(page)
    .getByRole("button", { name: "More filters", exact: true })
    .click();
  return feed(page).getByRole("region", {
    name: "Search security events filters",
    exact: true,
  });
}
async function details(page: Page, event: string) {
  await feed(page)
    .getByRole("button", { name: new RegExp(`^Details for ${event}`) })
    .first()
    .click();
  return page.getByRole("dialog", {
    name: "Security event details",
    exact: true,
  });
}

test("Events person picker uses server search and keeps its selected label outside results", async ({
  page,
}) => {
  const state = await mockSecurityEvents(page);
  const remoteId = "00000000-0000-4000-8000-000000000998";
  state.directory.push(
    person({
      id: remoteId,
      email: "lookup-target@example.invalid",
      username: "lookup-target",
      display_name: "Server-selected person",
    }),
  );
  await openFeed(page);
  const controls = await filters(page);
  const picker = controls.getByLabel("Person", { exact: true });
  await picker.click();
  await page
    .getByRole("dialog")
    .getByRole("combobox", { name: "Search person", exact: true })
    .fill("lookup-target");
  await expect
    .poll(() => state.userQueries.at(-1)?.get("search"))
    .toBe("lookup-target");
  await page
    .getByRole("option", { name: "Server-selected person", exact: true })
    .click();
  await expect(picker).toHaveText("Server-selected person");
  await picker.click();
  await page
    .getByRole("dialog")
    .getByRole("combobox", { name: "Search person", exact: true })
    .fill("mara");
  await expect(
    page.getByRole("option", { name: "Mara", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveText("Server-selected person");
  expect(state.commands).toEqual([]);
  expect(
    state.userQueries.some((query) => Number(query.get("offset") ?? 0) > 0),
  ).toBe(false);
});

test("Events mixed nullable feed and details explain representative and partial outcomes without raw metadata", async ({
  page,
}) => {
  const state = await mockSecurityEvents(page);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await openFeed(page);
  // Times are workspace-local (Asia/Manila); UTC stays out of visible text.
  await expect(feed(page)).not.toContainText("UTC");
  await expect(feed(page)).toContainText(
    "Failed sign-in attempts were recorded",
  );
  await expect(feed(page)).toContainText("unknown address");
  await expect(feed(page)).toContainText("Other security event");
  await expect(feed(page)).not.toContainText("internal.controlled_check");
  await expect(feed(page)).not.toContainText(unsafeEventCanary);
  await expect(feed(page)).not.toContainText("unshown-person@example.invalid");
  let dialog = await details(page, "Sign-in failure");
  await expect(dialog).toContainText(
    "Sign-in failures from this address during this hour",
  );
  await expect(dialog).toContainText("198.51.100.42");
  await expect(dialog).toContainText(/7:00\sPM/);
  await expect(dialog).toContainText(/8:00\sPM/);
  await expect(dialog).toContainText(
    "Repeated attempts are grouped. The time shows the first one.",
  );
  await expect(dialog).toContainText("No person recorded");
  await expect(dialog).not.toContainText(unsafeEventCanary);
  await expect(dialog).not.toContainText(/last seen|attempt count/i);
  await page.keyboard.press("Escape");
  dialog = await details(page, "Password change");
  await expect(dialog).toContainText("Partial");
  await expect(dialog).toContainText("This change may be only partly saved");
  await expect(dialog).toContainText(eventOperationId);
  await expect(dialog).not.toContainText(/producer|revision/i);
  await expect(dialog).not.toContainText(unsafeEventCanary);
  expect(state.commands).toEqual([]);
  expect(state.security.writes).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("security event personal display preserves UTC diagnostics and workspace filter bounds", async ({
  page,
}) => {
  const state = await mockSecurityEvents(page);
  state.events = [securityEvent(0, { occurred_at: "2026-10-01T00:30:00Z" })];
  await page.route(`**/api/users/${mfaUserA}/preferences`, (route) =>
    route.fulfill({
      json: profilePreferences(mfaUserA, {
        timezone: "America/Los_Angeles",
        date_format: "ymd",
        time_format: "24h",
      }),
    }),
  );
  await openFeed(page);
  await expect(eventRows(page)).toContainText("2026-09-30");
  await expect(eventRows(page)).toContainText("17:30");
  const machineTime = eventRows(page).locator(
    'time[datetime="2026-10-01T00:30:00Z"]',
  );
  await expect(machineTime).toHaveAttribute("title", /12:30.*UTC$/);
  const dialog = await details(page, "Sign-in accepted");
  await expect(dialog).toContainText("2026-09-30");
  await expect(dialog).toContainText("17:30");
  await page.keyboard.press("Escape");
  const controls = await filters(page);
  await controls.getByLabel("From", { exact: true }).fill("2026-10-01");
  await controls.getByLabel("Through", { exact: true }).fill("2026-10-01");
  await expect
    .poll(() => Object.fromEntries(state.reads.at(-1) ?? []))
    .toMatchObject({
      occurred_after: "2026-09-30T16:00:00Z",
      occurred_before: "2026-10-01T16:00:00Z",
      offset: "0",
    });
  await expect(eventRows(page)).toContainText("sign-in was accepted");
  await expect(machineTime).toHaveAttribute("datetime", "2026-10-01T00:30:00Z");
  expect(state.commands).toEqual([]);
  expect(state.security.writes).toEqual([]);
});

test("Events filters serialize workspace-local day bounds and person values before server paging and reset offset", async ({
  page,
}) => {
  const state = await mockSecurityEvents(page);
  state.events = matchingPageEvents();
  await page.goto("/manage?view=audit&audit=security-events");
  await expect(eventRows(page)).toBeVisible();
  const controls = await filters(page);
  await controls
    .getByLabel("Event type", { exact: true })
    .selectOption("identity.sign_in");
  await controls.getByLabel("Outcome", { exact: true }).selectOption("success");
  await controls.getByLabel("Person", { exact: true }).click();
  await page.getByRole("option", { name: "Mara", exact: true }).click();
  await controls.getByLabel("From", { exact: true }).fill("2026-10-06");
  await controls.getByLabel("Through", { exact: true }).fill("2026-10-06");
  await expect
    .poll(() => Object.fromEntries(state.reads.at(-1) ?? []))
    .toMatchObject({
      event_type: "identity.sign_in",
      outcome: "success",
      person_id: mfaUserA,
      // One Asia/Manila (UTC+8) calendar day.
      occurred_after: "2026-10-05T16:00:00Z",
      occurred_before: "2026-10-06T16:00:00Z",
      offset: "0",
    });
  await expect(feed(page)).toContainText("25 events");
  await feed(page)
    .getByRole("navigation", { name: "Security event pages", exact: true })
    .getByRole("button", { name: "Go to next page", exact: true })
    .click();
  await expect
    .poll(() => Number(state.reads.at(-1)?.get("offset")))
    .toBeGreaterThan(0);
  await feed(page)
    .getByLabel("Sort security events", { exact: true })
    .selectOption("oldest");
  await expect
    .poll(() => Object.fromEntries(state.reads.at(-1) ?? []))
    .toMatchObject({ offset: "0", sort_by: "occurred_at", sort_order: "asc" });
  await feed(page)
    .getByRole("searchbox", { name: "Search security events", exact: true })
    .fill("identity");
  await expect.poll(() => state.reads.at(-1)?.get("search")).toBe("identity");
  await feed(page)
    .getByRole("button", { name: "Clear event filters", exact: true })
    .click();
  await expect(
    feed(page).getByRole("searchbox", {
      name: "Search security events",
      exact: true,
    }),
  ).toHaveValue("");
  await feed(page)
    .getByRole("button", { name: "Refresh security events", exact: true })
    .click();
  await expect
    .poll(() => Object.fromEntries(state.reads.at(-1) ?? []))
    .toMatchObject({ search: "", offset: "0" });
  for (const key of [
    "event_type",
    "outcome",
    "person_id",
    "occurred_after",
    "occurred_before",
  ])
    expect(state.reads.at(-1)?.has(key)).toBe(false);
  expect(state.commands).toEqual([]);
});

test("Events unknown exact type and historical person UUID work independently of directory availability", async ({
  page,
}) => {
  const state = await mockSecurityEvents(page);
  state.usersStatus = 503;
  await openFeed(page);
  const controls = await filters(page);
  await controls.getByLabel("Person", { exact: true }).click();
  const directoryError = controls
    .getByRole("alert")
    .filter({ hasText: "person list could not load" });
  await expect(directoryError).toBeVisible();
  await expect(directoryError).toHaveAttribute("data-variant", "destructive");
  await expect(eventRows(page).getByText(/sign-in was accepted/)).toBeVisible();
  await page.keyboard.press("Escape");
  await controls
    .getByLabel("Event type", { exact: true })
    .selectOption("other");
  await controls
    .getByLabel("Exact event type", { exact: true })
    .fill("internal.controlled_check");
  await controls
    .getByRole("button", { name: "Enter a person ID", exact: true })
    .click();
  await controls
    .getByLabel("Person ID", { exact: true })
    .fill(historicalPersonId);
  await expect
    .poll(() => Object.fromEntries(state.reads.at(-1) ?? []))
    .toMatchObject({
      event_type: "internal.controlled_check",
      person_id: historicalPersonId,
    });
  await expect(feed(page)).toContainText("Other security event");
  const dialog = await details(page, "Other security event");
  await expect(dialog).toContainText(historicalPersonId);
  await expect(dialog).toContainText("Unknown person");
  await expect(dialog).not.toContainText(
    /deleted person|unshown-person@example.invalid/i,
  );
});

test("Events prototype-like unknown strings remain plain facts and unknown metadata names are omitted", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource:")
    )
      consoleErrors.push(message.text());
  });
  const state = await mockSecurityEvents(page);
  state.events.push(
    securityEvent(6, {
      event_type: "__proto__",
      reason: "constructor",
      metadata: { ip_address: null, stage: "constructor" },
    }),
    securityEvent(7, {
      event_type: "workspace.security_policy_change",
      metadata: {
        changed_fields: [
          "constructor",
          "session_timeout_minutes",
          "session_retention_days",
          "security_event_retention_days",
        ],
        revision: 2,
      },
    }),
  );
  await openFeed(page);
  await expect(
    eventRows(page).getByText("Other security event", { exact: true }),
  ).toHaveCount(2);
  await expect(eventRows(page)).not.toContainText("__proto__");
  // The oldest unknown row is the prototype-like event.
  await feed(page)
    .getByRole("button", { name: /^Details for Other security event/ })
    .last()
    .click();
  const unknown = page.getByRole("dialog", {
    name: "Security event details",
    exact: true,
  });
  await expect(
    unknown.getByText("Other security event", { exact: true }),
  ).toBeVisible();
  await expect(unknown).not.toContainText("__proto__");
  await expect(unknown.getByText("Stage", { exact: true })).toHaveCount(0);
  await expect(unknown.getByText("Reason", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  const policy = await details(page, "Account policy change");
  await expect(
    policy.getByText("Session timeout", { exact: true }),
  ).toBeVisible();
  await expect(
    policy.getByText("Session retention", { exact: true }),
  ).toBeVisible();
  await expect(
    policy.getByText("Security event retention", { exact: true }),
  ).toBeVisible();
  await expect(policy.getByText("constructor", { exact: true })).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
});

test("Events detail actor and subject filters use the recorded UUID and include actor-or-subject matches", async ({
  page,
}) => {
  const state = await mockSecurityEvents(page);
  state.events = [
    securityEvent(0, { actor_id: mfaUserA, subject_id: historicalPersonId }),
    securityEvent(1, {
      event_type: "internal.actor_only",
      actor_id: historicalPersonId,
      subject_id: null,
    }),
    securityEvent(2, {
      event_type: "internal.subject_only",
      actor_id: null,
      subject_id: historicalPersonId,
    }),
    securityEvent(3),
  ];
  await page.goto("/manage?view=audit&audit=security-events");
  await expect(feed(page)).toContainText("4 events");
  let dialog = await details(page, "Sign-in accepted");
  await expect(
    dialog.getByRole("button", { name: "Filter by who did it", exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Filter by who did it", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => state.reads.at(-1)?.get("person_id")).toBe(mfaUserA);
  await expect(feed(page)).toContainText("2 events");
  // Both matches are the actor's sign-ins; the historical-only rows are gone.
  await expect(eventRows(page)).not.toContainText("Other security event");
  await feed(page)
    .getByRole("button", { name: "Clear event filters", exact: true })
    .click();
  await expect(feed(page)).toContainText("4 events");
  dialog = await details(page, "Sign-in accepted");
  await dialog
    .getByRole("button", { name: "Filter by who it affects", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(() => state.reads.at(-1)?.get("person_id"))
    .toBe(historicalPersonId);
  await expect(feed(page)).toContainText("3 events");
  await expect(
    eventRows(page).getByText("Other security event", { exact: true }),
  ).toHaveCount(2);
  expect(state.commands).toEqual([]);
  expect(state.security.writes).toEqual([]);
});

for (const outcome of ["attempt", "partial"] as const) {
  test(`Events recovery completion ${outcome} never claims the operation completed`, async ({
    page,
  }) => {
    const state = await mockSecurityEvents(page);
    state.events = [
      securityEvent(0, {
        event_type: "identity.recovery_complete",
        outcome,
        metadata: { stage: "provider_update" },
      }),
    ];
    await page.goto("/manage?view=audit&audit=security-events");
    await expect(eventRows(page).getByText(/password recovery/i)).toBeVisible();
    await expect(eventRows(page)).not.toContainText(
      /completed password recovery/i,
    );
    const dialog = await details(page, "Recovery completion");
    await expect(dialog).toContainText(
      outcome === "attempt"
        ? "does not confirm completion"
        : "This change may be only partly saved",
    );
    expect(state.commands).toEqual([]);
  });
}

test("Events invalid UUID and reversed day range remain local with linked errors and no wrong-filter request", async ({
  page,
}) => {
  const state = await mockSecurityEvents(page);
  await openFeed(page);
  const controls = await filters(page);
  await controls
    .getByRole("button", { name: "Enter a person ID", exact: true })
    .click();
  await controls
    .getByLabel("Person ID", { exact: true })
    .fill("not-a-person-id");
  await expect(
    controls.getByLabel("Person ID", { exact: true }),
  ).toHaveAttribute("aria-invalid", "true");
  await expect(controls).toContainText("Enter a valid person ID");
  expect(
    state.reads.some((query) => query.get("person_id") === "not-a-person-id"),
  ).toBe(false);
  await controls.getByLabel("Person ID", { exact: true }).fill("");
  await controls.getByLabel("From", { exact: true }).fill("2026-10-07");
  await controls.getByLabel("Through", { exact: true }).fill("2026-10-06");
  await expect(controls).toContainText("Through must be on or after From");
  expect(
    state.reads.some(
      (query) =>
        query.get("occurred_after") === "2026-10-06T16:00:00Z" &&
        query.get("occurred_before") === "2026-10-06T16:00:00Z",
    ),
  ).toBe(false);
  expect(state.commands).toEqual([]);
});

test("Events same-key failed Refresh keeps rows and explicit Retry recovers without exposing backend text", async ({
  page,
}) => {
  const state = await mockSecurityEvents(page);
  await openFeed(page);
  state.listStatus = 503;
  await feed(page)
    .getByRole("button", { name: "Refresh security events", exact: true })
    .click();
  await expect(feed(page).getByRole("alert")).toContainText(
    "could not be refreshed",
  );
  await expect(eventRows(page).getByText(/sign-in was accepted/)).toBeVisible();
  await expect(feed(page)).not.toContainText(unsafeEventCanary);
  state.listStatus = 200;
  await feed(page)
    .getByRole("button", { name: "Retry security events", exact: true })
    .click();
  await expect(feed(page).getByRole("alert")).toHaveCount(0);
  await expect(eventRows(page).getByText(/sign-in was accepted/)).toBeVisible();
});

test("Events changed filter loads cold rather than showing old-key rows and distinguishes filtered and unfiltered empty", async ({
  page,
}) => {
  const state = await mockSecurityEvents(page);
  await openFeed(page);
  const held = deferredMfaResponse();
  state.holdList = held;
  try {
    await feed(page)
      .getByRole("searchbox", { name: "Search security events", exact: true })
      .fill("no-controlled-matches");
    await held.begun;
    await expect(eventRows(page).getByText(/sign-in was accepted/)).toHaveCount(
      0,
    );
    await expect(
      feed(page).getByText("Loading security events…", { exact: true }),
    ).toBeVisible();
    held.release();
    await expect(feed(page)).toContainText(
      "No security events match these filters",
    );
    state.events = [];
    await feed(page)
      .getByRole("button", { name: "Clear event filters", exact: true })
      .click();
    await feed(page)
      .getByRole("button", { name: "Refresh security events", exact: true })
      .click();
    await expect(feed(page)).toContainText("No security events recorded");
  } finally {
    held.release();
  }
});

test("Events cold unavailable and detail failure offer explicit recovery with no invented facts", async ({
  page,
}) => {
  const state = await mockSecurityEvents(page);
  state.listStatus = 503;
  await page.goto("/manage?view=audit&audit=security-events");
  await expect(feed(page).getByRole("alert")).toContainText(
    "could not be loaded",
  );
  await expect(eventRows(page).getByText(/sign-in was accepted/)).toHaveCount(
    0,
  );
  state.listStatus = 200;
  await feed(page)
    .getByRole("button", { name: "Retry security events", exact: true })
    .click();
  await expect(eventRows(page).getByText(/sign-in was accepted/)).toBeVisible();
  state.detailStatus = 503;
  const dialog = await details(page, "Sign-in failure");
  await expect(dialog.getByRole("alert")).toContainText(
    "Details could not be loaded",
  );
  await expect(dialog).not.toContainText("198.51.100.42");
  await expect(dialog).not.toContainText(unsafeEventCanary);
  state.detailStatus = 200;
  await dialog
    .getByRole("button", { name: "Retry event details", exact: true })
    .click();
  await expect(dialog).toContainText("198.51.100.42");
});

// The other unsupported facts (naive times, non-UUID people, unknown fields)
// are isolated rows in isolated/access/security-events-api.spec.ts.
test("Events malformed invalid outcome response is unavailable rather than trusted", async ({
  page,
}) => {
  const state = await mockSecurityEvents(page);
  state.malformedList = {
    items: [{ ...securityEvent(0), outcome: "unknown" }],
    pagination: { limit: 10, offset: 0, count: 1, total: 1, has_more: false },
  };
  await page.goto("/manage?view=audit&audit=security-events");
  await expect(feed(page).getByRole("alert")).toContainText(
    "could not be loaded",
  );
  await expect(eventRows(page).getByText(/sign-in was accepted/)).toHaveCount(
    0,
  );
  state.malformedList = null;
  await feed(page)
    .getByRole("button", { name: "Retry security events", exact: true })
    .click();
  await expect(eventRows(page).getByText(/sign-in was accepted/)).toBeVisible();
});

test("Events detail identity mismatch cannot show another event's facts", async ({
  page,
}) => {
  await mockSecurityEvents(page);
  await openFeed(page);
  let malformedDetail = true;
  await page.route(`**/api/security-events/${securityEvent(1).id}`, (route) =>
    malformedDetail
      ? route.fulfill({
          headers: { "Cache-Control": "no-store" },
          json: securityEvent(2),
        })
      : route.fallback(),
  );
  const dialog = await details(page, "Sign-in failure");
  await expect(dialog.getByRole("alert")).toContainText(
    "Details could not be loaded",
  );
  await expect(dialog).not.toContainText("198.51.100.42");
  malformedDetail = false;
  await dialog
    .getByRole("button", { name: "Retry event details", exact: true })
    .click();
  await expect(dialog).toContainText(
    "Sign-in failures from this address during this hour",
  );
});

for (const role of ["member", "guest", "manager"] as const) {
  test(`Events ${role} never reads the privileged feed or details`, async ({
    page,
  }) => {
    const state = await mockSecurityEvents(page);
    state.role = role === "guest" ? "guest" : "member";
    state.manager = role === "manager";
    await page.goto("/manage?view=audit&audit=security-events");
    await expect(
      page.getByRole("heading", {
        name: "Audit",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("tab", { name: "Security events", exact: true }),
    ).toHaveCount(0);
    await expect(feed(page)).toHaveCount(0);
    expect(state.userReads).toBe(0);
    expect(state.reads).toEqual([]);
    expect(state.details).toEqual([]);
  });
}

test("Access security links to Audit through the existing draft guard", async ({
  page,
}) => {
  const state = await mockSecurityEvents(page);
  await page.goto("/access?view=security");
  await expect(
    page.getByRole("button", { name: "End session for Eli", exact: true }),
  ).toBeEnabled();
  await expect(feed(page)).toHaveCount(0);
  expect(state.reads).toEqual([]);
  const link = page.getByRole("link", {
    name: "View security events in Audit",
    exact: true,
  });
  await expect(link).toHaveAttribute(
    "href",
    "/manage?view=audit&audit=security-events",
  );
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  const policy = page.getByRole("dialog", {
    name: "Account policy",
    exact: true,
  });
  await policy
    .getByLabel("Session timeout", { exact: true })
    .selectOption("30 minutes");
  await policy
    .getByRole("button", { name: "Close account policy", exact: true })
    .click();
  await link.click();
  const leave = page.getByRole("alertdialog", {
    name: "Discard unsaved changes?",
    exact: true,
  });
  await expect(leave).toBeVisible();
  await leave
    .getByRole("button", { name: "Keep editing", exact: true })
    .click();
  await expect(page).toHaveURL(/\/access\?view=security$/);
  await page.getByRole("button", { name: "Edit policy", exact: true }).click();
  await expect(
    policy.getByLabel("Session timeout", { exact: true }),
  ).toHaveValue("30 minutes");
  await policy
    .getByRole("button", { name: "Close account policy", exact: true })
    .click();
  await link.click();
  await leave
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(feed(page)).toBeVisible();
  await expect(eventRows(page)).toContainText("sign-in was accepted");
  expect(state.commands).toEqual([]);
  expect(state.security.writes).toEqual([]);
});

for (const status of [401, 403]) {
  test(`Events fresh ${status} refusal conceals cached privileged reads across Audit and Access before explicit recovery`, async ({
    page,
  }) => {
    const state = await mockSecurityEvents(page);
    await page.goto("/access?view=security");
    await expect(
      page.getByRole("table", { name: "Sessions", exact: true }),
    ).toBeVisible();
    await visitAuditSecurity(page);
    const native = deferredMfaResponse();
    const repeatedNative = deferredMfaResponse();
    state.auth.holdSession = native;
    state.listStatus = status;
    const reads = state.sessionReads;
    try {
      await feed(page)
        .getByRole("button", { name: "Refresh security events", exact: true })
        .click();
      await native.begun;
      await expect(eventRows(page)).toHaveCount(0);
      native.release();
      await expect.poll(() => state.sessionReads).toBeGreaterThan(reads);
      await expect(feed(page).getByRole("alert")).toContainText(
        "Only administrators",
      );
      state.listStatus = 200;
      await feed(page)
        .getByRole("button", { name: "Retry security events", exact: true })
        .click();
      await expect(eventRows(page)).toContainText("sign-in was accepted");
      await visitAccessSecurity(page);
      await expect(
        page.getByRole("table", { name: "Sessions", exact: true }),
      ).toHaveCount(0);
      await page
        .getByRole("button", { name: "Edit policy", exact: true })
        .click();
      const policy = page.getByRole("dialog", {
        name: "Account policy",
        exact: true,
      });
      await policy
        .getByRole("button", { name: "Retry account policy", exact: true })
        .click();
      await expect(
        policy.getByLabel("Session timeout", { exact: true }),
      ).toBeVisible();
      await policy
        .getByRole("button", { name: "Close account policy", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Retry sessions", exact: true })
        .click();
      await expect(
        page.getByRole("table", { name: "Sessions", exact: true }),
      ).toBeVisible();
      await visitAuditSecurity(page);
      const recoveredReads = state.sessionReads;
      state.auth.holdSession = repeatedNative;
      state.detailStatus = status;
      await details(page, "Sign-in failure");
      await repeatedNative.begun;
      await expect(
        page.getByRole("dialog", {
          name: "Security event details",
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(eventRows(page)).toHaveCount(0);
      repeatedNative.release();
      await expect
        .poll(() => state.sessionReads)
        .toBeGreaterThan(recoveredReads);
      await expect(feed(page).getByRole("alert")).toContainText(
        "Only administrators",
      );
      state.detailStatus = 200;
      await feed(page)
        .getByRole("button", { name: "Retry security events", exact: true })
        .click();
      await expect(eventRows(page)).toContainText("sign-in was accepted");
      expect(state.commands).toEqual([]);
      expect(state.security.writes).toEqual([]);
    } finally {
      native.release();
      repeatedNative.release();
    }
  });
}

test("Events an older held Retry cannot clear a newer policy refusal across route changes", async ({
  page,
}) => {
  const state = await mockSecurityEvents(page);
  await openFeed(page);
  state.listStatus = 403;
  await feed(page)
    .getByRole("button", { name: "Refresh security events", exact: true })
    .click();
  await expect(feed(page).getByRole("alert")).toContainText(
    "Only administrators",
  );
  const held = deferredMfaResponse();
  state.holdList = held;
  state.listStatus = 200;
  try {
    await feed(page)
      .getByRole("button", { name: "Retry security events", exact: true })
      .click();
    await held.begun;
    state.security.policyReadStatus = 403;
    await visitAccessSecurity(page);
    await page
      .getByRole("button", { name: "Edit policy", exact: true })
      .click();
    const policy = page.getByRole("dialog", {
      name: "Account policy",
      exact: true,
    });
    const retryPolicy = policy.getByRole("button", {
      name: "Retry account policy",
      exact: true,
    });
    await retryPolicy.click();
    await expect(
      policy.getByText(
        "Account policy could not be loaded. Retry before saving.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(retryPolicy).toBeEnabled();
    await policy
      .getByRole("button", { name: "Close account policy", exact: true })
      .click();
    await visitAuditSecurity(page);
    held.release();
    await expect(feed(page).getByRole("alert")).toContainText(
      "Only administrators",
    );
    await expect(eventRows(page)).toHaveCount(0);
    await feed(page)
      .getByRole("button", { name: "Retry security events", exact: true })
      .click();
    await expect(eventRows(page)).toContainText("sign-in was accepted");
    await visitAccessSecurity(page);
    await expect(
      page.getByRole("table", { name: "Sessions", exact: true }),
    ).toHaveCount(0);
  } finally {
    held.release();
  }
});

test("Events a policy refusal conceals a cached feed on revisit until its own fresh Retry", async ({
  page,
}) => {
  await page.clock.install();
  const state = await mockSecurityEvents(page);
  await openFeed(page);
  await visitAccessSecurity(page);
  await expect(page.getByText(/60-minute timeout$/)).toBeVisible();
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Access overview", exact: true }),
  ).toBeVisible();
  await expect(feed(page)).toHaveCount(0);
  await page.clock.fastForward(31_000);
  state.security.policyReadStatus = 403;
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Security", exact: true })
    .click();
  await expect(
    page.getByText("Account policy unavailable", { exact: true }),
  ).toBeVisible();
  await visitAuditSecurity(page);
  await expect(eventRows(page).getByText(/sign-in was accepted/)).toHaveCount(
    0,
  );
  await expect(feed(page).getByRole("alert")).toContainText(
    "Only administrators",
  );
  await feed(page)
    .getByRole("button", { name: "Retry security events", exact: true })
    .click();
  await expect(eventRows(page).getByText(/sign-in was accepted/)).toBeVisible();
});

test("Events curtain clears held detail and resumes only after fresh same-account role admission", async ({
  page,
}) => {
  const state = await mockSecurityEvents(page);
  await openFeed(page);
  const detail = deferredMfaResponse();
  const native = deferredMfaResponse();
  state.holdDetail = detail;
  state.auth.holdSession = native;
  try {
    const event = await details(page, "Sign-in failure");
    await detail.begun;
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await native.begun;
    await expect(eventRows(page)).toHaveCount(0);
    await expect(event).toHaveCount(0);
    detail.release();
    native.release();
    await expect(feed(page)).toBeVisible();
    await expect(event).toHaveCount(0);
    expect(state.commands).toEqual([]);
    expect(state.security.writes).toEqual([]);
  } finally {
    detail.release();
    native.release();
  }
});

test("Events late prior-account list cannot populate the next account's feed", async ({
  page,
}) => {
  const state = await mockSecurityEvents(page);
  await openFeed(page);
  const old = deferredMfaResponse();
  state.holdList = old;
  try {
    await feed(page)
      .getByRole("button", { name: "Refresh security events", exact: true })
      .click();
    await old.begun;
    state.auth.userId = mfaUserB;
    state.events = [
      securityEvent(7, {
        event_type: "identity.recovery_complete",
        actor_id: mfaUserB,
        subject_id: mfaUserB,
      }),
    ];
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(feed(page)).toContainText("completed password recovery");
    old.release();
    await expect(eventRows(page)).not.toContainText("sign-in was accepted");
    await expect(eventRows(page)).not.toContainText("Failed sign-in attempts");
    expect(state.security.writes).toEqual([]);
    expect(state.commands).toEqual([]);
  } finally {
    old.release();
  }
});

test("Events desktop keyboard Escape returns focus to the invoking detail row at 125 percent Spacious", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = await mockSecurityEvents(page);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource:")
    )
      consoleErrors.push(message.text());
  });
  await openFeed(page);
  await page.evaluate(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.dataset.textSize = "125";
    document.documentElement.dataset.density = "spacious";
  });
  await expect(eventRows(page)).toBeVisible();
  const opener = feed(page)
    .getByRole("button", { name: /^Details for Sign-in failure/ })
    .first();
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: "Security event details",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    "Sign-in failures from this address during this hour",
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(state.commands).toEqual([]);
  expect(state.security.writes).toEqual([]);
});

// Light and dark share this layout; the color theme changes no reflow branch.
test("Events compact keyboard details and date filters remain reachable at 125 percent reflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockSecurityEvents(page);
  await openFeed(page);
  await page.evaluate(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.dataset.textSize = "125";
    document.documentElement.dataset.density = "spacious";
  });
  const more = feed(page).getByRole("button", {
    name: "More filters",
    exact: true,
  });
  await more.focus();
  await page.keyboard.press("Enter");
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(feed(page).getByLabel("From", { exact: true })).toBeVisible();
  const opener = feed(page)
    .getByRole("button", { name: /^Details for Sign-in failure/ })
    .first();
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: "Security event details",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const targets = [
    more,
    opener,
    feed(page).getByRole("button", {
      name: "Refresh security events",
      exact: true,
    }),
  ];
  for (const target of targets) {
    const box = await target.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
});

test("Events names offpage actors with bounded ID lookup without eager pages", async ({
  page,
}) => {
  const state = await mockSecurityEvents(page);
  for (let index = 0; index < 110; index += 1) {
    const id = `00000000-0000-4000-8000-${String(700 + index).padStart(12, "0")}`;
    state.directory.push(
      person({ id, username: `later${String(index).padStart(3, "0")}` }),
    );
  }
  const late = "00000000-0000-4000-8000-000000000999";
  state.directory.push(
    person({
      id: late,
      username: "zzz_event_person",
      display_name: "Zzz Event Person",
    }),
  );
  state.events = [
    securityEvent(30, {
      actor_id: late,
      subject_id: null,
      occurred_at: "2026-10-06T12:30:00Z",
    }),
  ];
  await openFeed(page);
  await expect(eventRows(page)).toContainText("Zzz Event Person");
  expect(
    state.userQueries.some((query) => query.getAll("ids").includes(late)),
  ).toBe(true);
  await expect(feed(page)).toContainText("1 event");
  expect(state.userQueries.every((query) => query.get("offset") === "0")).toBe(
    true,
  );
  expect(state.commands).toEqual([]);
});

async function mockAuditHistory(page: Page) {
  await page.route(/\/api\/audit-logs(?:\?|$)/, (route) => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({
      json: {
        items: [],
        pagination: {
          limit: Number(params.get("limit") ?? 20),
          offset: Number(params.get("offset") ?? 0),
          count: 0,
          total: 0,
          has_more: false,
        },
      },
    });
  });
  await page.route("**/api/audit-logs/options**", (route) =>
    route.fulfill({ json: { entity_types: [], actors: [] } }),
  );
}

test("Audit exposes Security events only to verified administrators", async ({
  page,
}) => {
  const state = await mockSecurityEvents(page);
  await mockAuditHistory(page);
  await page.goto("/manage?view=audit");
  await expect(
    page.getByRole("heading", { name: "Audit", exact: true }),
  ).toBeVisible();
  const securityTab = page.getByRole("tab", {
    name: "Security events",
    exact: true,
  });
  await expect(securityTab).toBeVisible();
  expect(state.reads).toEqual([]);
  await securityTab.click();
  await expect(page).toHaveURL(/\/manage\?view=audit&audit=security-events$/);
  await expect(feed(page)).toBeVisible();
  await expect(eventRows(page)).toContainText("sign-in was accepted");
  await page
    .getByRole("tab", { name: "Activity history", exact: true })
    .click();
  await expect(feed(page)).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Export audit preview", exact: true }),
  ).toBeVisible();
  expect(state.commands).toEqual([]);
  expect(state.security.writes).toEqual([]);
});

test("Audit awaits a current-account role and refuses failed or mismatched identity", async ({
  page,
}) => {
  const state = await mockSecurityEvents(page);
  await mockAuditHistory(page);
  const role = deferredMfaResponse();
  let response: {
    id: string;
    role: string;
    access: unknown[];
    default_organization_blocked: null;
  } = {
    id: mfaUserA,
    default_organization_blocked: null,
    role: "admin",
    access: [],
  };
  let status = 200;
  let hold = true;
  await page.route("**/api/auth/me", async (route) => {
    if (hold) {
      role.start();
      await role.waiting;
    }
    await route.fulfill({
      status,
      json:
        status === 200
          ? authMeBody(response)
          : { detail: "Controlled unavailable" },
    });
  });
  try {
    await page.goto("/manage?view=audit&audit=security-events");
    await role.begun;
    await expect(
      page.getByRole("tab", { name: "Security events", exact: true }),
    ).toHaveCount(0);
    expect(state.reads).toEqual([]);
    hold = false;
    role.release();
    await expect(feed(page)).toBeVisible();
    response = {
      id: mfaUserB,
      role: "admin",
      access: [],
      default_organization_blocked: null,
    };
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Audit", exact: true }),
    ).toBeVisible();
    await expect(feed(page)).toHaveCount(0);
    const priorReads = state.reads.length;
    status = 503;
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Audit", exact: true }),
    ).toBeVisible();
    await expect(feed(page)).toHaveCount(0);
    expect(state.reads).toHaveLength(priorReads);
  } finally {
    role.release();
  }
});

async function mockSecurityEvents(page: Page) {
  await mockAuditHistory(page);
  return mockAccessSecurityEvents(page);
}

async function visitAccessSecurity(page: Page) {
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  const access = navigation.getByRole("button", {
    name: "Access",
    exact: true,
  });
  if ((await access.getAttribute("aria-expanded")) !== "true")
    await access.click();
  await expect(access).toHaveAttribute("aria-expanded", "true");
  await navigation.getByRole("link", { name: "Security", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Security", exact: true }),
  ).toBeVisible();
}

async function visitAuditSecurity(page: Page) {
  await page
    .getByRole("link", { name: "View security events in Audit", exact: true })
    .click();
  await expect(feed(page)).toBeVisible();
}

const shownEventCases: {
  type: string;
  patch?: Parameters<typeof securityEvent>[1];
}[] = [
  {
    type: "identity.sign_in",
  },
  {
    type: "identity.sign_in_failure",
    patch: { outcome: "failure", actor_id: null, subject_id: null },
  },
  {
    type: "identity.mfa.enrolled",
  },
  {
    type: "security.retention",
    patch: {
      actor_id: null,
      subject_id: null,
      metadata: {
        scope: "identity_sessions",
        deleted_sessions: 4,
        retention_days: 30,
      },
    },
  },
  {
    type: "records.export.authorized",
    patch: {
      subject_id: eventOperationId,
      metadata: { format: "xlsx", row_count: 120, column_count: 3 },
    },
  },
  {
    type: "records.aggregate_snapshots.authorized",
    patch: {
      subject_id: null,
      metadata: {
        query_count: 2,
        bucket_count: 7,
        module_ids: [eventOperationId, historicalPersonId],
      },
    },
  },
  {
    type: "job.retry",
    patch: {
      subject_id: eventOperationId,
      metadata: { kind: "backup", result_id: historicalPersonId },
    },
  },
];

test("emitted event sentences use recorded facts without claiming unfinished work", async ({
  page,
}) => {
  const state = await mockSecurityEvents(page);
  state.directory.push(
    person({ id: mfaUserB, username: "jay", display_name: "Jay" }),
  );
  state.events = [
    securityEvent(100, {
      event_type: "identity.session_revocation",
      subject_id: mfaUserB,
      labels: { scope: "others" },
      occurred_at: "2026-10-06T12:00:00Z",
      metadata: {
        ip_address: "198.51.100.42",
        internal_note: unsafeEventCanary,
      },
    }),
    securityEvent(101, {
      event_type: "internal.controlled_check",
      occurred_at: "2026-10-06T11:00:00Z",
    }),
  ];
  await page.goto("/manage?view=audit&audit=security-events");
  const controls = await filters(page);
  await controls
    .getByLabel("Event type", { exact: true })
    .selectOption("identity.session_revocation");
  await expect(
    eventRows(page).getByText("Mara ended Jay's other sessions.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(eventRows(page)).not.toContainText("Other security event");
  await expect(eventRows(page)).not.toContainText(unsafeEventCanary);
  await expect
    .poll(() => state.reads.at(-1)?.get("event_type"))
    .toBe("identity.session_revocation");
  expect(state.commands).toEqual([]);
  expect(state.security.writes).toEqual([]);
});

test("role loss closes a held detail and never re-admits cached events", async ({
  page,
}) => {
  const state = await mockSecurityEvents(page);
  await openFeed(page);
  const held = deferredMfaResponse();
  const native = deferredMfaResponse();
  state.holdDetail = held;
  state.auth.holdSession = native;
  try {
    await details(page, "Sign-in failure");
    await held.begun;
    state.role = "member";
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await native.begun;
    await expect(feed(page)).toHaveCount(0);
    held.release();
    native.release();
    await expect(
      page.getByRole("heading", { name: "Audit", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("tab", { name: "Security events", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("dialog", { name: "Security event details", exact: true }),
    ).toHaveCount(0);
    await expect(feed(page)).toHaveCount(0);
    expect(state.commands).toEqual([]);
  } finally {
    held.release();
    native.release();
  }
});

test("the feed's own Retry starts a new session-recheck cycle without clearing other privileged refusals", async ({
  page,
}) => {
  const state = await mockSecurityEvents(page);
  await openFeed(page);
  const first = deferredMfaResponse();
  const second = deferredMfaResponse();
  try {
    state.auth.holdSession = first;
    state.listStatus = 403;
    await feed(page)
      .getByRole("button", { name: "Refresh security events", exact: true })
      .click();
    await first.begun;
    first.release();
    await expect(feed(page).getByRole("alert")).toContainText(
      "Only administrators",
    );
    state.listStatus = 200;
    await feed(page)
      .getByRole("button", { name: "Retry security events", exact: true })
      .click();
    await expect(eventRows(page)).toContainText("sign-in was accepted");
    const verifiedReads = state.sessionReads;
    state.auth.holdSession = second;
    state.listStatus = 403;
    await feed(page)
      .getByRole("button", { name: "Refresh security events", exact: true })
      .click();
    await expect.poll(() => state.sessionReads).toBeGreaterThan(verifiedReads);
    await second.begun;
    await expect(eventRows(page)).toHaveCount(0);
    second.release();
    await expect(feed(page).getByRole("alert")).toContainText(
      "Only administrators",
    );
    await visitAccessSecurity(page);
    await expect(
      page.getByRole("table", { name: "Sessions", exact: true }),
    ).toHaveCount(0);
    expect(state.commands).toEqual([]);
    expect(state.security.writes).toEqual([]);
  } finally {
    first.release();
    second.release();
  }
});

for (const [width, height] of [
  [1440, 900],
  [390, 844],
] as const) {
  for (const mode of ["light", "dark"] as const) {
    test(`Access security and Audit events render at ${width}x${height} in ${mode} theme without writes or page errors`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      const state = await mockSecurityEvents(page);
      await page.route(
        `**/api/users/${state.auth.userId}/preferences`,
        (route) =>
          route.fulfill({
            headers: { "Cache-Control": "no-store" },
            json: {
              user_id: state.auth.userId,
              theme: mode,
              appearance: { motion: "system", keyboard_shortcuts: true },
            },
          }),
      );
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      state.directory.push(
        person({ id: mfaUserB, username: "jay", display_name: "Jay" }),
      );
      state.events = shownEventCases.map((item, index) =>
        securityEvent(200 + index, {
          ...item.patch,
          event_type: item.type,
          occurred_at: "2026-10-06T12:00:00Z",
          metadata: item.patch?.metadata ?? { ip_address: "198.51.100.42" },
        }),
      );
      await page.goto("/access?view=security");
      await expect(
        page.getByRole("button", { name: "End session for Eli", exact: true }),
      ).toBeEnabled();
      await expect(
        page.getByRole("link", {
          name: "View security events in Audit",
          exact: true,
        }),
      ).toBeVisible();
      await page
        .getByRole("link", {
          name: "View security events in Audit",
          exact: true,
        })
        .scrollIntoViewIfNeeded();
      if (mode === "dark")
        await expect(page.locator("html")).toHaveClass(/dark/);
      else await expect(page.locator("html")).not.toHaveClass(/dark/);
      await visitAuditSecurity(page);
      await expect(eventRows(page)).toContainText(
        "Mara's sign-in was accepted",
      );
      await page
        .getByRole("heading", { name: "Audit", exact: true })
        .scrollIntoViewIfNeeded();
      if (mode === "dark")
        await expect(page.locator("html")).toHaveClass(/dark/);
      else await expect(page.locator("html")).not.toHaveClass(/dark/);
      expect(state.commands).toEqual([]);
      expect(state.security.writes).toEqual([]);
      expect(pageErrors).toEqual([]);
    });
  }
}

const emittedSentenceCases: {
  type: string;
  sentence: string;
  patch?: Parameters<typeof securityEvent>[1];
}[] = [
  {
    type: "identity.sign_in",
    sentence: "Mara's sign-in was accepted from 198.51.100.42.",
  },
  {
    type: "identity.sign_in_failure",
    sentence: "Failed sign-in attempts were recorded from 198.51.100.42.",
    patch: { outcome: "failure", actor_id: null, subject_id: null },
  },
  {
    type: "identity.ip_blocked",
    sentence: "Sign-in was blocked from 198.51.100.42.",
    patch: { outcome: "denied", actor_id: null, subject_id: null },
  },
  {
    type: "identity.lockout",
    sentence: "Sign-in was temporarily locked from 198.51.100.42.",
    patch: { outcome: "denied", actor_id: null, subject_id: null },
  },
  {
    type: "identity.password_change",
    sentence: "Mara changed their password.",
  },
  {
    type: "identity.recovery_request",
    sentence: "A password recovery request was accepted.",
    patch: { actor_id: null, subject_id: null },
  },
  {
    type: "identity.recovery_complete",
    sentence: "Mara completed password recovery.",
  },
  {
    type: "identity.mfa.enrolled",
    sentence: "Mara enrolled a two-step verification factor.",
  },
  {
    type: "identity.mfa.verified",
    sentence: "Mara completed two-step verification.",
  },
  {
    type: "identity.mfa.removed",
    sentence: "Mara removed a two-step verification factor.",
  },
  {
    type: "identity.mfa.cancelled",
    sentence: "Mara cancelled two-step verification setup.",
  },
  {
    type: "identity.mfa.removal_incomplete",
    sentence:
      "Two-step verification removal for Mara was only partly completed.",
    patch: { outcome: "partial" },
  },
  {
    type: "identity.recovery",
    sentence: "Mara requested password recovery for Jay.",
    patch: { subject_id: mfaUserB },
  },
  {
    type: "identity.mfa_reset",
    sentence: "Mara reset two-step verification for Jay.",
    patch: { subject_id: mfaUserB },
  },
  {
    type: "identity.session_revocation",
    sentence: "Mara ended Jay's other sessions.",
    patch: { subject_id: mfaUserB, labels: { scope: "others" } },
  },
  {
    type: "identity.local_admin_recovery",
    sentence: "Local administrator recovery was requested for Jay.",
    patch: { actor_id: null, subject_id: mfaUserB },
  },
  {
    type: "identity.local_security_recovery",
    sentence: "Local security recovery completed for Jay.",
    patch: { actor_id: null, subject_id: mfaUserB },
  },
  {
    type: "user.invitation",
    sentence: "Mara invited Jay.",
    patch: { subject_id: mfaUserB },
  },
  {
    type: "user.invitation_resend",
    sentence: "Mara resent an invitation for Jay.",
    patch: { subject_id: mfaUserB },
  },
  {
    type: "user.invitation_revocation",
    sentence: "Mara revoked Jay's invitation.",
    patch: { subject_id: mfaUserB },
  },
  {
    type: "user.invitation_acceptance",
    sentence: "Jay accepted an invitation.",
    patch: { actor_id: mfaUserB, subject_id: mfaUserB },
  },
  {
    type: "user.authentication_activation",
    sentence: "Mara activated authentication for Jay.",
    patch: { subject_id: mfaUserB },
  },
  {
    type: "user.authentication_disable",
    sentence: "Mara disabled authentication for Jay.",
    patch: { subject_id: mfaUserB },
  },
  {
    type: "user.authentication_restore",
    sentence: "Mara restored authentication for Jay.",
    patch: { subject_id: mfaUserB },
  },
  {
    type: "workspace.security_policy_change",
    sentence: "Mara changed the account security policy.",
    patch: { subject_id: null },
  },
  {
    type: "security.retention",
    sentence: "Session retention removed 4 session records.",
    patch: {
      actor_id: null,
      subject_id: null,
      metadata: {
        scope: "identity_sessions",
        deleted_sessions: 4,
        retention_days: 30,
      },
    },
  },
  {
    type: "backup.export.download",
    sentence: "Backup export download by Mara was attempted.",
    patch: {
      outcome: "attempt",
      subject_id: eventOperationId,
      metadata: { size_bytes: 200, backup_run_id: eventOperationId },
    },
  },
  {
    type: "file.download",
    sentence: "File download by Mara was attempted.",
    patch: {
      outcome: "attempt",
      subject_id: null,
      metadata: { file_id: eventOperationId },
    },
  },
  {
    type: "records.export.authorized",
    sentence: "Mara was authorized to export 120 records as Excel.",
    patch: {
      subject_id: eventOperationId,
      metadata: { format: "xlsx", row_count: 120, column_count: 3 },
    },
  },
  {
    type: "records.aggregate_snapshot.authorized",
    sentence:
      "Mara was authorized to create an aggregate snapshot with 7 buckets.",
    patch: { subject_id: eventOperationId, metadata: { bucket_count: 7 } },
  },
  {
    type: "records.aggregate_snapshots.authorized",
    sentence:
      "Mara was authorized to create 2 aggregate snapshots with 7 buckets.",
    patch: {
      subject_id: null,
      metadata: {
        query_count: 2,
        bucket_count: 7,
        module_ids: [eventOperationId, historicalPersonId],
      },
    },
  },
  {
    type: "lifecycle.record_purge",
    sentence: "Mara permanently deleted a record.",
    patch: {
      subject_id: eventOperationId,
      metadata: { trigger_history_rows_removed: 3 },
    },
  },
  {
    type: "job.retry",
    sentence: "Mara queued a retry for a backup job.",
    patch: {
      subject_id: eventOperationId,
      metadata: { kind: "backup", result_id: historicalPersonId },
    },
  },
];

test("S09: emitted event sentences use recorded facts without claiming unfinished work", async ({
  page,
}) => {
  const state = await mockSecurityEvents(page);
  state.directory.push(
    person({ id: mfaUserB, username: "jay", display_name: "Jay" }),
  );
  state.events = emittedSentenceCases.map((item, index) =>
    securityEvent(index + 100, {
      ...item.patch,
      event_type: item.type,
      occurred_at: "2026-10-06T12:00:00Z",
      metadata: {
        ...(item.patch?.metadata ?? { ip_address: "198.51.100.42" }),
        internal_note: unsafeEventCanary,
      },
    }),
  );
  await page.goto("/manage?view=audit&audit=security-events");
  const controls = await filters(page);
  for (const item of emittedSentenceCases) {
    await controls
      .getByLabel("Event type", { exact: true })
      .selectOption(item.type);
    await expect(
      eventRows(page).getByText(item.sentence, { exact: true }),
    ).toBeVisible();
    await expect(eventRows(page)).not.toContainText("Other security event");
    await expect(eventRows(page)).not.toContainText(unsafeEventCanary);
    await expect
      .poll(() => state.reads.at(-1)?.get("event_type"))
      .toBe(item.type);
  }
  expect(state.commands).toEqual([]);
  expect(state.security.writes).toEqual([]);
});

test("S09: missing and malformed sentence facts keep non-success outcomes truthful", async ({
  page,
}) => {
  const state = await mockSecurityEvents(page);
  state.events = [
    securityEvent(0, {
      actor_id: null,
      subject_id: null,
      event_type: "identity.recovery_complete",
      outcome: "attempt",
      metadata: {},
    }),
    securityEvent(1, {
      actor_id: null,
      subject_id: null,
      event_type: "identity.password_change",
      outcome: "failure",
      metadata: {},
    }),
    securityEvent(2, {
      actor_id: null,
      subject_id: null,
      event_type: "user.invitation",
      outcome: "denied",
      metadata: {},
    }),
    securityEvent(3, {
      actor_id: null,
      subject_id: null,
      event_type: "identity.mfa_reset",
      outcome: "partial",
      metadata: {},
    }),
    securityEvent(4, {
      actor_id: null,
      subject_id: null,
      event_type: "records.export.authorized",
      metadata: {
        row_count: true,
        format: "constructor",
        module_name: unsafeEventCanary,
      },
    }),
    securityEvent(5, {
      actor_id: null,
      subject_id: null,
      event_type: "records.aggregate_snapshots.authorized",
      metadata: {
        bucket_count: -1,
        query_count: "2",
        module_ids: [unsafeEventCanary],
      },
    }),
    securityEvent(6, {
      actor_id: null,
      subject_id: null,
      event_type: "job.retry",
      metadata: { kind: "__proto__", result_id: unsafeEventCanary },
    }),
  ];
  await page.goto("/manage?view=audit&audit=security-events");
  for (const sentence of [
    "Password recovery for Unknown person was attempted.",
    "Password change for Unknown person failed.",
    "An invitation from Unknown person to Unknown person was denied.",
    "Two-step verification reset by Unknown person for Unknown person was only partly completed.",
    "Unknown person was authorized to export records.",
    "Unknown person was authorized to create aggregate snapshots.",
    "Unknown person queued a retry for a job.",
  ])
    await expect(
      eventRows(page).getByText(sentence, { exact: true }),
    ).toBeVisible();
  await expect(eventRows(page)).not.toContainText(
    /completed password recovery|changed their password|invited |reset two-step verification|0 records|0 buckets|__proto__|constructor/,
  );
  await expect(eventRows(page)).not.toContainText(unsafeEventCanary);
  expect(state.commands).toEqual([]);
});
