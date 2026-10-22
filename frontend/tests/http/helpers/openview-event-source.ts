import type { Page } from "@playwright/test";

type EventSourceHarnessWindow = Window & {
  __sendOpenViewEvent?: (type: string, data: string) => void;
  __openViewStreamState?: () => {
    constructed: number;
    active: number;
    closed: number;
  };
  __failOpenViewStream?: () => void;
  reportEventSources?: Array<EventTarget & { closed: boolean }>;
};

export async function installOpenViewEventSource(
  page: Page,
  options: { autoResync?: boolean; status?: number; retryAfter?: number } = {},
): Promise<void> {
  await page.addInitScript(
    ({ autoResync, status, retryAfter }) => {
      type Listener = EventListenerOrEventListenerObject;
      const streams = new Set<FakeEventSource>();
      const history: FakeEventSource[] = [];

      class FakeEventSource extends EventTarget {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSED = 2;
        readonly url: string;
        readonly withCredentials = false;
        readyState = FakeEventSource.OPEN;
        closed = false;
        onopen: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;

        constructor(url: string) {
          super();
          this.url = url;
          streams.add(this);
          history.push(this);
          queueMicrotask(() => {
            const event = new Event("open");
            this.dispatchEvent(event);
            this.onopen?.(event);
            if (autoResync) this.send("resync", "{}");
          });
        }

        close() {
          this.closed = true;
          this.readyState = FakeEventSource.CLOSED;
          streams.delete(this);
        }

        addEventListener(type: string, listener: Listener | null) {
          super.addEventListener(type, listener);
        }

        removeEventListener(type: string, listener: Listener | null) {
          super.removeEventListener(type, listener);
        }

        send(type: string, data: string) {
          if (type === "resync") this.readyState = FakeEventSource.OPEN;
          const event = new MessageEvent(type, { data });
          this.dispatchEvent(event);
          if (type === "message") this.onmessage?.(event);
        }
      }

      Object.defineProperty(window, "EventSource", {
        configurable: true,
        value: FakeEventSource as unknown as typeof EventSource,
      });
      (window as EventSourceHarnessWindow).__sendOpenViewEvent = (
        type,
        data,
      ) => {
        for (const stream of streams) stream.send(type, data);
      };
      (window as EventSourceHarnessWindow).reportEventSources = history;
      (window as EventSourceHarnessWindow).__openViewStreamState = () => ({
        constructed: history.length,
        active: streams.size,
        closed: history.filter((stream) => stream.closed).length,
      });
      (window as EventSourceHarnessWindow).__failOpenViewStream = () => {
        for (const stream of streams) {
          stream.readyState = FakeEventSource.CONNECTING;
          stream.dispatchEvent(new Event("error"));
        }
      };
      const originalFetch = window.fetch.bind(window);
      let requests = 0;
      Reflect.set(
        window,
        "__setOpenViewHttpStatus",
        (value: number, retry?: number) => {
          status = value;
          retryAfter = retry;
        },
      );
      Reflect.set(window, "__openViewHttpRequests", () => requests);
      window.fetch = async (input, init) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
          window.location.href,
        );
        if (url.pathname !== "/api/events") return originalFetch(input, init);
        const observe = Reflect.get(window, "__onWorkspaceStreamRequest");
        if (typeof observe === "function") await observe();
        requests += 1;
        if (status !== 200)
          return Response.json(
            { detail: "Owned stream refusal" },
            {
              status,
              headers:
                retryAfter === undefined
                  ? {}
                  : { "Retry-After": String(retryAfter) },
            },
          );
        const source = new FakeEventSource(url.toString());
        let ended = false;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const type of ["resync", "invalidate"])
              source.addEventListener(type, (event) => {
                if (!ended && event instanceof MessageEvent)
                  controller.enqueue(
                    new TextEncoder().encode(
                      `event: ${type}\ndata: ${event.data}\n\n`,
                    ),
                  );
              });
            source.addEventListener("error", () => {
              if (!ended) {
                ended = true;
                source.close();
                controller.error(new Error("Owned stream disconnect"));
              }
            });
            init?.signal?.addEventListener(
              "abort",
              () => {
                source.close();
                if (!ended) {
                  ended = true;
                  controller.close();
                }
              },
              { once: true },
            );
          },
          cancel() {
            ended = true;
            source.close();
          },
        });
        return new Response(body, {
          headers: { "Content-Type": "text/event-stream" },
        });
      };
    },
    {
      autoResync: options.autoResync ?? false,
      status: options.status ?? 200,
      retryAfter: options.retryAfter,
    },
  );
}

export async function sendOpenViewEvent(
  page: Page,
  type: "resync" | "invalidate",
  data: Record<string, string> = {},
): Promise<void> {
  await page.evaluate(
    ({ eventType, eventData }) => {
      const send = (window as EventSourceHarnessWindow).__sendOpenViewEvent;
      if (!send) throw new Error("OpenView EventSource harness is unavailable");
      send(eventType, JSON.stringify(eventData));
    },
    { eventType: type, eventData: data },
  );
}

export function sendChartInvalidation(
  page: Page,
  moduleId: string,
): Promise<void> {
  return sendOpenViewEvent(page, "invalidate", {
    entity: "charts",
    module_id: moduleId,
  });
}
