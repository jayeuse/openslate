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
