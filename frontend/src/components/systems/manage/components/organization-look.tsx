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
 * A small scene drawn with the theme's own tokens: ground, a card with a
 * title in the theme's type, an action bar, and the flow and warn signals.
 * data-theme-preview scopes the theme's tokens to this element.
 */
function LookSwatch({ theme }: { theme: OrganizationTheme }) {
  return (
    <div
      aria-hidden="true"
      data-theme-preview={theme}
      className="grid h-24 place-items-center rounded-[var(--radius)] border border-[var(--rule)] bg-[var(--ground)] p-3"
    >
      <div className="grid w-full gap-2 rounded-[var(--radius)] border border-[var(--rule)] bg-[var(--surface)] p-2.5 font-[family-name:var(--font-ui)] text-[var(--ink)] shadow-[var(--lift)]">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold">Aa Orders</span>
          <span className="flex gap-1">
            <span className="size-2 rounded-full bg-[var(--flow)]" />
            <span className="size-2 rounded-full bg-[var(--warn)]" />
          </span>
        </div>
        <span className="h-1.5 w-2/3 rounded-full bg-[var(--rule)]" />
        <span className="h-4 w-16 rounded-[var(--radius)] bg-[var(--action)]" />
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
