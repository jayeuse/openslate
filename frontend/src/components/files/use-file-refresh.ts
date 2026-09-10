"use client";
import { useEffect, useEffectEvent, useState } from "react";
import { OPENSLADE_INVALIDATION_EVENT } from "@/components/realtime-provider";

// Refresh only this file panel; never remount its parent record form.
export function useFileRefresh(enabled: boolean, pending: boolean) {
  const [visible, setVisible] = useState(true);
  const [generation, setGeneration] = useState(0);
  const [restart, setRestart] = useState(0);
  const [expired, setExpired] = useState(false);
  const refresh = () => {
    setGeneration((value) => value + 1);
    setRestart((value) => value + 1);
  };
  const refreshEvent = useEffectEvent(refresh);
  useEffect(() => {
    if (!enabled) return;
    const visibility = () => {
      setVisible(document.visibilityState === "visible");
      if (document.visibilityState === "visible") refreshEvent();
    };
    const foregroundRefresh = () => {
      if (document.visibilityState === "visible") refreshEvent();
    };
    visibility();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", foregroundRefresh);
    window.addEventListener(OPENSLADE_INVALIDATION_EVENT, foregroundRefresh);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", foregroundRefresh);
      window.removeEventListener(
        OPENSLADE_INVALIDATION_EVENT,
        foregroundRefresh,
      );
    };
  }, [enabled]);
  useEffect(() => {
    setExpired(false);
    if (!enabled || !visible || !pending) return;
    const deadline = Date.now() + 120_000;
    const timer = window.setInterval(() => {
      if (Date.now() >= deadline) {
        clearInterval(timer);
        setExpired(true);
      } else {
        setGeneration((value) => value + 1);
      }
    }, 5_000);
    return () => clearInterval(timer);
  }, [enabled, visible, pending, restart]);
  return { visible, generation, expired, refresh };
}
