"use client";
import { useEffect, useRef, useState } from "react";

type Permission = NotificationPermission | "unavailable" | "checking";
function currentPermission(): Permission {
  try {
    return typeof Notification === "undefined" ||
      typeof Notification.requestPermission !== "function"
      ? "unavailable"
      : Notification.permission;
  } catch {
    return "unavailable";
  }
}
const descriptions: Record<Permission, string> = {
  checking: "Checking browser permission…",
  default:
    "Browser permission has not been granted. Enable it to see desktop alerts.",
  granted:
    "Browser permission granted. Desktop alerts follow your preferences while OpenSlate is open.",
  denied:
    "Browser permission denied. Change site permissions for future alerts; you can still save preferences.",
  unavailable:
    "Browser notification permission is unavailable here. You can still save preferences.",
};

/** Permission only. `CommsAttention` emits alerts from one tab. */
export function useNotificationPermission() {
  const [permission, setPermission] = useState<Permission>("checking");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    active.current = true;
    setPermission(currentPermission());
    return () => {
      active.current = false;
    };
  }, []);
  async function request() {
    if (!active.current || inFlight.current) return;
    const current = currentPermission();
    setPermission(current);
    setError("");
    if (current !== "default") return;
    inFlight.current = true;
    setPending(true);
    try {
      const next = await Notification.requestPermission();
      if (active.current) setPermission(next);
    } catch {
      if (active.current)
        setError(
          "Browser permission could not be requested. You can retry explicitly; your preference can still be saved.",
        );
    } finally {
      inFlight.current = false;
      if (active.current) setPending(false);
    }
  }
  return {
    permission,
    pending,
    request,
    message: pending
      ? "Requesting browser permission…"
      : error || descriptions[permission],
  };
}
