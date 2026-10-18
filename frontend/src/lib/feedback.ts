import { toast } from "@/components/ui/toast";

const showing = new Set<string>();

export function reportError(title: string) {
  if (!title || showing.has(title)) return;
  showing.add(title);
  toast.add({
    title,
    type: "error",
    onClose: () => showing.delete(title),
  });
}
export function reportDone(title: string) {
  if (title) toast.add({ title, type: "success" });
}

/** A done notice for an action that can be undone; it stays long enough to
 * reach Undo by keyboard (the Four Moments Rule, DESIGN.md). */
export function reportUndoable(title: string, onUndo: () => void) {
  if (title)
    toast.add({
      title,
      type: "success",
      action: { label: "Undo", onClick: onUndo },
    });
}
