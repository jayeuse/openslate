import {
  expect,
  test,
  defaultOrganization,
  defaultSignedInIdentity,
  expectNoHorizontalScroll,
  heldResponse,
} from "./helpers/test";
import { installCommsLiveApi } from "./helpers/comms-live-api";
import { pageOf } from "../helpers/pagination";
import { profilePreferences } from "./helpers/profile-api";

test("typing sends are throttled and require a visible current posting context", async ({
  page,
}) => {
  const server = await installCommsLiveApi(page);
  try {
    await page.clock.install();
    await page.goto("/comms");
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await input.fill("A local draft");
    await expect.poll(() => server.typingRequests.length).toBe(1);
    await input.fill("More local text");
    await page.clock.runFor(9_000);
    await input.fill("Still typing");
    expect(server.typingRequests).toEqual([defaultOrganization.org_id]);
    await page.clock.runFor(1_000);
    await input.fill("Continuing to type");
    await expect.poll(() => server.typingRequests.length).toBe(2);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.clock.runFor(10_000);
    await input.fill("Hidden draft input");
    expect(server.typingRequests).toHaveLength(2);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(input).toBeEnabled();
    server.setPosting(false);
    await expect(input).toBeDisabled();
    server.setPosting(true, true);
    await expect(
      page.getByText(
        "This channel is locked. Unlock it in channel settings to post.",
        { exact: true },
      ),
    ).toBeVisible();
    expect(server.typingRequests).toHaveLength(2);
  } finally {
    await page.close();
    server.close();
  }
});

test("typing and presence stay legible in narrow and wide light and dark conversations", async ({
  page,
}, testInfo) => {
  const server = await installCommsLiveApi(page);
  const person = server.members.find(
    (member) => member.user_id !== defaultSignedInIdentity.id,
  )!;
  server.setPresence(person.user_id, "online");
  await page.route(
    `**/api/users/${defaultSignedInIdentity.id}/preferences`,
    (route) =>
      route.fulfill({
        json: {
          ...profilePreferences(defaultSignedInIdentity.id),
          theme: "system",
        },
      }),
  );
  await page.route(`**/api/users/${person.user_id}/card`, (route) =>
    route.fulfill({
      json: {
        display_name: person.display_name,
        job_title: "Operator",
        avatar_url: null,
        email: null,
        phone: null,
        bio: null,
      },
    }),
  );
  try {
    for (const width of [1440, 390])
      for (const theme of ["light", "dark"] as const) {
        await page.setViewportSize({
          width,
          height: width === 390 ? 844 : 900,
        });
        await page.emulateMedia({
          colorScheme: theme,
          reducedMotion: "reduce",
        });
        await page.goto(`/comms?conversation=${server.room}`);
        await expect(
          page.getByRole("textbox", { name: "Message", exact: true }),
        ).toBeEnabled();
        if (theme === "dark")
          await expect(page.locator("html")).toHaveClass(/\bdark\b/);
        else await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
        const typing = page.getByRole("status", {
          name: "Typing activity",
          exact: true,
        });
        await expect(typing).toBeVisible();
        await expect(
          page.getByRole("status", {
            name: "Conversation connection",
            exact: true,
          }),
        ).toContainText("Live");
        server.publishTyping(person.user_id);
        await expect(typing).toContainText(person.display_name);
        await expectNoHorizontalScroll(page);
        await typing.locator("..").screenshot({
          path: testInfo.outputPath(`${width}-${theme}-typing.png`),
          animations: "disabled",
        });
        await page.goto(`/comms?conversation=${server.room}&panel=members`);
        const members = page.getByRole("region", {
          name: "Members with access",
          exact: true,
        });
        await expect(
          members.getByRole("region", { name: "Online members", exact: true }),
        ).toContainText(person.display_name);
        await members.screenshot({
          path: testInfo.outputPath(`${width}-${theme}-members.png`),
          animations: "disabled",
        });
        await members
          .getByRole("button", {
            name: `Person card: ${person.display_name}`,
            exact: true,
          })
          .click();
        const card = page.getByRole("dialog", {
          name: "Person card",
          exact: true,
        });
        await expect(card.getByText("Online", { exact: true })).toBeVisible();
        await card.screenshot({
          path: testInfo.outputPath(`${width}-${theme}-card.png`),
          animations: "disabled",
        });
      }
  } finally {
    await page.close();
    server.close();
  }
});

test("typing names expire and exclude own unknown foreign and inactive conversations", async ({
  page,
}) => {
  const server = await installCommsLiveApi(page);
  const person = server.members.find(
    (member) => member.user_id !== defaultSignedInIdentity.id,
  )!;
  const gates: ReturnType<typeof heldResponse>[] = [];
  try {
    await page.clock.install();
    await page.goto("/comms");
    await expect(
      page.getByRole("status", {
        name: "Conversation connection",
        exact: true,
      }),
    ).toContainText("Live");
    const typing = page.getByRole("status", {
      name: "Typing activity",
      exact: true,
    });
    await expect(typing).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeEnabled();
    server.publishTyping(person.user_id);
    await expect(typing).toContainText(`${person.display_name} is typing`);
    await page.clock.runFor(15_000);
    await expect(typing).toBeEmpty();
    server.publishTyping(defaultSignedInIdentity.id);
    server.publishTyping("98000000-0000-4000-8000-000000000099");
    server.publishTyping(
      person.user_id,
      server.room,
      "98000000-0000-4000-8000-000000000098",
    );
    server.publishTyping(
      person.user_id,
      "98000000-0000-4000-8000-000000000097",
    );
    await expect(typing).toBeEmpty();
    server.publishTyping(person.user_id);
    await expect(typing).toContainText(person.display_name);
    let gate: ReturnType<typeof heldResponse> | null = null;
    let denyMembers = false;
    await page.route(
      `**/api/comms/conversations/${server.room}/members?**`,
      async (route) => {
        const held = gate,
          denied = denyMembers;
        if (held) {
          held.enter();
          await held.released;
        }
        if (denied)
          return route.fulfill({
            status: 403,
            json: { detail: "Unavailable" },
          });
        return route.fallback();
      },
    );
    const refreshing = page.getByText("Refreshing conversations…", {
      exact: true,
    });
    for (const event of ["membership", "grants", "structure"] as const) {
      gate = heldResponse();
      gates.push(gate);
      server.publishAuthorizationChange(event);
      await gate.entered;
      await expect(refreshing).toBeVisible();
      await expect(typing).toBeEmpty();
      server.publishTyping(person.user_id);
      await page.clock.runFor(100);
      await expect(typing).toBeEmpty();
      gate.release();
      gate = null;
      await expect(refreshing).toBeHidden();
      // The unchanged authorized member body must still count as a fresh read.
      server.publishTyping(person.user_id);
      await expect(typing).toContainText(person.display_name);
    }
    denyMembers = true;
    gate = heldResponse();
    gates.push(gate);
    server.publishAuthorizationChange("grants");
    await gate.entered;
    await expect(typing).toBeEmpty();
    gate.release();
    gate = null;
    // A refused member read conceals the conversation until it is read again.
    const retry = page.getByRole("button", {
      name: "Retry history",
      exact: true,
    });
    await expect(retry).toBeVisible();
    server.publishTyping(person.user_id);
    await expect(typing).toBeHidden();
    denyMembers = false;
    gate = heldResponse();
    gates.push(gate);
    await retry.click();
    await gate.entered;
    server.publishTyping(person.user_id);
    await page.clock.runFor(100);
    await expect(typing).toBeHidden();
    gate.release();
    gate = null;
    await expect(typing).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeEnabled();
    server.publishTyping(person.user_id);
    await expect(typing).toContainText(person.display_name);
    const remaining = server.members.filter(
      (member) => member.user_id !== person.user_id,
    );
    await page.route(
      `**/api/comms/conversations/${server.room}/members?**`,
      (route) => route.fulfill({ json: pageOf(remaining, { limit: 100 }) }),
    );
    const membershipRead = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
        `/api/comms/conversations/${server.room}/members`,
    );
    server.setPosting(true);
    await (await membershipRead).finished();
    await page.getByRole("button", { name: "Members", exact: true }).click();
    const members = page.getByRole("region", {
      name: "Members with access",
      exact: true,
    });
    await expect(members).toBeVisible();
    const next = remaining.find(
      (member) => member.user_id !== defaultSignedInIdentity.id,
    )!;
    await expect(
      members.getByRole("button", {
        name: `Person card: ${next.display_name}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      members.getByRole("button", {
        name: `Person card: ${person.display_name}`,
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(typing).toBeEmpty();
    server.publishTyping(person.user_id);
    server.publishTyping(next.user_id);
    await expect(typing).toContainText(next.display_name);
    await expect(typing).not.toContainText(person.display_name);
    await page
      .getByRole("button", { name: "Close members", exact: true })
      .click();
    await page.getByRole("button", { name: "Inbox", exact: true }).click();
    await expect(typing).toHaveCount(0);
    await page.getByRole("button", { name: /^live-operations(,|$)/ }).click();
    await expect(typing).toBeEmpty();
  } finally {
    for (const gate of gates) gate.release();
    await page.close();
    server.close();
  }
});

test("presence snapshots and events update avatars members and the authorized person card", async ({
  page,
}) => {
  const server = await installCommsLiveApi(page);
  const person = server.members.find(
    (member) => member.user_id !== defaultSignedInIdentity.id,
  )!;
  server.setPresence(person.user_id, "online");
  await page.route(`**/api/users/${person.user_id}/card`, (route) =>
    route.fulfill({
      json: {
        display_name: person.display_name,
        job_title: "Operator",
        avatar_url: null,
        email: null,
        phone: null,
        bio: null,
      },
    }),
  );
  try {
    await page.goto("/comms?panel=members");
    const members = page.getByRole("region", {
      name: "Members with access",
      exact: true,
    });
    const online = members.getByRole("region", {
      name: "Online members",
      exact: true,
    });
    await expect(online).toContainText(person.display_name);
    const trigger = online.getByRole("button", {
      name: `Person card: ${person.display_name}`,
      exact: true,
    });
    await expect(
      trigger.getByRole("img", { name: "Online", exact: true }),
    ).toBeVisible();
    await trigger.click();
    const card = page.getByRole("dialog", { name: "Person card", exact: true });
    await expect(card.getByText("Online", { exact: true })).toBeVisible();
    server.setPresence(person.user_id, "away");
    await expect(card.getByText("Away", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      members.getByRole("region", { name: "Away members", exact: true }),
    ).toContainText(person.display_name);
    server.setPresence(
      person.user_id,
      "online",
      "98000000-0000-4000-8000-000000000098",
    );
    await expect(
      members.getByRole("region", { name: "Away members", exact: true }),
    ).toContainText(person.display_name);
    await page.route(`**/api/users/${person.user_id}/card`, (route) =>
      route.fulfill({ status: 403, json: { detail: "Unavailable" } }),
    );
    await members
      .getByRole("button", {
        name: `Person card: ${person.display_name}`,
        exact: true,
      })
      .click();
    await card
      .getByRole("button", { name: "Reload person card", exact: true })
      .click();
    await expect(card.getByRole("alert")).toContainText("Person unavailable");
    await expect(card.getByText("Away", { exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    let denied = true;
    await page.route("**/api/comms/presence?**", (route) =>
      denied
        ? route.fulfill({ status: 403, json: { detail: "Unavailable" } })
        : route.fallback(),
    );
    // A presence event only patches the shown state; the repair after a
    // grants change reads the open conversation again, and a presence
    // refusal conceals that conversation and its members.
    server.setPresence(person.user_id, "online");
    await expect(
      members.getByRole("region", { name: "Online members", exact: true }),
    ).toContainText(person.display_name);
    server.publishAuthorizationChange("grants");
    await expect(members).toBeHidden();
    await expect(
      page.getByText("This conversation is not available.", { exact: true }),
    ).toBeVisible();
    denied = false;
    server.setPresence(person.user_id, "offline");
    await page
      .getByRole("button", { name: "Retry history", exact: true })
      .click();
    await expect(
      members.getByRole("region", { name: "Offline members", exact: true }),
    ).toContainText(person.display_name);
  } finally {
    await page.close();
    server.close();
  }
});

test("typing dots stop for device and account reduced motion without hiding the names", async ({
  page,
}) => {
  const server = await installCommsLiveApi(page);
  const person = server.members.find(
    (member) => member.user_id !== defaultSignedInIdentity.id,
  )!;
  try {
    await page.goto("/comms");
    await expect(
      page.getByRole("status", {
        name: "Conversation connection",
        exact: true,
      }),
    ).toContainText("Live");
    const typing = page.getByRole("status", {
      name: "Typing activity",
      exact: true,
    });
    await expect(typing).toBeVisible();
    server.publishTyping(person.user_id);
    await expect(typing).toContainText(person.display_name);
    const dots = typing.getByLabel("Typing dots");
    await expect(dots).toHaveCSS("animation-name", "pulse");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(dots).toHaveCSS("animation-name", "none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(
      () => (document.documentElement.dataset.motion = "reduced"),
    );
    await expect(dots).toHaveCSS("animation-name", "none");
    await expect(typing).toContainText(person.display_name);
  } finally {
    await page.close();
    server.close();
  }
});
