import {
  expect,
  test,
  signedInAs,
  defaultSignedInIdentity,
  defaultOrganization,
  heldResponse,
  recheckSession,
} from "./helpers/test";
import { installCommsLiveApi } from "./helpers/comms-live-api";
import type { LiveMessage } from "../../src/components/systems/comms/contract/types";

test("late and later-page authors use current authorized metadata without per-message reads or stale role data", async ({
  page,
}) => {
  const actor = defaultSignedInIdentity.id;
  const late = "98000000-0000-4000-8000-000000000071";
  const hidden = "98000000-0000-4000-8000-000000000072";
  const messages: LiveMessage[] = [];
  await signedInAs(page, { id: actor, role: "member" });
  const server = await installCommsLiveApi(page, {
    role: "member",
    messageStore: messages,
  });
  const servers = [server];
  messages[4].author_id = late;
  messages[5].author_id = hidden;
  let role: "member" | "guest" = "member";
  let status = 200;
  let gate: ReturnType<typeof heldResponse> | null = heldResponse();
  const gates = [gate];
  const reads: { id: string; org: string | undefined; role: string }[] = [];
  const forbidden: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/users" || path === "/api/comms/direct-candidates")
      forbidden.push(path);
  });
  await page.route("**/api/users/*/card", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/")[3];
    reads.push({ id, org: route.request().headers()["x-org"], role });
    if (id === hidden)
      return route.fulfill({
        status: 404,
        json: { detail: "Hidden foreign profile must not render" },
      });
    if (id === late && gate) {
      const held = gate;
      held.enter();
      await held.released;
    }
    if (id === late && status !== 200)
      return route.fulfill({
        status,
        json: { detail: "Private identity is unavailable" },
      });
    const name =
      id === late
        ? "Late arrival"
        : server.members.find((member) => member.user_id === id)?.display_name;
    if (!name)
      return route.fulfill({ status: 404, json: { detail: "Unavailable" } });
    return route.fulfill({
      headers: { "Cache-Control": "private, no-store" },
      json: {
        display_name: name,
        job_title: "Operator",
        avatar_url: id === late ? `/api/users/${late}/avatar` : null,
        ...(role === "member"
          ? { email: "late@example.test", phone: null, bio: null }
          : {}),
      },
    });
  });
  await page.route(
    (url) => url.pathname === `/api/users/${late}/avatar`,
    (route) =>
      route.fulfill({
        contentType: "image/png",
        headers: {
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1cAAAAASUVORK5CYII=",
          "base64",
        ),
      }),
  );
  try {
    await page.goto("/comms");
    await expect(
      page.getByText("Live message 59", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("status", {
        name: "Conversation connection",
        exact: true,
      }),
    ).toContainText("Live");
    expect(reads.filter((read) => read.id === late)).toHaveLength(0);
    const first = server.appendQuietly();
    first.author_id = late;
    server.publishEdit(first.seq, "A late member reply");
    await expect
      .poll(() => reads.filter((read) => read.id === late).length)
      .toBe(1);
    await gate!.entered;
    await expect(
      page.getByRole("button", {
        name: "Person card: Late arrival",
        exact: true,
      }),
    ).toHaveCount(0);
    gate!.release();
    gate = null;
    const current = page.getByRole("article", {
      name: /^Message 60: Late arrival,/,
    });
    await expect(current).toBeVisible();
    await expect(current.locator("img")).toBeVisible();
    const second = server.appendQuietly();
    second.author_id = late;
    server.publishEdit(second.seq, "Another late member reply");
    await expect(
      page.getByRole("article", { name: /^Message 61: Late arrival,/ }),
    ).toBeVisible();
    expect(reads.filter((read) => read.id === late)).toHaveLength(1);
    await page
      .getByRole("button", { name: "Load older messages", exact: true })
      .click();
    await page.getByRole("region", { name: "Messages", exact: true }).hover();
    await page.mouse.wheel(0, -100000);
    const older = page.getByRole("article", {
      name: /^Message 5: Late arrival,/,
    });
    await expect(older).toBeVisible();
    await expect(
      page.getByRole("article", { name: /^Message 6: Unavailable person,/ }),
    ).toBeVisible();
    expect(reads.filter((read) => read.id === late)).toHaveLength(1);
    await expect(
      page.getByText("Hidden foreign profile must not render"),
    ).toHaveCount(0);
    await older
      .getByRole("button", { name: "Person card: Late arrival", exact: true })
      .click();
    const card = page.getByRole("dialog", { name: "Person card", exact: true });
    await expect(
      card.getByText("late@example.test", { exact: true }),
    ).toBeVisible();
    await expect(
      card.getByRole("img", { name: "Late arrival photo", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Jump to latest", exact: true })
      .click();
    await expect(current).toBeVisible();
    role = "guest";
    await signedInAs(page, { id: actor, role });
    servers.push(
      await installCommsLiveApi(page, { role, messageStore: messages }),
    );
    gate = heldResponse();
    gates.push(gate);
    await recheckSession(page);
    await gate.entered;
    await expect(
      page.getByText("late@example.test", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: "Person card: Late arrival",
        exact: true,
      }),
    ).toHaveCount(0);
    gate.release();
    gate = null;
    await expect(current).toBeVisible();
    await current
      .getByRole("button", { name: "Person card: Late arrival", exact: true })
      .click();
    await expect(card.getByText("Email", { exact: true })).toHaveCount(0);
    await expect(
      card.getByRole("img", { name: "Late arrival photo", exact: true }),
    ).toBeVisible();
    status = 404;
    await card
      .getByRole("button", { name: "Reload person card", exact: true })
      .click();
    const unavailable = page.getByRole("article", {
      name: /^Message 60: Unavailable person,/,
    });
    await expect(unavailable).toContainText("Unavailable person");
    await expect(
      page.getByRole("button", {
        name: "Person card: Late arrival",
        exact: true,
      }),
    ).toHaveCount(0);
    const refusedReads = reads.filter((read) => read.id === late).length;
    server.publishEdit(second.seq, "Reply after metadata refusal");
    await expect(
      page.getByText("Reply after metadata refusal", { exact: true }),
    ).toBeVisible();
    expect(reads.filter((read) => read.id === late)).toHaveLength(refusedReads);
    status = 200;
    await unavailable
      .getByRole("button", { name: "Retry person card", exact: true })
      .click();
    await expect(current).toBeVisible();
    expect(reads.every((read) => read.org === defaultOrganization.org_id)).toBe(
      true,
    );
    expect(forbidden).toEqual([]);
  } finally {
    for (const held of gates) held.release();
    await page.close();
    for (const value of servers) value.close();
  }
});
