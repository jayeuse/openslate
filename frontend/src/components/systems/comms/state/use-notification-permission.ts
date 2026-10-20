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
    "Browser permission has not been granted. Enable it explicitly for later live alerts.",
  granted:
    "Browser permission granted. This example still does not emit alerts or sounds.",
  denied:
    "Browser permission denied. Change site permissions for future alerts; you can still save preferences.",
  unavailable:
    "Browser notification permission is unavailable here. You can still save preferences.",
};

/** Permission only. Emission and tab leadership belong to the later consumer. */
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
