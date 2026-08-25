"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const INVALIDATION_CHANNEL = "openslate-session-events";
const INVALIDATION_EVENT = "session-invalidated";
const SUPABASE_INVALIDATION_CHANNEL = "openslate:invalidation";
const SUPABASE_INVALIDATION_EVENT = "invalidate";
export const OPENSLADE_INVALIDATION_EVENT = "openslate:invalidation";

type RealtimeContextValue = {
  getAccessToken: () => Promise<string | null>;
  getClient: () => SupabaseClient;
  invalidate: () => void;
};

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

function isInvalidationEvent(value: unknown): value is { type: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === INVALIDATION_EVENT
  );
}

function isTokenResponse(value: unknown): value is { access_token: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "access_token" in value &&
    typeof value.access_token === "string" &&
    value.access_token.length > 0
  );
}

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const clientRef = useRef<SupabaseClient | null>(null);
  const tokenRef = useRef<string | null>(null);
  const tokenExpiresAtRef = useRef(0);
  const broadcastRef = useRef<BroadcastChannel | null>(null);

  const getClient = useCallback(() => {
    if (clientRef.current) return clientRef.current;
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) throw new Error("Realtime is not configured");
    clientRef.current = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
    return clientRef.current;
  }, []);

  const invalidate = useCallback(() => {
    tokenRef.current = null;
    tokenExpiresAtRef.current = 0;
    if (clientRef.current) void clientRef.current.removeAllChannels();
    broadcastRef.current?.postMessage({ type: INVALIDATION_EVENT });
  }, []);

  const getAccessToken = useCallback(async () => {
    if (tokenRef.current && tokenExpiresAtRef.current > Date.now() + 60_000)
      return tokenRef.current;
    const response = await fetch("/session/realtime-token", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) {
      if (response.status === 401) invalidate();
      return null;
    }
    const body: unknown = await response.json().catch(() => null);
    if (!isTokenResponse(body)) return null;
    tokenRef.current = body.access_token;
    const payload = body.access_token.split(".")[1];
    try {
      const claims: unknown = JSON.parse(
        atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
      );
      tokenExpiresAtRef.current =
        typeof claims === "object" &&
        claims !== null &&
        "exp" in claims &&
        typeof claims.exp === "number"
          ? claims.exp * 1000
          : Date.now() + 5 * 60_000;
    } catch {
      tokenExpiresAtRef.current = Date.now() + 5 * 60_000;
    }
    return tokenRef.current;
  }, [invalidate]);

  useEffect(() => {
    const refresh = window.setInterval(() => {
      if (
        !clientRef.current ||
        !tokenRef.current ||
        tokenExpiresAtRef.current > Date.now() + 2 * 60_000
      )
        return;
      tokenRef.current = null;
      tokenExpiresAtRef.current = 0;
      void getAccessToken().then((token) => {
        if (token && clientRef.current)
          clientRef.current.realtime.setAuth(token);
      });
    }, 60_000);
    return () => window.clearInterval(refresh);
  }, [getAccessToken]);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(INVALIDATION_CHANNEL);
    broadcastRef.current = channel;
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (!isInvalidationEvent(event.data)) return;
      tokenRef.current = null;
      tokenExpiresAtRef.current = 0;
      if (clientRef.current) void clientRef.current.removeAllChannels();
    };
    return () => {
      channel.close();
      if (broadcastRef.current === channel) broadcastRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let channel: ReturnType<SupabaseClient["channel"]> | null = null;

    void getAccessToken().then((token) => {
      if (!token || cancelled) return;
      const client = getClient();
      client.realtime.setAuth(token);
      channel = client
        .channel(SUPABASE_INVALIDATION_CHANNEL, {
          config: { private: true, broadcast: { ack: false, self: false } },
        })
        .on("broadcast", { event: SUPABASE_INVALIDATION_EVENT }, (message) => {
          window.dispatchEvent(
            new CustomEvent(OPENSLADE_INVALIDATION_EVENT, {
              detail: message.payload as unknown,
            }),
          );
        })
        .subscribe();
    });

    return () => {
      cancelled = true;
      if (channel) void getClient().removeChannel(channel);
    };
  }, [getAccessToken, getClient]);

  return (
    <RealtimeContext.Provider value={{ getAccessToken, getClient, invalidate }}>
      {children}
    </RealtimeContext.Provider>
  );
}

export function useRealtime() {
  const context = useContext(RealtimeContext);
  if (!context)
    throw new Error("useRealtime must be used within RealtimeProvider");
  return context;
}

type RealtimeChannelOptions = {
  channelName: string;
  event: string;
  enabled?: boolean;
  onEvent: (payload: unknown) => void;
};

export function useRealtimeChannel({
  channelName,
  event,
  enabled = true,
  onEvent,
}: RealtimeChannelOptions) {
  const { getAccessToken, getClient } = useRealtime();

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let channel: ReturnType<SupabaseClient["channel"]> | null = null;

    async function subscribe() {
      const token = await getAccessToken();
      if (!token || cancelled) return;
      try {
        const client = getClient();
        client.realtime.setAuth(token);
        channel = client
          .channel(channelName, {
            config: {
              private: true,
              broadcast: { ack: false, self: false },
            },
          })
          .on("broadcast", { event }, (message) => {
            onEvent(message.payload as unknown);
          });
        channel.subscribe();
      } catch {
        // Realtime is an optional enhancement; domain API calls remain usable.
      }
    }

    void subscribe();
    return () => {
      cancelled = true;
      if (channel) void getClient().removeChannel(channel);
    };
  }, [channelName, enabled, event, getAccessToken, getClient, onEvent]);
}
