import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import { test, expect } from "../coverage";
import { mountRealtimeProvider } from "../../helpers/realtime-provider-harness";
const token = (expiry: number) =>
  `header.${Buffer.from(JSON.stringify({ exp: expiry })).toString("base64url")}.signature`;

test("private subscription forwards invalidations and cleans up on unmount", async ({
  page,
}) => {
  const access = token(Math.floor(Date.now() / 1000) + 3600);
  await mountRealtimeProvider(page, access);
  await expect
    .poll(() =>
      page.evaluate(() => window.realtimeHarness.state.subscriptions.length),
    )
    .toBe(1);
  expect(
    await page.evaluate(() => window.realtimeHarness.state.subscriptions),
  ).toEqual([
    {
      name: "openslate:invalidation",
      options: {
        config: { private: true, broadcast: { ack: false, self: false } },
      },
    },
  ]);
  expect(await page.evaluate(() => window.realtimeHarness.state.auth)).toEqual([
    access,
  ]);
  await page.evaluate(() =>
    window.realtimeHarness.broadcast({ resource: "records" }),
  );
  expect(
    await page.evaluate(() => window.realtimeHarness.state.events),
  ).toEqual([{ resource: "records" }]);
  await page.evaluate(() => window.realtimeHarness.unmount());
  expect(
    await page.evaluate(() => window.realtimeHarness.state.removed),
  ).toEqual(["openslate:invalidation"]);
});

test("tokens are cached and cross-tab invalidation clears channels without rebroadcasting", async ({
  page,
}) => {
  await mountRealtimeProvider(page, "malformed-token");
  expect(await page.evaluate(() => window.realtimeHarness.token())).toBe(
    "malformed-token",
  );
  expect(await page.evaluate(() => window.realtimeHarness.state.requests)).toBe(
    1,
  );
  await page.evaluate(() =>
    window.realtimeHarness.receive({ type: "unrelated" }),
  );
  expect(await page.evaluate(() => window.realtimeHarness.state.cleared)).toBe(
    0,
  );
  await page.evaluate(() =>
    window.realtimeHarness.receive({ type: "session-invalidated" }),
  );
  expect(await page.evaluate(() => window.realtimeHarness.state.cleared)).toBe(
    1,
  );
  expect(
    await page.evaluate(() => window.realtimeHarness.state.broadcasts),
  ).toEqual([]);
  await page.evaluate(() => window.realtimeHarness.token());
  expect(await page.evaluate(() => window.realtimeHarness.state.requests)).toBe(
    2,
  );
  await page.evaluate(() => window.realtimeHarness.invalidate());
  expect(
    await page.evaluate(() => window.realtimeHarness.state.broadcasts),
  ).toEqual([{ type: "session-invalidated" }]);
});

test("near-expiry token renewal updates realtime authentication", async ({
  page,
}) => {
  await mountRealtimeProvider(page, token(Math.floor(Date.now() / 1000) + 150));
  await expect
    .poll(() => page.evaluate(() => window.realtimeHarness.state.auth.length))
    .toBe(1);
  const renewed = token(Math.floor(Date.now() / 1000) + 3600);
  await page.evaluate((renewed) => {
    window.realtimeHarness.state.token = renewed;
  }, renewed);
  await page.clock.fastForward(60_000);
  await expect
    .poll(() => page.evaluate(() => window.realtimeHarness.state.auth.at(-1)))
    .toBe(renewed);
});

test("unauthorized refresh invalidates channels while unavailable or malformed tokens remain unusable", async ({
  page,
}) => {
  await mountRealtimeProvider(page, "initial-token");
  await expect
    .poll(() => page.evaluate(() => window.realtimeHarness.state.auth.length))
    .toBe(1);
  await page.evaluate(() => {
    window.realtimeHarness.invalidate();
    window.realtimeHarness.state.status = 401;
  });
  expect(await page.evaluate(() => window.realtimeHarness.token())).toBeNull();
  expect(await page.evaluate(() => window.realtimeHarness.state.cleared)).toBe(
    2,
  );
  await page.evaluate(() => {
    window.realtimeHarness.state.status = 503;
  });
  expect(await page.evaluate(() => window.realtimeHarness.token())).toBeNull();
  expect(await page.evaluate(() => window.realtimeHarness.state.cleared)).toBe(
    2,
  );
  await page.evaluate(() => {
    window.realtimeHarness.state.status = 200;
    window.realtimeHarness.state.token = "";
  });
  expect(await page.evaluate(() => window.realtimeHarness.token())).toBeNull();
});

test("provider coverage maps the Function wrapper to the original source line", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Chromium CDP source-map contract");
  const debuggerSession = await page.context().newCDPSession(page);
  await debuggerSession.send("Debugger.enable");
  let providerScript:
    { scriptId: string; sourceMapURL?: string; url: string } | undefined;
  debuggerSession.on("Debugger.scriptParsed", (script) => {
    if (script.url.endsWith("/src/components/realtime-provider.tsx"))
      providerScript = script;
  });
  await mountRealtimeProvider(page, "mapping-token");
  if (!providerScript?.sourceMapURL)
    throw new Error("Provider inline source map missing");
  const { scriptSource } = await debuggerSession.send(
    "Debugger.getScriptSource",
    { scriptId: providerScript.scriptId },
  );
  const map = new TraceMap(
    JSON.parse(
      Buffer.from(
        providerScript.sourceMapURL.split(",")[1],
        "base64",
      ).toString(),
    ),
  );
  const source = map.sourcesContent?.[0];
  if (!source) throw new Error("Provider original source missing");
  const expression = "tokenRef.current = body.access_token";
  const generated = scriptSource.split("\n");
  const generatedIndex = generated.findIndex((line) =>
    line.includes(expression),
  );
  expect(generatedIndex).toBeGreaterThan(0);
  const original = originalPositionFor(map, {
    line: generatedIndex + 1,
    column: generated[generatedIndex].indexOf("tokenRef.current"),
  });
  expect(original.line).toBe(
    source.split("\n").findIndex((line) => line.includes(expression)) + 1,
  );
  expect(new URL(original.source!, providerScript.url).protocol).toBe("file:");
  await debuggerSession.detach();
});
