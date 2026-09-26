"use client";

import { useEffect, useId, useState } from "react";
import {
  applyOrganizationTheme,
  ORGANIZATION_THEMES,
  persistOrganizationTheme,
  readBrowserOrganizationTheme,
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
      className="rounded-[var(--radius)] border border-[var(--rule)] bg-[var(--canvas-background)] p-3 font-[family-name:var(--font-ui)] text-xs"
    >
      <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--canvas-dept-frame)] bg-[var(--canvas-dept-fill)]">
        <div className="flex items-center gap-1.5 bg-[var(--dept-1-band)] px-2 py-1 font-semibold text-[var(--canvas-dept-ink)]">
          <span className="size-2 shrink-0 rounded-sm bg-[var(--dept-1)]" />
          Commerce
        </div>
        <div className="p-2">
          <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--canvas-module-frame)] bg-[var(--canvas-module-fill)] text-[var(--canvas-module-ink)]">
            <div className="flex items-center gap-1.5 bg-[var(--dept-1-card)] px-2 py-1 font-semibold">
              <span className="size-2 shrink-0 rounded-sm bg-[var(--dept-1)]" />
              Orders
            </div>
            <div className="flex justify-between gap-2 border-t border-[var(--canvas-row-rule)] px-2 py-0.5">
              <span>Order total</span>
              <span className="text-[var(--canvas-type-ink)]">Number</span>
            </div>
            <div className="flex justify-between gap-2 border-t border-[var(--canvas-row-rule)] bg-[var(--canvas-row-stripe)] px-2 py-0.5">
              <span>Paid</span>
              <span className="text-[var(--canvas-type-ink)]">Checkbox</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function OrganizationLook() {
  const headingId = useId();
  // The browser choice is read after mount so the server render (Slate)
  // and the first client render match.
  const [theme, setTheme] = useState<OrganizationTheme>("slate");
  useEffect(() => setTheme(readBrowserOrganizationTheme()), []);

  function choose(next: OrganizationTheme) {
    setTheme(next);
    applyOrganizationTheme(next);
    persistOrganizationTheme(next);
  }

  return (
    <section aria-labelledby={headingId} className="min-w-0 lg:col-span-2">
      <h2 id={headingId} className="text-lg font-semibold tracking-tight">
        Organization look
      </h2>
      <p className="text-muted-foreground mt-1 max-w-2xl text-sm leading-6">
        Choose how OpenSlate looks for your organization. Words, layout, and how
        things work stay the same. Each person still picks light or dark.
      </p>
      <div
        role="radiogroup"
        aria-labelledby={headingId}
        className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
      >
        {ORGANIZATION_THEMES.map((id) => (
          <label
            key={id}
            className="border-border has-[:checked]:border-primary has-[:focus-visible]:outline-ring grid cursor-pointer gap-3 rounded-[var(--radius)] border p-3 has-[:checked]:ring-1 has-[:checked]:ring-[var(--action)] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2"
          >
            <input
              type="radio"
              name="organization-look"
              value={id}
              checked={theme === id}
              onChange={() => choose(id)}
              className="sr-only"
            />
            <LookSwatch theme={id} />
            <span className="grid gap-0.5">
              <span className="text-sm font-medium">{LOOKS[id].name}</span>
              <span className="text-muted-foreground text-sm">
                {LOOKS[id].description}
              </span>
            </span>
          </label>
        ))}
      </div>
      <p className="text-muted-foreground mt-3 text-sm">
        Changes apply right away. For now the look is saved in this browser
        only.
      </p>
    </section>
  );
}
