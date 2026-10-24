import { cn } from "@/lib/utils";

/** The tones a Manage status dot takes (Backup, Jobs, Audit). */
export type StatusTone = "flow" | "action" | "danger" | "warn" | "muted";

/** The dot fill of each tone; "muted" is a hollow ring. */
export const statusDotTone: Record<StatusTone, string> = {
  flow: "bg-flow",
  action: "bg-[var(--action)]",
  danger: "bg-[var(--danger)]",
  warn: "bg-warn",
  muted: "shadow-[inset_0_0_0_1.5px_var(--ink-muted)]",
};

/** The 8px dot of a status; the word beside it carries the meaning. */
export function StatusDot({ tone }: { tone: StatusTone }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-2 shrink-0 rounded-full", statusDotTone[tone])}
    />
  );
}

/** A status as a dot and a word (DESIGN "Access rows"). */
export function StatusWord({
  word,
  tone,
  className,
}: {
  word: string;
  tone: StatusTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap",
        className,
      )}
    >
      <StatusDot tone={tone} />
      <span className="truncate">{word}</span>
    </span>
  );
}
