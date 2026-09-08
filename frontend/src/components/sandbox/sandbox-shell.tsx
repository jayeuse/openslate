"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, PanelLeft, PanelRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface SandboxShellProps {
  workflow: ReactNode;
  palette: ReactNode;
  canvas: ReactNode;
  inspector: ReactNode;
  toolbar: ReactNode;
  actions?: ReactNode;
  hint?: ReactNode;
  className?: string;
}

export function SandboxShell({
  workflow,
  palette,
  canvas,
  inspector,
  toolbar,
  actions,
  hint,
  className,
}: SandboxShellProps) {
  const [panel, setPanel] = useState<"palette" | "inspector" | null>(null);
  return (
    <div
      className={cn(
        "bg-background text-foreground flex h-dvh min-h-0 flex-col overflow-hidden",
        className,
      )}
    >
      <header className="border-border bg-card flex h-14 shrink-0 items-center gap-3 border-b px-4 sm:px-6">
        <Link
          href="/workspace"
          aria-label="Back to workspace"
          className="text-muted-foreground hover:text-foreground rounded-sm p-1 focus-visible:outline-2"
        >
          <ArrowLeft size={18} aria-hidden="true" />
        </Link>
        <h1 className="text-sm font-semibold">
          OpenSlate{" "}
          <span className="text-muted-foreground mx-2 font-normal">/</span>{" "}
          Sandbox
        </h1>
        <span
          className="text-muted-foreground ml-auto hidden text-xs sm:block"
          title="Changes are kept in this session and reset when you leave or reload."
        >
          Session only
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Toggle palette"
          aria-expanded={panel === "palette"}
          onClick={() => setPanel(panel === "palette" ? null : "palette")}
          className="lg:hidden"
        >
          <PanelLeft aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Toggle inspector"
          aria-expanded={panel === "inspector"}
          onClick={() => setPanel(panel === "inspector" ? null : "inspector")}
          className="lg:hidden"
        >
          <PanelRight aria-hidden="true" />
        </Button>
      </header>
      <div className="border-border bg-card shrink-0 overflow-x-auto border-b px-4 sm:px-6">
        {workflow}
      </div>
      <div className="relative flex min-h-0 flex-1">
        <aside
          aria-label="Palette"
          className="border-border bg-card hidden w-52 shrink-0 overflow-y-auto border-r p-5 lg:block"
        >
          {palette}
        </aside>
        <section
          aria-label="Sandbox canvas"
          className="relative min-w-0 flex-1 overflow-hidden bg-white"
        >
          {canvas}
          <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-3">
            <div className="pointer-events-auto">{toolbar}</div>
          </div>
        </section>
        <aside
          aria-label="Inspector"
          className="border-border bg-card hidden w-88 shrink-0 overflow-y-auto border-l p-5 lg:block"
        >
          <p className="mb-6 text-sm font-semibold">Inspector</p>
          {inspector}
        </aside>
        {panel !== null ? (
          <div className="absolute inset-0 z-40 lg:hidden">
            <button
              type="button"
              aria-label={`Close ${panel}`}
              onClick={() => setPanel(null)}
              className="absolute inset-0 bg-black/20"
            />
            <aside
              aria-label={panel === "palette" ? "Palette" : "Inspector"}
              className={cn(
                "border-border bg-card absolute inset-y-0 w-72 max-w-[85vw] overflow-y-auto border-x p-5 shadow-lg",
                panel === "palette" ? "left-0" : "right-0",
              )}
            >
              <div className="mb-5 flex items-center justify-between">
                <span className="text-sm font-semibold">
                  {panel === "palette" ? "Palette" : "Inspector"}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPanel(null)}
                >
                  Done
                </Button>
              </div>
              {panel === "palette" ? palette : inspector}
            </aside>
          </div>
        ) : null}
      </div>
      <footer className="border-border bg-card flex shrink-0 flex-wrap items-center justify-end gap-3 border-t px-4 py-3 sm:px-6">
        {hint ? (
          <p className="text-muted-foreground mr-auto hidden text-xs xl:block">
            {hint}
          </p>
        ) : null}
        {actions}
      </footer>
    </div>
  );
}
