import { cn } from "@/lib/utils";
import type { GroupTone } from "../domain/groups";

// Department colors from the Sandbox canvas, one class per tone so Tailwind
// can see them.
const TONE_CLASS: Record<GroupTone, string> = {
  0: "bg-muted-foreground",
  1: "bg-[var(--dept-1)]",
  2: "bg-[var(--dept-2)]",
  3: "bg-[var(--dept-3)]",
  4: "bg-[var(--dept-4)]",
};

/** A group's colored square, always shown beside its name. */
export function GroupMark({
  tone,
  className,
}: {
  tone: GroupTone;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-2.5 shrink-0 rounded-[3px]",
        TONE_CLASS[tone],
        className,
      )}
    />
  );
}
