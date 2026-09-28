"use client";

/**
 * The open control of a list row. Its name reads as body text, not a link;
 * its hit area covers the whole row or card, so the row's container must be
 * `relative` (see `openRowClassName`). The button keeps its own focus ring,
 * and the row takes a tint while the button has keyboard focus.
 */
export function RowOpenButton({
  title,
  subtitle,
  onOpen,
}: {
  title: string;
  subtitle?: string | null;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="focus-visible:outline-ring -mx-1 flex min-h-11 max-w-72 min-w-0 flex-col items-start justify-center rounded-md px-1 text-left after:absolute after:inset-0 after:content-[''] focus-visible:outline-2"
      onClick={onOpen}
    >
      <span className="block font-medium break-words">{title}</span>
      {subtitle ? (
        <span className="text-muted-foreground block text-xs break-words">
          {subtitle}
        </span>
      ) : null}
    </button>
  );
}

/** For the row or card that holds a RowOpenButton. */
export const openRowClassName =
  "relative cursor-pointer has-[button:focus-visible]:bg-muted/50";
