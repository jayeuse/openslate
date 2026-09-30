import { toast } from "@/components/ui/toast";

// OpenComms results people must see: errors stay until dismissed, and
// confirmations close on their own. Several layers report the same failure
// (an operation and the control that started it), so a message that is
// already showing is not shown twice.
const showing = new Set<string>();

function show(
  title: string,
  type: "success" | "error",
  action?: { label: string; onClick: () => void },
) {
  if (!title || showing.has(title)) return;
  showing.add(title);
  // Cleared when the notice starts closing, not when its exit animation
  // ends, so a repeat of the same result during that animation still shows.
  toast.add({ title, type, action, onClose: () => showing.delete(title) });
}

export function reportCommsError(message: string) {
  show(message, "error");
}

export function reportCommsDone(
  message: string,
  action?: { label: string; onClick: () => void },
) {
  show(message, "success", action);
}
