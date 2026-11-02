import { toast } from "@/components/ui/toast";

const showing = new Set<string>();

/** An error notice; `reference` is the failed request's full ID, if any. A
 * second notice with the same title is dropped, so the first keeps its
 * reference. */
export function reportError(title: string, reference?: string) {
  if (!title || showing.has(title)) return;
  showing.add(title);
  toast.add({
    title,
    type: "error",
    reference,
    onClose: () => showing.delete(title),
  });
}
export function reportDone(title: string) {
  if (title) toast.add({ title, type: "success" });
}

/** A done notice for an action that can be undone; it stays long enough to
 * reach Undo by keyboard (the Four Moments Rule, DESIGN.md). Returns the
 * notice id, so a caller can close it when the Undo no longer applies
 * (`toast.close`), or null when no notice shows. */
export function reportUndoable(
  title: string,
  onUndo: () => void,
): string | null {
  if (!title) return null;
  return toast.add({
    title,
    type: "success",
    action: { label: "Undo", onClick: onUndo },
  });
}
