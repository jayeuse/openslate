import { writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/test";
import { seedTimeline } from "./helpers/comms-timeline-fixture";

type Metrics = {
  dataAt: number | null;
  readyAt: number | null;
  renderedRows: number;
  newestVisible: boolean;
  tasks: { start: number; duration: number }[];
};
type MeasuredWindow = Window & { commsTimelineMeasurement: Metrics };
type ScrollWindow = Window & {
  commsScrollMeasurement: {
    start: number;
    from: number;
    delta: number;
    tasks: { start: number; duration: number }[];
    observer: PerformanceObserver;
  };
};
async function measureScroll(page: Page) {
  const viewport = page.getByLabel("Messages", { exact: true });
  await viewport.hover();
  await page.mouse.wheel(0, -100000);
  // Intrinsic heights overestimate the 50-row range before layout. Load a real
  // older page so the measured wheel gesture has 3,000 px of actual history.
  await page
    .getByRole("button", { name: "Load older messages", exact: true })
    .click();
  await expect(viewport.getByRole("article").first()).toHaveAttribute(
    "aria-setsize",
    "100",
  );
  await viewport.hover();
  await page.mouse.wheel(0, 1000000);
  await expect
    .poll(() =>
      viewport.evaluate(
        (node) => node.scrollHeight - node.scrollTop - node.clientHeight,
      ),
    )
    .toBeLessThan(1);
  await viewport.evaluate((node) => {
    const tasks: { start: number; duration: number }[] = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        tasks.push({ start: entry.startTime, duration: entry.duration });
    });
    observer.observe({ type: "longtask" });
    const state = {
      start: performance.now(),
      from: node.scrollTop,
      delta: 0,
      tasks,
      observer,
    };
    (window as unknown as ScrollWindow).commsScrollMeasurement = state;
    node.addEventListener(
      "wheel",
      (event) => {
        if (event instanceof WheelEvent) state.delta += event.deltaY;
      },
      { once: true, passive: true },
    );
  });
  await page.mouse.wheel(0, -3000);
  try {
    await expect(
      page.getByRole("button", { name: "Jump to latest", exact: true }),
    ).toBeVisible();
  } catch (error) {
    console.info(
      "SCROLL-DIAGNOSTIC",
      await viewport.evaluate((node) => ({
        measured: {
          ...(window as unknown as ScrollWindow).commsScrollMeasurement,
          observer: undefined,
        },
        scrollTop: node.scrollTop,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
        attributes: [...node.attributes].map(({ name, value }) => [
          name,
          value,
        ]),
        rows: [...node.querySelectorAll("article")]
          .slice(-2)
          .map((row) => ({ id: row.id, top: row.getBoundingClientRect().top })),
      })),
    );
    throw error;
  }
  await expect(viewport).toHaveAttribute("aria-busy", "false");
  return viewport.evaluate(async (node) => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const state = (window as unknown as ScrollWindow).commsScrollMeasurement;
    for (const entry of state.observer.takeRecords())
      state.tasks.push({ start: entry.startTime, duration: entry.duration });
    state.observer.disconnect();
    return {
      requested_pixels: 3000,
      wheel_delta_pixels: state.delta,
      observed_scroll_delta: state.from - node.scrollTop,
      rendered_rows: node.querySelectorAll("article").length,
      elapsed_ms: performance.now() - state.start,
      long_tasks: state.tasks.filter(
        (task) =>
          task.start + task.duration > state.start && task.duration > 50,
      ),
    };
  });
}
test.use({ viewport: { width: 1440, height: 900 }, trace: "off" });
test.describe.configure({ mode: "default" });

const openingDiagnostic = process.env.COMMS_OPENING_DIAGNOSTIC === "1";
for (const mode of openingDiagnostic
  ? ["traced opening", "unprofiled opening"]
  : ["timeline"]) {
  test(`Comms 5000-message timeline records after-data readiness and 3000px scroll at 4x CPU (${mode})`, async ({
    page,
    browser,
  }, testInfo) => {
    const fixture = await seedTimeline(page);
    const progress: unknown[] = [];
    page.on("console", (message) => {
      if (message.text().startsWith("S07-PROFILE "))
        progress.push(JSON.parse(message.text().slice(12)));
    });
    page.on("pageerror", (error) =>
      console.info("Browser error:", error.message),
    );
    await page.addInitScript(({ newest, newest50 }) => {
      performance.mark("comms-clock-origin", {
        detail: {
          timeOrigin: performance.timeOrigin,
          now: performance.now(),
          dateNow: Date.now(),
        },
      });
      const metrics: Metrics = {
        dataAt: null,
        readyAt: null,
        renderedRows: 0,
        newestVisible: false,
        tasks: [],
      };
      (window as unknown as MeasuredWindow).commsTimelineMeasurement = metrics;
      new PerformanceObserver((list) => {
        for (const task of list.getEntries())
          metrics.tasks.push({
            start: task.startTime,
            duration: task.duration,
          });
      }).observe({ type: "longtask", buffered: true });
      function painted() {
        const last = document.getElementById(newest);
        const viewport = document.querySelector('[aria-label="Messages"]');
        if (
          last &&
          viewport &&
          Number(last.getAttribute("aria-setsize")) >= newest50.length &&
          last.getAttribute("aria-posinset") ===
            last.getAttribute("aria-setsize")
        ) {
          const rect = last.getBoundingClientRect();
          if (
            rect.height &&
            getComputedStyle(viewport).visibility !== "hidden"
          ) {
            requestAnimationFrame(() => {
              const lastFrame = last.getBoundingClientRect(),
                viewportFrame = viewport.getBoundingClientRect();
              if (!(
                lastFrame.height &&
                lastFrame.bottom <= viewportFrame.bottom + 1 &&
                lastFrame.bottom > viewportFrame.top
              )) {
                requestAnimationFrame(painted);
                return;
              }
              metrics.readyAt = performance.now();
              performance.mark("comms-newest50-ready", {
                startTime: metrics.readyAt,
              });
              metrics.newestVisible = true;
              metrics.renderedRows =
                document.querySelectorAll("[data-message-id]").length;
              console.info("S07-PROFILE " + JSON.stringify(metrics));
            });
            return;
          }
        }
        requestAnimationFrame(painted);
      }
      // Transparent test-only native timing, not a fake client or product hook.
      // The first parsed history response containing the latest message is the
      // actual public data-arrival boundary, before consumer projection/rendering.
      const json = Response.prototype.json;
      Response.prototype.json = async function (this: Response) {
        const result: unknown = await json.call(this);
        if (
          metrics.dataAt === null &&
          /\/api\/comms\/conversations\/[^/]+\/messages$/.test(
            new URL(this.url, location.href).pathname,
          ) &&
          result &&
          typeof result === "object" &&
          "pagination" in result &&
          "items" in result &&
          Array.isArray(result.items) &&
          result.items.some(
            (item: unknown) =>
              item &&
              typeof item === "object" &&
              "id" in item &&
              item.id === newest,
          )
        ) {
          metrics.dataAt = performance.now();
          performance.mark("comms-history-arrived", {
            startTime: metrics.dataAt,
          });
          console.info("S07-PROFILE " + JSON.stringify(metrics));
          requestAnimationFrame(painted);
        }
        return result;
      };
    }, fixture);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const profiled = mode !== "unprofiled opening";
    let renderingTrace: Promise<string> | undefined;
    if (mode === "traced opening") {
      renderingTrace = new Promise((resolve, reject) =>
        cdp.once("Tracing.tracingComplete", (event: { stream?: string }) =>
          event.stream
            ? resolve(event.stream)
            : reject(new Error("Missing rendering trace stream")),
        ),
      );
      await cdp.send("Tracing.start", {
        categories:
          "devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack,blink.user_timing,v8.execute",
        transferMode: "ReturnAsStream",
      });
    }
    if (profiled) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.start");
    }
    let captured: Promise<void> | undefined;
    const capture = () =>
      (captured ??= (async () => {
        if (profiled)
          await cdp
            .send("Profiler.stop")
            .then(({ profile }) =>
              writeFile(
                testInfo.outputPath("timeline.cpuprofile"),
                JSON.stringify(profile),
              ),
            )
            .catch((error: unknown) =>
              writeFile(
                testInfo.outputPath("profile-error.txt"),
                String(error),
              ),
            );
        if (renderingTrace) {
          await cdp.send("Tracing.end");
          const handle = await renderingTrace;
          const chunks: Buffer[] = [];
          for (;;) {
            const chunk = await cdp.send("IO.read", { handle });
            chunks.push(
              Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8"),
            );
            if (chunk.eof) break;
          }
          await cdp.send("IO.close", { handle });
          await writeFile(
            testInfo.outputPath("opening-rendering-trace.json"),
            Buffer.concat(chunks),
          );
        }
      })());
    // A diagnostic deadline, not a sleep or an extension of the test deadline:
    // preserve native samples even if the unchanged feed never settles in 30s.
    const profileDeadline = setTimeout(() => {
      void capture();
    }, 15000);
    let report: unknown;
    try {
      await page.goto("/comms", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () =>
          (window as unknown as MeasuredWindow).commsTimelineMeasurement
            .readyAt !== null,
      );
      const opening = await page.evaluate(() => ({
        ...(window as unknown as MeasuredWindow).commsTimelineMeasurement,
        time_origin_ms: performance.timeOrigin,
        clock_sample: { now_ms: performance.now(), date_now_ms: Date.now() },
      }));
      if (openingDiagnostic) await capture();
      const scroll = openingDiagnostic ? undefined : await measureScroll(page);
      report = {
        setup: {
          messages: 5000,
          mode,
          newest: 50,
          cpu_rate: 4,
          viewport: "1440x900",
          browser: browser.version(),
          source: "live Comms fake history over the mocked /api routes",
          data_boundary:
            "first parsed public history response containing newest message",
        },
        opening,
        newest50_ms: opening.readyAt! - opening.dataAt!,
        scroll,
      };
      await writeFile(
        testInfo.outputPath("timeline-metrics.json"),
        JSON.stringify(report, null, 2),
      );
      console.info(JSON.stringify(report));
      expect.soft(opening.readyAt! - opening.dataAt!).toBeLessThanOrEqual(200);
      expect.soft(opening.newestVisible).toBe(true);
      if (scroll) {
        expect.soft(scroll.wheel_delta_pixels).toBe(-3000);
        expect.soft(scroll.observed_scroll_delta).toBeGreaterThan(0);
        expect.soft(scroll.long_tasks.length).toBeLessThanOrEqual(2);
      }
    } finally {
      clearTimeout(profileDeadline);
      await capture();
      await cdp
        .send("Emulation.setCPUThrottlingRate", { rate: 1 })
        .catch(() => {});
      if (!report) {
        await writeFile(
          testInfo.outputPath("timeline-incomplete.json"),
          JSON.stringify({ progress, completed: false }, null, 2),
        );
      }
    }
  });
}

test("Comms 5000-message scroll baseline isolates 4x CPU scrolling after unthrottled fixture hydration", async ({
  page,
  browser,
}, testInfo) => {
  const fixture = await seedTimeline(page);
  await page.goto("/comms", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    (id) => document.getElementById(id) !== null,
    fixture.newest,
  );
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  try {
    const measured = await measureScroll(page);
    const report = {
      setup: {
        messages: 5000,
        hydration_cpu_rate: 1,
        measured_scroll_cpu_rate: 4,
        browser: browser.version(),
        product: "current production export",
        purpose:
          "independent uninstrumented scroll check; fixture hydration is outside the measured scroll interval",
      },
      measured,
    };
    await writeFile(
      testInfo.outputPath("scroll-baseline.json"),
      JSON.stringify(report, null, 2),
    );
    console.info(JSON.stringify(report));
    expect(measured.wheel_delta_pixels).toBe(-3000);
    expect(measured.observed_scroll_delta).toBeGreaterThan(0);
    expect(measured.long_tasks.length).toBeLessThanOrEqual(2);
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  }
});
