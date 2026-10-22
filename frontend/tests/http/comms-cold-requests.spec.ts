import {
  expect,
  test,
  defaultSignedInIdentity,
  signedInAs,
  heldResponse,
  settleReact,
} from "./helpers/test";
import { installCommsLiveApi } from "./helpers/comms-live-api";

// Every `/api/*` request of one cold `/comms` load on the production export,
// shell included, by method and path. `comms-query-loading` owns which Comms
// reads may repeat; this spec owns the whole load's total.
test("a cold Comms load sends each shell read once and repeats only by design", async ({
  page,
}, testInfo) => {
  await signedInAs(page, { id: defaultSignedInIdentity.id, role: "admin" });
  const calls: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/"))
      calls.push(`${request.method()} ${url.pathname}`);
  });
  const server = await installCommsLiveApi(page, { role: "admin" });
  const room = `/api/comms/conversations/${server.room}`;
  const category =
    "/api/comms/settings/category/c0440000-0000-4000-8000-000000000008";
  const channel = `/api/comms/settings/channel/${server.room}`;
  // The heartbeat receipt repairs the bootstrap (and any open history) by
  // design, at a time that races the cold read; it stays held, so it adds no
  // read here. The join is held until the cold reads settle, so its one
  // documented repair re-reads each Comms read exactly once.
  const heartbeat = heldResponse();
  await page.route("**/api/comms/presence", async (route) => {
    if (route.request().method() === "POST") await heartbeat.released;
    return route.fallback();
  });
  const token = heldResponse();
  await page.route("**/api/realtime/token", async (route) => {
    token.enter();
    await token.released;
    return route.fallback();
  });
  const counts = () => {
    const result: Record<string, number> = {};
    for (const call of calls) result[call] = (result[call] ?? 0) + 1;
    return result;
  };
  // Cold read + join repair: 2. Shell reads: 1, except where noted.
  const expected = {
    "GET /api/auth/session": 1,
    "GET /api/workspace/appearance": 1,
    "GET /api/auth/me": 1,
    "GET /api/users/00000000-0000-4000-8000-000000000001/preferences": 1,
    "GET /api/notifications": 1,
    // The shell count is read again when the event stream connects (resync).
    "GET /api/notifications/unread-count": 2,
    // Brand, read again on the stream's resync; then the calendar once.
    "GET /api/workspace": 3,
    "GET /api/departments": 1,
    "GET /api/comms/bootstrap": 2,
    "GET /api/comms/preferences": 2,
    "GET /api/comms/capabilities/channel-creation": 2,
    "GET /api/comms/settings/workspace": 2,
    "GET /api/comms/settings/workspace/capabilities": 2,
    // Open and archived threads are two reads.
    "GET /api/comms/threads": 4,
    "GET /api/comms/search": 2,
    [`GET ${category}`]: 2,
    [`GET ${category}/capabilities`]: 2,
    [`GET ${channel}`]: 2,
    [`GET ${channel}/capabilities`]: 2,
    [`GET ${room}/capabilities`]: 2,
    [`GET ${room}/members`]: 2,
    [`GET ${room}/pins`]: 2,
    // Presence follows each members read.
    "GET /api/comms/presence": 2,
    // The first page, then the repair's newer tail and its re-read range.
    [`GET ${room}/messages`]: 3,
    [`PUT ${room}/read`]: 1,
    "POST /api/comms/presence": 1,
    "POST /api/realtime/token": 1,
  };
  try {
    await page.goto("/comms");
    await expect(
      page.getByText("Live message 59", { exact: true }),
    ).toBeVisible();
    await token.entered;
    await expect.poll(() => counts()["GET /api/comms/search"] ?? 0).toBe(1);
    await settleReact(page);
    token.release();
    await expect(
      page
        .getByRole("status", { name: "Conversation connection", exact: true })
        .getByText("Live", { exact: true }),
    ).toBeVisible();
    await expect.poll(counts).toEqual(expected);
    await settleReact(page);
    expect(counts()).toEqual(expected);
    expect(calls).toHaveLength(49);
  } finally {
    token.release();
    heartbeat.release();
    await testInfo.attach("cold requests", {
      body: JSON.stringify(calls),
      contentType: "application/json",
    });
    await page.close();
    server.close();
  }
});
