"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, Menu, PanelLeft, X } from "lucide-react";

import { AppBreadcrumbs } from "@/components/app-breadcrumbs";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type EditorPanel = "left";
const MIN = { left: 408 };
const STORAGE_KEY = "openslate.sandbox.panel-widths.v1";
const SEPARATORS = 8;
const CANVAS_MIN = 360;

export interface SandboxShellProps {
  /** The persistent hierarchy shown in the left Structure panel. */
  structure?: ReactNode;
  canvas: ReactNode;
  toolbar: ReactNode;
  actions?: ReactNode;
  hint?: ReactNode;
  className?: string;
  /** Optional bridge to the global AppShell navigation on mobile. */
  onOpenNavigation?: (opener: HTMLElement) => void;
  mobileNavigationOpen?: boolean;
}

export function SandboxShell({
  structure,
  canvas,
  toolbar,
  actions,
  hint,
  className,
  onOpenNavigation,
  mobileNavigationOpen = false,
}: SandboxShellProps) {
  const [panel, setPanel] = useState<EditorPanel | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [preferred, setPreferred] = useState(MIN);
  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{
    side: EditorPanel;
    x: number;
    width: number;
  } | null>(null);
  const isDesktop = containerWidth >= MIN.left + CANVAS_MIN + SEPARATORS;
  const maximumWidth = Math.max(
    MIN.left,
    containerWidth - CANVAS_MIN - SEPARATORS,
  );
  const widths = { left: Math.min(preferred.left, maximumWidth) };

  function resize(side: EditorPanel, value: number): void {
    const next = { left: Math.max(MIN.left, Math.min(maximumWidth, value)) };
    setPreferred(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* Session resizing still works. */
    }
  }

  function separator(side: EditorPanel): ReactNode {
    const maximum = maximumWidth;
    return (
      <div
        role="separator"
        aria-label={"Resize Structure"}
        aria-orientation="vertical"
        aria-valuemin={MIN[side]}
        aria-valuemax={Math.round(maximum)}
        aria-valuenow={Math.round(widths[side])}
        tabIndex={0}
        data-testid={`sandbox-resize-${side}`}
        className="bg-card hover:bg-muted focus-visible:bg-muted border-border focus-visible:outline-ring w-2 shrink-0 cursor-col-resize touch-none border-x focus-visible:outline-2"
        onDoubleClick={() => resize(side, MIN[side])}
        onKeyDown={(event) => {
          if (event.key === "Home") {
            event.preventDefault();
            resize(side, MIN[side]);
          }
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            resize(
              side,
              widths[side] + (event.key === "ArrowRight" ? 16 : -16),
            );
          }
        }}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          setDrag({ side, x: event.clientX, width: widths[side] });
        }}
        onPointerMove={(event) => {
          if (drag?.side === side)
            resize(side, drag.width + (event.clientX - drag.x));
        }}
        onPointerUp={() => {
          setDrag(null);
        }}
        onPointerCancel={() => {
          setDrag(null);
        }}
      />
    );
  }

  const leftTriggerRef = useRef<HTMLButtonElement>(null);

  function closePanel(): void {
    setPanel(null);
  }

  function togglePanel(nextPanel: EditorPanel): void {
    setPanel((current) => (current === nextPanel ? null : nextPanel));
  }

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setContainerWidth(width);
      if (width >= MIN.left + CANVAS_MIN + SEPARATORS) setPanel(null);
    });
    observer.observe(container);
    try {
      const saved: unknown = JSON.parse(
        localStorage.getItem(STORAGE_KEY) ?? "null",
      );
      if (
        saved &&
        typeof saved === "object" &&
        "left" in saved &&
        typeof saved.left === "number" &&
        Number.isFinite(saved.left)
      )
        setPreferred({
          left: Math.max(MIN.left, saved.left),
        });
    } catch {
      /* Fall back to the panel minimums. */
    }
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (mobileNavigationOpen && panel !== null) {
      closePanel();
    }
  }, [mobileNavigationOpen, panel]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "sandbox-ui bg-background text-foreground flex h-full min-h-[100dvh] min-w-0 flex-col overflow-hidden",
        className,
      )}
    >
      <header className="border-border bg-card flex h-12 shrink-0 items-center gap-2 border-b px-3 sm:px-5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Open navigation"
          onClick={(event) => {
            closePanel();
            onOpenNavigation?.(event.currentTarget);
          }}
          className="lg:hidden"
        >
          <Menu aria-hidden="true" />
        </Button>
        <Link
          href="/workspace"
          aria-label="Back to workspace"
          className="text-muted-foreground hover:text-foreground rounded-sm p-1 focus-visible:outline-2"
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </Link>
        <AppBreadcrumbs />
        <h1 className="sr-only">Sandbox</h1>
        <span
          className="text-muted-foreground ml-auto text-[11px]"
          title="Changes are kept in this session and reset when you leave or reload."
        >
          Session only
        </span>
        <Button
          ref={leftTriggerRef}
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Toggle structure"
          aria-expanded={panel === "left"}
          onClick={() => togglePanel("left")}
          className={isDesktop ? "hidden" : undefined}
        >
          <PanelLeft aria-hidden="true" />
        </Button>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {isDesktop ? (
          <aside
            aria-label="Structure"
            data-testid="sandbox-panel-left"
            style={{ width: widths.left }}
            className="bg-card min-h-0 shrink-0 overflow-y-auto p-3"
          >
            {structure}
          </aside>
        ) : null}
        {isDesktop ? separator("left") : null}
        <section
          aria-label="Sandbox canvas"
          className="bg-background relative min-w-0 flex-1 overflow-hidden"
        >
          {canvas}
          <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-3">
            <div className="pointer-events-auto flex flex-col items-center gap-2">
              {toolbar}
              <span className="bg-card/90 text-muted-foreground rounded px-2 py-1 text-[10px]">
                Snap to grid · Alt / Option to move freely
              </span>
            </div>
          </div>
        </section>

        <Sheet
          open={panel !== null && !isDesktop && !mobileNavigationOpen}
          onOpenChange={(open) => setPanel(open ? "left" : null)}
        >
          <SheetContent
            side="left"
            finalFocus={() =>
              mobileNavigationOpen ? false : leftTriggerRef.current
            }
            className="sandbox-ui flex w-80 max-w-[88vw] flex-col p-0"
          >
            <div className="border-border flex h-12 shrink-0 items-center justify-between border-b px-4">
              <SheetTitle>Structure</SheetTitle>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Close structure"
                onClick={closePanel}
              >
                <X aria-hidden="true" /> Close
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {structure}
            </div>
          </SheetContent>
        </Sheet>
      </div>

      {actions || hint ? (
        <footer className="border-border bg-card flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-3 py-2 sm:px-5">
          {hint ? (
            <p className="text-muted-foreground mr-auto hidden text-[11px] xl:block">
              {hint}
            </p>
          ) : null}
          {actions}
        </footer>
      ) : null}
    </div>
  );
}
