import { expect, test } from "@playwright/test";
import { z } from "zod";

import {
  nextBannerState,
  ServerConnectionAnnouncer,
  ServerConnectionAnnouncerView,
  ServerConnectionBannerView,
} from "../../../src/components/server-connection-banner";
import { apiFetch, refreshBrowserSession } from "../../../src/lib/api";
import {
  getServerConnection,
  noteServerResponse,
  startServerRetry,
  type RetryTimers,
} from "../../../src/lib/server-connection";
import { installFetch } from "../helpers/fake-fetch";
import { staticMarkup } from "../sandbox/static-markup";

// The shell banner (docs/specs/system-health.md, S2-C7 and D3): when it
// shows, when it clears, how it retries on its own, and what it says.

const schema = z.object({ ok: z.boolean() });
const answered = (status = 200) =>
  new Response(JSON.stringify({ ok: true }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Request-ID": "019a4c2e-7b1d-7c3e-9f00-4f9c2e1a0b2c",
    },
  });

async function request(response: () => Response | Promise<Response>) {
  const fetchStub = installFetch(response);
  try {
    await apiFetch("/things", schema, { refreshOnUnauthorized: false });
  } catch {
    // The failing control shows its own error; only the banner state matters.
  } finally {
    fetchStub.restore();
  }
}

test.beforeEach(() => {
  noteServerResponse(answered());
});

test("a request that gets no answer shows the banner, and the next answer clears it", async () => {
  await request(() => Promise.reject(new TypeError("Failed to fetch")));
  expect(getServerConnection()).toBe("unreachable");
  // Any status from the server proves that it answers.
  await request(() => answered(404));
  expect(getServerConnection()).toBe("reachable");
});

test("an aborted request never shows the banner", async () => {
  await request(() =>
    Promise.reject(
      new DOMException("The user aborted a request.", "AbortError"),
    ),
  );
  expect(getServerConnection()).toBe("reachable");
});

test("a 500, 502 or 504 with no request ID shows the banner; other answers do not", async () => {
  for (const status of [500, 502, 504]) {
    noteServerResponse(answered());
    await request(() => new Response("Bad gateway", { status }));
    expect(getServerConnection(), `status ${status}`).toBe("unreachable");
  }
  // Something answers: a concurrency 503, a proxy 400 or 404.
  for (const status of [503, 400, 404]) {
    noteServerResponse(answered());
    await request(() => new Response("Busy", { status }));
    expect(getServerConnection(), `status ${status}`).toBe("reachable");
  }
  // A 500 from the server itself carries its ID: the server answers.
  await request(() => new Response("Bad gateway", { status: 502 }));
  await request(() => answered(500));
  expect(getServerConnection()).toBe("reachable");
});

test("a session refresh that gets no answer shows the banner too", async () => {
  const fetchStub = installFetch(() =>
    Promise.reject(new TypeError("Failed to fetch")),
  );
  try {
    // An activity renewal tries once, so the test does not wait on retries.
    await refreshBrowserSession({
      userId: "00000000-0000-4000-8000-000000000001",
      signal: new AbortController().signal,
    });
  } finally {
    fetchStub.restore();
  }
  expect(getServerConnection()).toBe("unreachable");
});

/** Timers that run only when the test says so. */
function manualTimers() {
  let now = 0;
  const pending = new Map<number, { at: number; run: () => void }>();
  let nextId = 1;
  const timers: RetryTimers = {
    set(run, delay) {
      const id = nextId++;
      pending.set(id, { at: now + delay, run });
      return id;
    },
    clear(id) {
      pending.delete(id);
    },
  };
  return {
    timers,
    now: () => now,
    pendingDelays: () => [...pending.values()].map((entry) => entry.at - now),
    /** Moves time forward to the next timer and runs it. */
    advance() {
      const [id, entry] = [...pending.entries()].sort(
        (a, b) => a[1].at - b[1].at,
      )[0];
      pending.delete(id);
      now = entry.at;
      entry.run();
    },
  };
}

test("the retry asks the server after 5, 10 and 20 seconds, then every 30 seconds", () => {
  const clock = manualTimers();
  const probes: number[] = [];
  const retry = startServerRetry({
    probe: () => probes.push(clock.now()),
    timers: clock.timers,
  });
  for (let index = 0; index < 5; index += 1) clock.advance();
  expect(probes).toEqual([5_000, 15_000, 35_000, 65_000, 95_000]);
  retry.stop();
  expect(clock.pendingDelays()).toEqual([]);
});

test("the retry pauses while the tab is hidden and asks at once when it returns", () => {
  const clock = manualTimers();
  let probes = 0;
  const retry = startServerRetry({
    probe: () => (probes += 1),
    timers: clock.timers,
  });
  retry.pause();
  expect(clock.pendingDelays()).toEqual([]);
  // Visible again, focus, or `online`: one request now, then the schedule.
  retry.wake();
  expect(probes).toBe(1);
  expect(clock.pendingDelays()).toEqual([10_000]);
  retry.stop();
});

function banner(state: Parameters<typeof ServerConnectionBannerView>[0]) {
  return staticMarkup(ServerConnectionBannerView, state).replace(
    / class="[^"]*"/g,
    "",
  );
}

test("the banner says the server cannot be reached, as a polite status with no control", () => {
  const markup = banner({ state: "showing" });
  expect(markup).toContain('role="status"');
  expect(markup).toContain('aria-atomic="true"');
  expect(markup).toContain(
    "Slate Operations cannot reach its server. Changes you make now may not save. It tries again on its own.",
  );
  expect(markup).not.toMatch(/<button|<a |tabindex/);
});

test("the status region stays in the page, empty, until the banner shows", () => {
  expect(banner({ state: "hidden" })).toBe(
    '<div role="status" aria-atomic="true"></div>',
  );
});

test("when the server answers again, only screen readers hear it", () => {
  const markup = banner({ state: "recovered" });
  expect(markup).toContain(
    "<span>Slate Operations can reach its server again.</span>",
  );
  expect(markup).not.toContain("cannot reach");
  // The visible band is gone; the sentence is screen-reader text.
  expect(
    staticMarkup(ServerConnectionBannerView, { state: "recovered" }),
  ).toContain('class="sr-only"');
});

// D4 item 11: under a modal, a hidden announcer speaks the banner's changes.
test("a modal's announcer is hidden and empty until the connection changes", async () => {
  const view = (state: Parameters<typeof nextBannerState>[0]) =>
    staticMarkup(ServerConnectionAnnouncerView, { state });
  expect(view("hidden")).toBe(
    '<span role="status" aria-atomic="true" class="sr-only"></span>',
  );
  expect(view("showing")).toContain(
    ">Slate Operations cannot reach its server. Changes you make now may not save. It tries again on its own.<",
  );
  expect(view("recovered")).toContain(
    ">Slate Operations can reach its server again.<",
  );
  // It speaks changes only: a change to unreachable shows, an answer after
  // that recovers, an answer with nothing shown stays silent.
  expect(nextBannerState("hidden", "unreachable")).toBe("showing");
  expect(nextBannerState("showing", "reachable")).toBe("recovered");
  expect(nextBannerState("hidden", "reachable")).toBe("hidden");
  // A modal opened while the server is unreachable starts quiet (the person
  // heard the banner before) and still says when the server answers again.
  expect(nextBannerState("quiet", "reachable")).toBe("recovered");
  expect(view("quiet")).toBe(
    '<span role="status" aria-atomic="true" class="sr-only"></span>',
  );
  // Never at mount: a modal opened while the server is unreachable starts
  // empty, because the person heard the banner before.
  await request(() => Promise.reject(new TypeError("Failed to fetch")));
  expect(getServerConnection()).toBe("unreachable");
  expect(staticMarkup(ServerConnectionAnnouncer, {})).toBe(
    '<span role="status" aria-atomic="true" class="sr-only"></span>',
  );
  await request(() => answered());
  expect(getServerConnection()).toBe("reachable");
});
