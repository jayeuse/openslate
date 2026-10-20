import type { CommsClient } from "../contract/client";
import type {
  RequestOptions,
  SendMessageRequest,
  SendReplyRequest,
  SendResult,
} from "../contract/types";
import {
  sendMessageRequestSchema,
  sendReplyRequestSchema,
} from "../contract/schemas";

type Transport = Pick<CommsClient, "sendMessage" | "sendReply">;
type Entry = {
  client_key: string;
  conversation_id: string;
  root_id: string | null;
  state: "sending" | "not-sent";
};

/** Only unacknowledged sends live here; server messages belong in QueryClient. */
export function createCommsOutbox(http: Transport, lifetime: AbortSignal) {
  const entries = new Map<string, Entry>();
  const identities = new Map<string, { fingerprint: string; key: string }>();
  const requests = new Map<
    string,
    { id: string; root: string | null; input: SendReplyRequest }
  >();
  const listeners = new Set<() => void>();
  const pending = new Map<string, Promise<SendResult>>();
  let snapshot: readonly Entry[] = [];
  const changed = () => {
    snapshot = [...entries.values()];
    listeners.forEach((listener) => listener());
  };
  lifetime.addEventListener(
    "abort",
    () => {
      entries.clear();
      requests.clear();
      identities.clear();
      pending.clear();
      changed();
      listeners.clear();
    },
    { once: true },
  );
  async function send(
    id: string,
    root: string | null,
    input: SendMessageRequest | SendReplyRequest,
    options: RequestOptions = {},
  ): Promise<SendResult> {
    const signal = options.signal
      ? AbortSignal.any([lifetime, options.signal])
      : lifetime;
    signal.throwIfAborted();
    const request = root
      ? sendReplyRequestSchema.parse(input)
      : sendMessageRequestSchema.parse(input);
    const previous = requests.get(request.client_key);
    if (
      previous &&
      (previous.id !== id ||
        previous.root !== root ||
        JSON.stringify(previous.input) !== JSON.stringify(request))
    )
      throw new Error("This send key already belongs to a different draft");
    const sending = pending.get(request.client_key);
    if (sending) return sending;
    requests.set(request.client_key, { id, root, input: request });
    entries.set(request.client_key, {
      client_key: request.client_key,
      conversation_id: id,
      root_id: root,
      state: "sending",
    });
    changed();
    const task = (async () => {
      try {
        const result = await (root
          ? http.sendReply(id, root, request, { signal })
          : http.sendMessage(id, request, { signal }));
        signal.throwIfAborted();
        entries.delete(request.client_key);
        requests.delete(request.client_key);
        changed();
        return result;
      } catch (error) {
        if (!lifetime.aborted) {
          entries.set(request.client_key, {
            client_key: request.client_key,
            conversation_id: id,
            root_id: root,
            state: "not-sent",
          });
          changed();
        }
        throw error;
      } finally {
        pending.delete(request.client_key);
      }
    })();
    pending.set(request.client_key, task);
    return task;
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    identity(
      composer: string,
      fingerprint: string,
      remembered?: { fingerprint: string; key: string } | null,
    ) {
      lifetime.throwIfAborted();
      let value = identities.get(composer);
      if (value?.fingerprint !== fingerprint) {
        value = {
          fingerprint,
          key:
            remembered?.fingerprint === fingerprint
              ? remembered.key
              : crypto.randomUUID(),
        };
        identities.set(composer, value);
      }
      return value.key;
    },
    acknowledgeDraft(composer: string, key: string) {
      if (identities.get(composer)?.key === key) identities.delete(composer);
    },
    sendMessage: (
      id: string,
      input: SendMessageRequest,
      options?: RequestOptions,
    ) => send(id, null, input, options),
    sendReply: (
      id: string,
      root: string,
      input: SendReplyRequest,
      options?: RequestOptions,
    ) => send(id, root, input, options),
    async retry(key: string) {
      const request = requests.get(key);
      if (!request) throw new Error("This send is no longer pending");
      return send(request.id, request.root, request.input);
    },
  };
}
