import { randomUUID } from "node:crypto";
import { expect, type Page, type WebSocketRoute } from "@playwright/test";
import {
  api,
  articleWith,
  commsTest,
  focusRoom,
  ingest,
  object,
  observe,
  paced,
  proofRecorder,
  send,
  showRoom,
  type Account,
  type Observations,
} from "./comms-fixture";

// Plan section-6 bounds measured against real services: send-to-visible p95, typing,
// ordered recovery after a dropped link, offline within 150 s of the last heartbeat,
// and id-only events stopping within the 5-minute Realtime token lifetime. These need
// long real-time waits, so this one file holds them (scripts/assertion_guard.py exempts
// only its long timeouts); the functional journey is comms-two-account.spec.ts.
const test = commsTest({
  slug: "measured",
  member: "S32 Measured Member",
  room: "s32-measured",
  lobby: "s32-measured-lobby",
  isolated: "s32-measured-isolated",
});
test.use({
  trace: "off",
  screenshot: "off",
  video: "off",
  actionTimeout: 15_000,
  navigationTimeout: 30_000,
});

// Wall-clock time from just before an action until a receiving page renders a marker.
async function visibleAfter(receiver: Page, marker: string, started: number) {
  await receiver.waitForFunction(
    (value) =>
      [...document.querySelectorAll("article")].some((node) =>
        node.textContent?.includes(value),
      ),
    marker,
    { polling: "raf", timeout: 15_000 },
  );
  return Date.now() - started;
}

function distribution(values: number[]) {
  const rows = [...values].sort((a, b) => a - b);
  return {
    n: rows.length,
    p95: rows[Math.ceil(rows.length * 0.95) - 1],
    median: rows[Math.floor(rows.length / 2)],
    min: rows[0],
    max: rows.at(-1),
  };
}

test.setTimeout(1_200_000);
test("real invited accounts meet the Comms latency, offline and revocation bounds", async ({
  comms,
}) => {
  const { fixture: owned, admin, member, room } = comms;
  const origin = owned.baseURL;
  const { proof, step, finish } = proofRecorder(
    owned.runId,
    "measurements.json",
  );
  const reset = (account: Account) => showRoom(account, comms.names.room, room);
  const reload = (account: Account) =>
    focusRoom(account, origin, comms.names.room, room);
  const sends = { [admin.id]: [] as number[], [member.id]: [] as number[] };

  await step("typing shows on the other screen within 1000 ms", async () => {
    await reset(admin);
    await reset(member);
    const indicator = admin.page.getByRole("status", {
      name: "Typing activity",
      exact: true,
    });
    const composer = member.page.getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    const samples: number[] = [];
    // The server admits one typing signal per person and conversation every 2 s.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    for (let sample = 0; sample < 3; sample += 1) {
      await expect(indicator.filter({ hasText: member.name })).toHaveCount(0, {
        timeout: 20_000,
      });
      const started = Date.now();
      await composer.fill(`typing ${sample} ${owned.runId}`);
      await expect(indicator).toContainText(`${member.name} is typing`);
      samples.push(Date.now() - started);
      await composer.fill("");
    }
    expect(Math.max(...samples)).toBeLessThanOrEqual(1000);
    return { typingToVisibleMs: samples };
  });

  await step("send-to-visible p95 at most 1000 ms over 50 sends", async () => {
    await reset(admin);
    await reset(member);
    const samples: number[] = [];
    const missed: { index: number; seq: number; from: string }[] = [];
    for (let index = 0; index < 50; index += 1) {
      const [sender, receiver] = index % 2 ? [member, admin] : [admin, member];
      await paced(sends[sender.id]!);
      const marker = `Owned latency ${index} ${owned.runId}`;
      const started = Date.now();
      // A sample that never shows is recorded (as a miss) rather than aborting the series.
      const visible = visibleAfter(receiver.page, marker, started).catch(
        () => null,
      );
      const sent = await send(sender, room, marker);
      const ms = await visible;
      if (ms === null) missed.push({ index, seq: sent.seq, from: sender.name });
      else samples.push(ms);
    }
    const result = distribution(samples);
    proof.steps.push({
      name: "send-to-visible samples (recorded before assertions)",
      status: missed.length ? "failed" : "passed",
      ms: 0,
      data: { samplesMs: samples, missed, ...result },
    });
    expect(missed).toEqual([]);
    expect(result.p95).toBeLessThanOrEqual(1000);
    return { samplesMs: samples, missed, ...result };
  });

  await step(
    "connection drop during 5 sends recovers in order without duplicates",
    async () => {
      await reset(admin);
      const topic = `org:${member.orgId}:conversation:${room}`;
      // Route the member's Realtime socket so the test can sever it like a lost link.
      const routed: Observations = {
        sockets: 0,
        sse: false,
        sseStatuses: [],
        joined: new Set(),
        foreignTopic: false,
        closed: 0,
        messages: [],
      };
      const open: WebSocketRoute[] = [];
      let blocked = false;
      let refused = 0;
      await member.page.routeWebSocket(/\/realtime\/v1\/websocket/u, (ws) => {
        if (blocked) {
          refused += 1;
          void ws.close({ code: 4000, reason: "link down" });
          return;
        }
        const server = ws.connectToServer();
        routed.sockets += 1;
        open.push(ws, server);
        server.onMessage((message) => {
          ingest(routed, member.orgId, message);
          for (const joined of routed.joined) member.wire.joined.add(joined);
          ws.send(message);
        });
      });
      await reload(member);
      expect(routed.sockets).toBeGreaterThan(0);
      const socketsBefore = routed.sockets;
      blocked = true;
      const dropped = Date.now();
      await Promise.all(
        open
          .splice(0)
          .map((side) => side.close({ code: 4000, reason: "link down" })),
      );
      const seqs: number[] = [];
      const bodies: string[] = [];
      try {
        for (let index = 0; index < 5; index += 1) {
          await paced(sends[admin.id]!);
          const body = `Owned dropped ${index} ${owned.runId}`;
          bodies.push(body);
          seqs.push((await send(admin, room, body)).seq);
        }
      } finally {
        blocked = false;
      }
      const restored = Date.now();
      for (const body of bodies)
        await expect(articleWith(member, body)).toHaveCount(1, {
          timeout: 90_000,
        });
      const recoveredMs = Date.now() - restored;
      const order = await member.page.evaluate(
        (values) =>
          values.map((value) =>
            [...document.querySelectorAll("article")].findIndex((node) =>
              node.textContent?.includes(value),
            ),
          ),
        bodies,
      );
      expect(order.every((index) => index >= 0)).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      const frames = routed.messages.filter(
        (item) => item.topic === topic && seqs.includes(item.seq),
      );
      expect(new Set(frames.map((item) => item.seq)).size).toBe(frames.length);
      return {
        seqs,
        droppedForMs: restored - dropped,
        recoveredAfterLinkMs: recoveredMs,
        reconnectsRefusedWhileDown: refused,
        socketsAfterRecovery: routed.sockets - socketsBefore,
        liveFramesForDroppedSeqs: frames.length,
        recovery: frames.length ? "live frames" : "authorized gap-fill",
      };
    },
  );

  await step("offline shows within 150 s after the member leaves", async () => {
    const heartbeats: number[] = [];
    member.page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/comms/presence"
      )
        heartbeats.push(Date.now());
    });
    await reset(member);
    await admin.page.goto(`${origin}/comms?conversation=${room}&panel=members`);
    const pane = admin.page.getByRole("region", {
      name: "Members with access",
      exact: true,
    });
    await expect(
      pane.getByRole("region", { name: "Online members", exact: true }),
    ).toContainText(member.name);
    const lastHeartbeat = heartbeats.at(-1) ?? null;
    const closed = Date.now();
    await member.page.close();
    let apiOfflineMs: number | null = null;
    let uiOfflineMs: number | null = null;
    try {
      const offlineUi = expect(
        pane.getByRole("region", { name: "Offline members", exact: true }),
      )
        .toContainText(member.name, { timeout: 200_000 })
        .then(
          () => Date.now() - closed,
          () => null,
        );
      await expect
        .poll(
          async () => {
            const snapshot = await api(
              admin.page,
              admin.orgId,
              "GET",
              `/api/comms/presence?user_ids=${member.id}`,
            );
            const items = object(snapshot.payload).items;
            const state = Array.isArray(items) ? object(items[0]).state : null;
            if (state === "offline" && apiOfflineMs === null)
              apiOfflineMs = Date.now() - closed;
            return state;
          },
          { timeout: 200_000, intervals: [2000] },
        )
        .toBe("offline");
      uiOfflineMs = await offlineUi;
    } finally {
      // Later steps need the member back, whatever this measurement found.
      const reopened = await member.context.newPage();
      member.page = reopened;
      member.wire = observe(reopened, member.orgId, origin);
      await reload(member);
    }
    expect(uiOfflineMs).not.toBeNull();
    const fromHeartbeat =
      lastHeartbeat === null || uiOfflineMs === null
        ? null
        : uiOfflineMs + (closed - lastHeartbeat);
    expect(fromHeartbeat ?? uiOfflineMs ?? Infinity).toBeLessThanOrEqual(
      150_000,
    );
    return {
      closeToApiOfflineMs: apiOfflineMs,
      closeToUiOfflineMs: uiOfflineMs,
      lastHeartbeatToUiOfflineMs: fromHeartbeat,
    };
  });

  await step(
    "removed member: id-only events stop within the token lifetime",
    async () => {
      await reset(admin);
      await reset(member);
      const topic = `org:${member.orgId}:conversation:${room}`;
      const current = await api(
        admin.page,
        admin.orgId,
        "GET",
        `/api/comms/conversations/${room}`,
      );
      // Conversation ETag: quoted SHA-256 (conversations/service.py).
      expect(current.etag).toMatch(/^"[0-9a-f]{64}"$/u);
      const removed = await api(
        admin.page,
        admin.orgId,
        "DELETE",
        `/api/comms/conversations/${room}/access-grants/user/${member.id}`,
        undefined,
        { "If-Match": current.etag! },
      );
      expect(removed.status).toBe(204);
      const at = Date.now();
      const probes: { atMs: number; seq: number; delivered: boolean }[] = [];
      let misses = 0;
      while (misses < 3 && Date.now() - at < 330_000) {
        await paced(sends[admin.id]!);
        const response = await api(
          admin.page,
          admin.orgId,
          "POST",
          `/api/comms/conversations/${room}/messages`,
          {
            client_key: randomUUID(),
            body: `Owned revocation probe ${probes.length}`,
          },
        );
        expect(response.status).toBe(201);
        const seq = object(response.payload).seq as number;
        let delivered = true;
        try {
          await expect
            .poll(
              () =>
                member.wire.messages.some(
                  (item) => item.topic === topic && item.seq === seq,
                ),
              { timeout: 3000 },
            )
            .toBe(true);
        } catch {
          delivered = false;
        }
        probes.push({ atMs: Date.now() - at, seq, delivered });
        misses = delivered ? 0 : misses + 1;
        if (misses < 3)
          await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      const last = probes.filter((probe) => probe.delivered).at(-1);
      expect(misses).toBe(3);
      return {
        lastDeliveredProbeMs: last?.atMs ?? null,
        firstUndeliveredProbeMs:
          probes.find((probe) => !probe.delivered)?.atMs ?? null,
        probes,
      };
    },
  );

  expect(finish()).toEqual([]);
});
