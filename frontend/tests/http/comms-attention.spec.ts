import {
  authMeBody,
  controlledSession,
  defaultOrganization,
  defaultSignedInIdentity,
  expect,
  heldResponse,
  recheckSession,
  settleReact,
  test,
  type Page,
} from "./helpers/test";
import {
  attentionBaselined,
  attentionEmissions,
  commsNotice,
  installAttentionApi,
  installAttentionBrowser,
} from "./helpers/comms-attention";
import {
  installOpenViewEventSource,
  sendOpenViewEvent,
} from "./helpers/openview-event-source";
import { installCommsLiveApi } from "./helpers/comms-live-api";

const route = "/platform?section=search";
const commsLink = (page: Page) =>
  page.getByRole("link", { name: /^OpenComms/ }).first();
const notify = (...tabs: Page[]) =>
  Promise.all(
    tabs.map((tab) =>
      sendOpenViewEvent(tab, "invalidate", { entity: "in_app_notifications" }),
    ),
  );
const second = {
  org_id: "97000000-0000-4000-8000-000000000002",
  name: "Second organization",
  slug: "second",
  role: "admin" as const,
};

async function admit(tab: Page, org: typeof second) {
  const first = { ...defaultOrganization, role: "admin" as const };
  await tab.route("**/api/auth/session", (request) =>
    request.fulfill({
      json: {
        authenticated: true,
        user_id: defaultSignedInIdentity.id,
        organization_id: org.org_id,
        setup_required: false,
        default_organization_blocked: null,
      },
    }),
  );
  await tab.route("**/api/auth/me", (request) =>
    request.fulfill({
      json: authMeBody({
        id: defaultSignedInIdentity.id,
        role: "admin",
        memberships: [first, second],
        current_organization: { ...org, access: [] },
      }),
    }),
  );
}

test("the Comms link and tab title count only the current organization's unread messages", async ({
  page,
  context,
}) => {
  await installOpenViewEventSource(page, { autoResync: true });
  const first = await installAttentionApi(page, {
    orgId: defaultOrganization.org_id,
    unread: 3,
    mutedMentions: 1,
  });
  const other = await context.newPage();
  await installOpenViewEventSource(other, { autoResync: true });
  await admit(other, second);
  await installAttentionApi(other, { orgId: second.org_id, unread: 7 });

  await page.goto(route);
  await expect(commsLink(page)).toHaveAccessibleName("OpenComms, 4 unread");
  await expect(page).toHaveTitle(/^\(4\) /);
  await other.goto(route);
  await expect(commsLink(other)).toHaveAccessibleName("OpenComms, 7 unread");
  await expect(other).toHaveTitle(/^\(7\) /);
  await expect(commsLink(page)).toHaveAccessibleName("OpenComms, 4 unread");

  first.unread = 0;
  await notify(page);
  await expect(commsLink(page)).toHaveAccessibleName("OpenComms, 1 unread");
  await expect(page).toHaveTitle(/^\(1\) /);
  await expect(other).toHaveTitle(/^\(7\) /);
  await other.close();
});

test("only the leader tab raises one desktop alert and sound for a new Comms notification", async ({
  page,
  context,
}) => {
  const tabs = [page, await context.newPage()];
  const states: Awaited<ReturnType<typeof installAttentionApi>>[] = [];
  for (const tab of tabs) {
    await installAttentionBrowser(tab);
    await installOpenViewEventSource(tab, { autoResync: true });
    const state = await installAttentionApi(tab, {
      orgId: defaultOrganization.org_id,
      unread: 0,
    });
    // Unread before the tabs opened is the baseline, never an alert.
    state.notifications.push(
      commsNotice(9, defaultOrganization.org_id, state.room, "comms-direct"),
    );
    states.push(state);
  }
  for (const tab of tabs) {
    await tab.goto(route);
    await expect(commsLink(tab)).toHaveAccessibleName("OpenComms");
  }
  await attentionBaselined(tabs, defaultOrganization.org_id, [
    states[0].notifications[0].id,
  ]);
  const notice = commsNotice(1, defaultOrganization.org_id, states[0].room);
  for (const state of states) {
    state.notifications.push(notice);
    state.unread = 1;
  }
  await notify(...tabs);
  await expect
    .poll(() => attentionEmissions(page))
    .toEqual({
      desktop: [{ title: "OpenComms", body: "Mention in operations" }],
      sound: 1,
    });
  await expect(commsLink(tabs[1])).toHaveAccessibleName("OpenComms, 1 unread");
  await tabs[1].reload();
  await expect(commsLink(tabs[1])).toHaveAccessibleName("OpenComms, 1 unread");
  const reads = states[0].listReads + states[1].listReads;
  await notify(...tabs);
  await expect
    .poll(() => states[0].listReads + states[1].listReads)
    .toBeGreaterThan(reads);
  await settleReact(page);
  expect(await attentionEmissions(page)).toEqual({
    desktop: [{ title: "OpenComms", body: "Mention in operations" }],
    sound: 1,
  });
});

test("quiet hours silence the alert and sound until they end", async ({
  page,
}) => {
  await page.clock.setFixedTime("2026-10-21T14:30:00Z"); // 22:30 in Asia/Manila
  await installAttentionBrowser(page);
  await installOpenViewEventSource(page, { autoResync: true });
  const state = await installAttentionApi(page, {
    orgId: defaultOrganization.org_id,
    unread: 0,
    personal: {
      quiet_hours_start: "22:00",
      quiet_hours_end: "07:00",
      notification_preview: false,
    },
  });
  const baseline = commsNotice(
    9,
    defaultOrganization.org_id,
    state.room,
    "comms-direct",
  );
  state.notifications.push(baseline);
  await page.goto(route);
  await expect(commsLink(page)).toHaveAccessibleName("OpenComms");
  await attentionBaselined([page], defaultOrganization.org_id, [baseline.id]);
  state.notifications.push(
    commsNotice(1, defaultOrganization.org_id, state.room),
  );
  await notify(page);
  await expect.poll(() => state.preferenceReads).toBe(1);
  await settleReact(page);
  expect(await attentionEmissions(page)).toEqual({ desktop: [], sound: 0 });
  await page.clock.setFixedTime("2026-10-21T23:30:00Z"); // 07:30 in Manila
  state.notifications.push(
    commsNotice(2, defaultOrganization.org_id, state.room, "comms-direct"),
  );
  await notify(page);
  await expect
    .poll(() => attentionEmissions(page))
    .toEqual({
      desktop: [{ title: "OpenComms", body: "New activity in OpenComms" }],
      sound: 1,
    });
});

test("a denied browser permission plays the sound without a desktop alert", async ({
  page,
}) => {
  await installAttentionBrowser(page, "denied");
  await installOpenViewEventSource(page, { autoResync: true });
  const state = await installAttentionApi(page, {
    orgId: defaultOrganization.org_id,
    unread: 0,
  });
  const baseline = commsNotice(
    9,
    defaultOrganization.org_id,
    state.room,
    "comms-direct",
  );
  state.notifications.push(baseline);
  await page.goto(route);
  await expect(commsLink(page)).toHaveAccessibleName("OpenComms");
  await attentionBaselined([page], defaultOrganization.org_id, [baseline.id]);
  state.notifications.push(
    commsNotice(1, defaultOrganization.org_id, state.room),
  );
  await notify(page);
  await expect
    .poll(() => attentionEmissions(page))
    .toEqual({ desktop: [], sound: 1 });
});

test("the focused open conversation raises no alert until its tab loses focus", async ({
  page,
}) => {
  await installAttentionBrowser(page);
  const api = await installCommsLiveApi(page);
  const notices = [
    commsNotice(1, defaultOrganization.org_id, api.room),
    commsNotice(
      2,
      defaultOrganization.org_id,
      "94000000-0000-4000-8000-0000000000aa",
      "comms-direct",
    ),
    commsNotice(3, defaultOrganization.org_id, api.room),
  ];
  const listed: typeof notices = [];
  let reads = 0;
  await page.route(
    (url) => url.pathname === "/api/notifications",
    (request) => {
      reads += 1;
      return request.fulfill({
        json: {
          items: listed,
          pagination: {
            limit: 10,
            offset: 0,
            count: listed.length,
            total: listed.length,
            has_more: false,
          },
        },
      });
    },
  );
  await page.goto(`/comms?conversation=${api.room}`);
  await expect(
    page.getByRole("status", { name: "Conversation connection", exact: true }),
  ).toContainText("Live");
  // The leader's baseline read finishes before any notice exists.
  await expect.poll(() => reads).toBe(1);
  listed.push(notices[0]);
  await notify(page);
  listed.push(notices[1]);
  await notify(page);
  await expect
    .poll(() => attentionEmissions(page))
    .toEqual({
      desktop: [{ title: "OpenComms", body: "Direct message" }],
      sound: 1,
    });
  await page.evaluate(() => {
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => false,
    });
    window.dispatchEvent(new Event("blur"));
  });
  listed.push(notices[2]);
  await notify(page);
  await expect
    .poll(() => attentionEmissions(page))
    .toEqual({
      desktop: [
        { title: "OpenComms", body: "Direct message" },
        { title: "OpenComms", body: "Mention in live-operations" },
      ],
      sound: 2,
    });
  api.close();
});

test("a badges-off preference shows no count on the link or the tab title", async ({
  page,
}) => {
  await installOpenViewEventSource(page, { autoResync: true });
  const state = await installAttentionApi(page, {
    orgId: defaultOrganization.org_id,
    unread: 3,
    personal: { notification_badges: false },
  });
  await page.goto(route);
  await expect.poll(() => state.preferenceReads).toBe(1);
  await settleReact(page);
  await expect(commsLink(page)).toHaveAccessibleName("OpenComms");
  await expect(page).not.toHaveTitle(/^\(/);
});

test("regaining leadership after a session check does not read the unread baseline again", async ({
  page,
}) => {
  const session = await controlledSession(page, {
    id: defaultSignedInIdentity.id,
    role: "admin",
  });
  await installAttentionBrowser(page);
  await installOpenViewEventSource(page, { autoResync: true });
  const state = await installAttentionApi(page, {
    orgId: defaultOrganization.org_id,
    unread: 0,
  });
  const baseline = heldResponse();
  let first = true;
  await page.route(
    (url) => url.pathname === "/api/notifications",
    async (route) => {
      if (first) {
        first = false;
        baseline.enter();
        await baseline.released;
      }
      return route.fallback();
    },
  );
  await page.goto(route);
  await baseline.entered;
  const check = heldResponse();
  session.hold = check;
  await recheckSession(page);
  await check.entered;
  await expect(
    page.getByRole("dialog", { name: "Session verification" }),
  ).toBeHidden();
  baseline.release();
  await expect.poll(() => state.listReads).toBe(1);
  session.hold = null;
  check.release();
  await expect(
    page.getByRole("dialog", { name: "Session verification" }),
  ).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            Reflect.get(window, "__openViewStreamState") as () => {
              active: number;
            }
          )().active,
      ),
    )
    .toBe(1);
  state.notifications.push(
    commsNotice(1, defaultOrganization.org_id, state.room),
  );
  await notify(page);
  await expect
    .poll(() => attentionEmissions(page))
    .toEqual({
      desktop: [{ title: "OpenComms", body: "Mention in operations" }],
      sound: 1,
    });
  // One baseline before the check and one read for the new notice.
  expect(state.listReads).toBe(2);
});
