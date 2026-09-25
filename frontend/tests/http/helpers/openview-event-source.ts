import type { Page } from "@playwright/test";

type EventSourceHarnessWindow = Window & {
  __sendOpenViewEvent?: (type: string, data: string) => void;
};

export async function installOpenViewEventSource(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Listener = EventListenerOrEventListenerObject;
    const streams = new Set<FakeEventSource>();

    class FakeEventSource extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readonly url: string;
      readonly withCredentials = false;
      readyState = FakeEventSource.OPEN;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(url: string) {
        super();
        this.url = url;
        streams.add(this);
        queueMicrotask(() => {
          const event = new Event("open");
          this.dispatchEvent(event);
          this.onopen?.(event);
        });
      }

      close() {
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
        const event = new MessageEvent(type, { data });
        this.dispatchEvent(event);
        if (type === "message") this.onmessage?.(event);
      }
    }

    Object.defineProperty(window, "EventSource", {
      configurable: true,
      value: FakeEventSource as unknown as typeof EventSource,
    });
    (window as EventSourceHarnessWindow).__sendOpenViewEvent = (type, data) => {
      for (const stream of streams) stream.send(type, data);
    };
  });
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
