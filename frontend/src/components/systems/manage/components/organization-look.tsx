"use client";

import { Check } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  ORGANIZATION_THEMES,
  type OrganizationTheme,
} from "@/lib/appearance-preferences";

const LOOKS: Record<OrganizationTheme, { name: string; description: string }> =
  {
    slate: { name: "Slate", description: "Clean and familiar. The default." },
    whiteboard: {
      name: "Whiteboard",
      description: "Marker ink on a planning board.",
    },
    triplicate: {
      name: "Triplicate",
      description: "Carbon-copy business forms.",
    },
    stockroom: {
      name: "Stockroom",
      description: "Steel shelves and kraft boxes.",
    },
  };

/**
 * A small piece of the Sandbox canvas drawn with the theme's own tokens: a
 * department head with its identity mark, and a table card with a header and
 * two field rows. The canvas is where the looks differ most, so the preview
 * shows it. data-theme-preview scopes the theme's tokens to this element.
 */
function LookSwatch({ theme }: { theme: OrganizationTheme }) {
  return (
    <div
      aria-hidden="true"
      data-theme-preview={theme}
      className="overflow-hidden rounded-[var(--radius)] border border-[var(--rule)] bg-[var(--canvas-background)] p-2 font-[family-name:var(--font-ui)] text-xs"
    >
      <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--canvas-dept-frame)] bg-[var(--canvas-dept-fill)]">
        <div className="flex items-center gap-1.5 bg-[var(--dept-1-band)] px-2 py-1 font-semibold text-[var(--canvas-dept-ink)]">
          <span className="size-2 shrink-0 rounded-sm bg-[var(--dept-1)]" />
          Commerce
        </div>
        <div className="p-1.5">
          <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--canvas-module-frame)] bg-[var(--canvas-module-fill)] text-[var(--canvas-module-ink)]">
            <div className="flex items-center gap-1.5 bg-[var(--dept-1-card)] px-2 py-1 font-semibold">
              <span className="size-2 shrink-0 rounded-sm bg-[var(--dept-1)]" />
              Orders
            </div>
            <div className="flex justify-between gap-2 border-t border-[var(--canvas-row-rule)] px-2 py-0.5 whitespace-nowrap">
              <span className="truncate">Total</span>
              <span className="text-[var(--canvas-type-ink)]">Number</span>
            </div>
            <div className="flex justify-between gap-2 border-t border-[var(--canvas-row-rule)] bg-[var(--canvas-row-stripe)] px-2 py-0.5 whitespace-nowrap">
              <span className="truncate">Paid</span>
              <span className="text-[var(--canvas-type-ink)]">Checkbox</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The organization look picker (MD4): four compact tiles, two across below
 * 1440px and four from 1440px, where each swatch fits whole. Choosing a tile previews the look at once;
 * Save settings keeps it. The group around it names it and says what stays.
 */
export function OrganizationLook({
  theme,
  onChange,
  disabled,
}: {
  theme: OrganizationTheme;
  onChange: (theme: OrganizationTheme) => void;
  disabled: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Organization look"
      className="grid grid-cols-2 gap-2 min-[90rem]:grid-cols-4"
    >
      {ORGANIZATION_THEMES.map((id) => (
        <label
          key={id}
          className={cn(
            "border-border has-[:checked]:border-primary has-[:focus-visible]:outline-ring grid min-w-0 gap-2 rounded-[var(--radius)] border p-2 has-[:checked]:ring-1 has-[:checked]:ring-[var(--action)] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 forced-colors:has-[:checked]:border-[Highlight] forced-colors:has-[:checked]:outline-2 forced-colors:has-[:checked]:outline-[Highlight]",
            disabled ? "cursor-default" : "cursor-pointer",
          )}
        >
          <input
            type="radio"
            name="organization-look"
            value={id}
            checked={theme === id}
            onChange={() => onChange(id)}
            disabled={disabled}
            className="sr-only"
          />
          <LookSwatch theme={id} />
          <span className="flex items-center justify-between gap-2 px-1">
            <span className="text-sm font-medium">{LOOKS[id].name}</span>
            {/* The swatch shows the look; its words stay for screen readers. */}
            <span className="sr-only">{LOOKS[id].description}</span>
            <Check
              size={15}
              aria-hidden="true"
              className={cn(
                "text-action-text shrink-0",
                theme === id ? undefined : "invisible",
              )}
            />
          </span>
        </label>
      ))}
    </div>
  );
}

/**
 * The saved look for a reader (MD5): one tile with its swatch and name, not
 * four disabled choices (The Read-Only Is Text Rule).
 */
export function OrganizationLookTile({ theme }: { theme: OrganizationTheme }) {
  return (
    <div className="border-border grid w-full max-w-48 gap-2 rounded-[var(--radius)] border p-2">
      <LookSwatch theme={theme} />
      <span className="px-1 text-sm font-medium">{LOOKS[theme].name}</span>
    </div>
  );
}
