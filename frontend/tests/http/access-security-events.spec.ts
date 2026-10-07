import { expect, test, type Page } from "./helpers/test";
import { person } from "./helpers/access-api";
import { deferredMfaResponse, mfaUserA, mfaUserB } from "./helpers/mfa";
import {
  eventOperationId,
  historicalPersonId,
  matchingPageEvents,
  mockSecurityEvents,
  securityEvent,
  unsafeEventCanary,
} from "./helpers/security-events";

test.use({ trace: "off", screenshot: "off", video: "off" });

function feed(page: Page) {
  return page.getByRole("region", { name: "Security events", exact: true });
}
function eventRows(page: Page) {
  return feed(page)
    .getByRole("table", { name: "Security events", exact: true })
    .or(feed(page).getByRole("list", { name: "Security events", exact: true }));
}
async function openFeed(page: Page) {
  await page.goto("/access?view=security");
  await expect(feed(page)).toBeVisible();
  await expect(
    eventRows(page).getByText("Sign-in accepted", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "End session for Eli", exact: true }),
  ).toBeEnabled();
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
  await expect(feed(page)).toContainText("Unknown person");
  await expect(feed(page)).toContainText("Address unknown");
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

test("Events filters serialize workspace-local day bounds and person values before server paging and reset offset", async ({
  page,
}) => {
  const state = await mockSecurityEvents(page);
  state.events = matchingPageEvents();
  await page.goto("/access?view=security");
  await expect(
    feed(page).getByRole("table", { name: "Security events", exact: true }),
  ).toBeVisible();
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
  await expect(
    eventRows(page).getByText("Sign-in accepted", { exact: true }),
  ).toBeVisible();
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
  await page.goto("/access?view=security");
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
    await page.goto("/access?view=security");
    await expect(
      eventRows(page).getByText("Recovery completion", { exact: true }),
    ).toBeVisible();
    await expect(eventRows(page)).not.toContainText("Recovery completed");
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
  await expect(
    eventRows(page).getByText("Sign-in accepted", { exact: true }),
  ).toBeVisible();
  await expect(feed(page)).not.toContainText(unsafeEventCanary);
  state.listStatus = 200;
  await feed(page)
    .getByRole("button", { name: "Retry security events", exact: true })
    .click();
  await expect(feed(page).getByRole("alert")).toHaveCount(0);
  await expect(
    eventRows(page).getByText("Sign-in accepted", { exact: true }),
  ).toBeVisible();
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
    await expect(
      eventRows(page).getByText("Sign-in accepted", { exact: true }),
    ).toHaveCount(0);
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
  await page.goto("/access?view=security");
  await expect(feed(page).getByRole("alert")).toContainText(
    "could not be loaded",
  );
  await expect(
    eventRows(page).getByText("Sign-in accepted", { exact: true }),
  ).toHaveCount(0);
  state.listStatus = 200;
  await feed(page)
    .getByRole("button", { name: "Retry security events", exact: true })
    .click();
  await expect(
    eventRows(page).getByText("Sign-in accepted", { exact: true }),
  ).toBeVisible();
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

for (const malformed of [
  { title: "invalid outcome", patch: { outcome: "unknown" } },
  { title: "naive occurrence", patch: { occurred_at: "2026-10-06T12:00:00" } },
  { title: "non-UUID person", patch: { actor_id: "email@example.invalid" } },
]) {
  test(`Events malformed ${malformed.title} response is unavailable rather than trusted`, async ({
    page,
  }) => {
    const state = await mockSecurityEvents(page);
    state.malformedList = {
      items: [{ ...securityEvent(0), ...malformed.patch }],
      pagination: { limit: 10, offset: 0, count: 1, total: 1, has_more: false },
    };
    await page.goto("/access?view=security");
    await expect(feed(page).getByRole("alert")).toContainText(
      "could not be loaded",
    );
    await expect(
      eventRows(page).getByText("Sign-in accepted", { exact: true }),
    ).toHaveCount(0);
    state.malformedList = null;
    await feed(page)
      .getByRole("button", { name: "Retry security events", exact: true })
      .click();
    await expect(
      eventRows(page).getByText("Sign-in accepted", { exact: true }),
    ).toBeVisible();
  });
}

test("Events detail identity mismatch cannot show another event's facts", async ({
  page,
}) => {
  const state = await mockSecurityEvents(page);
  await openFeed(page);
  state.malformedDetail = securityEvent(2);
  const dialog = await details(page, "Sign-in failure");
  await expect(dialog.getByRole("alert")).toContainText(
    "Details could not be loaded",
  );
  await expect(dialog).not.toContainText("198.51.100.42");
  state.malformedDetail = null;
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
    await page.goto("/access?view=security");
    await expect(
      page.getByRole("heading", {
        name: role === "manager" ? "Groups" : "Access",
        exact: true,
      }),
    ).toBeVisible();
    await expect(feed(page)).toHaveCount(0);
    expect(state.reads).toEqual([]);
    expect(state.details).toEqual([]);
  });
}

test("Events refresh and held detail leave the existing policy draft and explicit Save owner intact", async ({
  page,
}) => {
  const state = await mockSecurityEvents(page);
  await openFeed(page);
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
  await feed(page)
    .getByRole("button", { name: "Refresh security events", exact: true })
    .click();
  const held = deferredMfaResponse();
  state.holdDetail = held;
  try {
    const event = await details(page, "Sign-in failure");
    await held.begun;
    await page.keyboard.press("Escape");
    await expect(event).toBeHidden();
    await page
      .getByRole("button", { name: "Edit policy", exact: true })
      .click();
    await expect(
      policy.getByLabel("Session timeout", { exact: true }),
    ).toHaveValue("30 minutes");
    await policy
      .getByRole("button", { name: "Save settings", exact: true })
      .click();
    await expect(
      policy.getByRole("button", { name: "Save settings", exact: true }),
    ).toBeDisabled();
    expect(state.security.policy.session_timeout_minutes).toBe(30);
    held.release();
    await expect(event).toBeHidden();
    expect(state.commands).toEqual([]);
    expect(state.security.writes).toEqual([
      {
        path: "/workspace/security",
        body: { revision: 1, session_timeout_minutes: 30 },
      },
    ]);
  } finally {
    held.release();
  }
});

for (const status of [401, 403]) {
  test(`Events fresh ${status} refusal conceals all cached privileged reads and detail before explicit recovery`, async ({
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
    await openFeed(page);
    const native = deferredMfaResponse();
    const repeatedNative = deferredMfaResponse();
    state.auth.holdSession = native;
    state.listStatus = status;
    state.security.policyReadStatus = 503;
    state.security.sessionReadStatus = 503;
    const reads = state.sessionReads;
    try {
      await feed(page)
        .getByRole("button", { name: "Refresh security events", exact: true })
        .click();
      await native.begun;
      await expect(
        page.getByRole("table", { name: "Sessions", exact: true }),
      ).toHaveCount(0);
      await expect(
        eventRows(page).getByText("Sign-in accepted", { exact: true }),
      ).toHaveCount(0);
      native.release();
      await expect.poll(() => state.sessionReads).toBeGreaterThan(reads);
      await expect(feed(page).getByRole("alert")).toContainText(
        "Only administrators",
      );
      await expect(
        page.getByRole("table", { name: "Sessions", exact: true }),
      ).toHaveCount(0);
      state.listStatus = 200;
      await feed(page)
        .getByRole("button", { name: "Retry security events", exact: true })
        .click();
      await expect(
        eventRows(page).getByText("Sign-in accepted", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("table", { name: "Sessions", exact: true }),
      ).toHaveCount(0);
      state.listStatus = status;
      await feed(page)
        .getByRole("button", { name: "Refresh security events", exact: true })
        .click();
      await expect(feed(page).getByRole("alert")).toContainText(
        "Only administrators",
      );
      state.security.policyReadStatus = 200;
      state.security.sessionReadStatus = 200;
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
      state.listStatus = 200;
      await feed(page)
        .getByRole("button", { name: "Retry security events", exact: true })
        .click();
      await expect(
        eventRows(page).getByText("Sign-in accepted", { exact: true }),
      ).toBeVisible();
      const recoveredReads = state.sessionReads;
      state.auth.holdSession = repeatedNative;
      state.listStatus = status;
      await feed(page)
        .getByRole("button", { name: "Refresh security events", exact: true })
        .click();
      await expect
        .poll(() => state.sessionReads)
        .toBeGreaterThan(recoveredReads);
      await expect(
        page.getByRole("table", { name: "Sessions", exact: true }),
      ).toHaveCount(0);
      await expect(eventRows(page)).toHaveCount(0);
      expect(consoleErrors).toEqual([]);
      repeatedNative.release();
    } finally {
      native.release();
      repeatedNative.release();
    }
  });
}

test("Events an older held Retry cannot clear a newer policy refusal", async ({
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
  const settled = new Promise<void>((resolve) => {
    const complete = (request: { url: () => string }) => {
      if (!/\/api\/security-events(?:\?|$)/.test(request.url())) return;
      page.off("requestfinished", complete);
      page.off("requestfailed", complete);
      resolve();
    };
    page.on("requestfinished", complete);
    page.on("requestfailed", complete);
  });
  try {
    await feed(page)
      .getByRole("button", { name: "Retry security events", exact: true })
      .click();
    await held.begun;
    state.security.policyReadStatus = 403;
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
        {
          exact: true,
        },
      ),
    ).toBeVisible();
    await expect(retryPolicy).toBeEnabled();
    await policy
      .getByRole("button", { name: "Close account policy", exact: true })
      .click();
    held.release();
    await settled;
    const retryEvents = feed(page).getByRole("button", {
      name: "Retry security events",
      exact: true,
    });
    await expect(retryEvents).toBeEnabled();
    await expect(feed(page).getByRole("alert")).toContainText(
      "Only administrators",
    );
    await expect(eventRows(page)).toHaveCount(0);
    await retryEvents.click();
    await expect(
      eventRows(page).getByText("Sign-in accepted", { exact: true }),
    ).toBeVisible();
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
  await expect(
    eventRows(page).getByText("Sign-in accepted", { exact: true }),
  ).toHaveCount(0);
  await expect(feed(page).getByRole("alert")).toContainText(
    "Only administrators",
  );
  await feed(page)
    .getByRole("button", { name: "Retry security events", exact: true })
    .click();
  await expect(
    eventRows(page).getByText("Sign-in accepted", { exact: true }),
  ).toBeVisible();
});

test("Events curtain clears held detail while preserving only the same-account policy draft", async ({
  page,
}) => {
  const state = await mockSecurityEvents(page);
  await openFeed(page);
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
    await expect(
      eventRows(page).getByText("Sign-in accepted", { exact: true }),
    ).toHaveCount(0);
    await expect(event).toHaveCount(0);
    detail.release();
    native.release();
    await expect(feed(page)).toBeVisible();
    await expect(event).toHaveCount(0);
    await page
      .getByRole("button", { name: "Edit policy", exact: true })
      .click();
    await expect(
      policy.getByLabel("Session timeout", { exact: true }),
    ).toHaveValue("30 minutes");
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
    await expect(feed(page)).toContainText("Recovery completion");
    old.release();
    await expect(eventRows(page)).not.toContainText("Sign-in accepted");
    await expect(eventRows(page)).not.toContainText("Sign-in failure");
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
  await expect(
    feed(page).getByRole("table", { name: "Security events", exact: true }),
  ).toBeVisible();
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

for (const mode of ["light", "dark"] as const) {
  test(`Events compact ${mode} keyboard details and date filters remain reachable at 125 percent reflow`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockSecurityEvents(page);
    await openFeed(page);
    await page.evaluate((theme) => {
      document.documentElement.classList.toggle("dark", theme === "dark");
      document.documentElement.dataset.textSize = "125";
      document.documentElement.dataset.density = "spacious";
    }, mode);
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
}

test("13b: unchanged Events person picker consumes the complete extended later-page catalog", async ({
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
  const controls = await filters(page);
  await controls.getByLabel("Person", { exact: true }).click();
  await page
    .getByRole("option", { name: "Zzz Event Person", exact: true })
    .click();
  await expect.poll(() => state.reads.at(-1)?.get("person_id")).toBe(late);
  await expect(feed(page)).toContainText("1 event");
  expect(state.userQueries.some((query) => query.get("offset") === "100")).toBe(
    true,
  );
  expect(state.commands).toEqual([]);
});
