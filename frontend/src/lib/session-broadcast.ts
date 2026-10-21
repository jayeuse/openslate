// Session cookies are shared by every tab of a browser. When this tab signs in
// or out, it tells the browser's other OpenSlate tabs, which then cover their
// workspace and check who is signed in before they show it again.
const CHANNEL = "openslate-session";
// Created on first use, not at import: UI primitives import this module, and
// `crypto.randomUUID` is unavailable outside a secure context.
let tabId: string | undefined;
let channel: BroadcastChannel | null | undefined;

function sessionChannel(): BroadcastChannel | null {
  if (channel === undefined)
    channel =
      typeof BroadcastChannel === "undefined"
        ? null
        : new BroadcastChannel(CHANNEL);
  return channel;
}

function currentTabId(): string {
  tabId ??= crypto.randomUUID();
  return tabId;
}

/** Tells the browser's other tabs that the signed-in account may have changed. */
export function announceIdentityChange(): void {
  sessionChannel()?.postMessage({ tabId: currentTabId() });
}

/** Calls `listener` when another tab announces an account change. */
export function subscribeIdentityChanges(listener: () => void): () => void {
  const current = sessionChannel();
  if (current === null) return () => {};
  const onMessage = (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (
      typeof data === "object" &&
      data !== null &&
      (data as { tabId?: unknown }).tabId !== currentTabId()
    )
      listener();
  };
  current.addEventListener("message", onMessage);
  return () => current.removeEventListener("message", onMessage);
}
