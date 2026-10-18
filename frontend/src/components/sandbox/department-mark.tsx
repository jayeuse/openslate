import { cn } from "@/lib/utils";
import { departmentTone } from "@/lib/sandbox/canvas-geometry";

// Static class names, so Tailwind emits every tone and a look can restyle
// the mark through `--dept-n`.
const TONE_FILL = {
  1: "bg-[var(--dept-1)]",
  2: "bg-[var(--dept-2)]",
  3: "bg-[var(--dept-3)]",
  4: "bg-[var(--dept-4)]",
} as const;

/**
 * A department's identity color beside its name outside the canvas (the Name
 * Beside Color Rule, DESIGN.md): the canvas identity mark at 8px.
 */
export function DepartmentMark({
  departmentIndex,
  className,
}: {
  /** The department's position in the design, as on the canvas. */
  departmentIndex: number;
  className?: string;
}) {
  const tone = departmentTone(departmentIndex) as keyof typeof TONE_FILL;
  return (
    <span
      aria-hidden="true"
      data-sandbox-part="identity"
      className={cn(
        "inline-block size-2 shrink-0 rounded-[2px]",
        TONE_FILL[tone],
        className,
      )}
    />
  );
}
