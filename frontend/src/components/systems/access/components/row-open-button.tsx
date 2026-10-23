"use client";

import { useId, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The open control of a list row. Its name reads as body text, not a link;
 * its hit area covers the whole row or card, so the row's container must be
 * `relative` (see `openRowClassName`). The button keeps its own focus ring,
 * and the row takes a tint while the button has keyboard focus.
 *
 * `inline` sets the title and subtitle on one truncated line (the 40px table
 * row from 1280px); otherwise the subtitle sits under the title. A `label`
 * names the action ("Manage Ben Cruz"); the subtitle then describes it.
 */
export function RowOpenButton({
  title,
  subtitle,
  leading,
  label,
  inline = false,
  onOpen,
}: {
  title: string;
  /** Text, or marks and chips whose text reads as one phrase. */
  subtitle?: ReactNode;
  leading?: ReactNode;
  label?: string;
  inline?: boolean;
  onOpen: () => void;
}) {
  const subtitleId = useId();
  return (
    <button
      type="button"
      aria-label={label}
      aria-describedby={label && subtitle ? subtitleId : undefined}
      className={cn(
        "focus-visible:outline-ring -mx-1 flex min-h-11 max-w-full min-w-0 items-center gap-2.5 rounded-md px-1 text-left after:absolute after:inset-0 after:content-[''] focus-visible:outline-2",
        inline ? "xl:min-h-8" : "max-w-72",
      )}
      onClick={onOpen}
    >
      {leading}
      <span
        className={cn(
          "flex min-w-0 flex-col items-start",
          inline && "md:flex-row md:items-baseline md:gap-2",
        )}
      >
        <span
          className={cn(
            "block font-medium",
            inline ? "max-w-full truncate md:shrink-0" : "break-words",
          )}
        >
          {title}
        </span>
        {subtitle ? (
          <span
            id={subtitleId}
            className={cn(
              "text-muted-foreground block",
              inline
                ? "max-w-full truncate text-xs md:text-sm"
                : "text-xs break-words",
            )}
          >
            {subtitle}
          </span>
        ) : null}
      </span>
    </button>
  );
}

/** For the row or card that holds a RowOpenButton. */
export const openRowClassName =
  "relative cursor-pointer has-[button:focus-visible]:bg-muted/50";

/**
 * Ink-tint row states (the One Selection Rule): 6% under the pointer, 14%
 * for the open item, and no edge or ring.
 */
export const tintRowClassName =
  "hover:bg-[color-mix(in_oklab,var(--ink)_6%,transparent)] data-[state=selected]:bg-[color-mix(in_oklab,var(--ink)_14%,transparent)]";
