"use client";

import {
  Crosshair,
  Maximize,
  Redo2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import { Button } from "@/components/ui/button";

export interface SandboxToolbarProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onCenter: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

const ICON_BUTTON_CLASS =
  "focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:outline-none";

export function SandboxToolbar({
  onZoomIn,
  onZoomOut,
  onFit,
  onCenter,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
}: SandboxToolbarProps) {
  return (
    <div
      role="toolbar"
      aria-label="Canvas toolbar"
      className="border-border bg-card flex items-center gap-1 rounded-lg border p-1 shadow-sm"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Zoom in"
        title="Zoom in"
        data-testid="toolbar-zoom-in"
        onClick={onZoomIn}
        className={ICON_BUTTON_CLASS}
      >
        <ZoomIn aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Zoom out"
        title="Zoom out"
        data-testid="toolbar-zoom-out"
        onClick={onZoomOut}
        className={ICON_BUTTON_CLASS}
      >
        <ZoomOut aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Fit to screen"
        title="Fit to screen"
        data-testid="toolbar-fit"
        onClick={onFit}
        className={ICON_BUTTON_CLASS}
      >
        <Maximize aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Center canvas"
        title="Center canvas"
        data-testid="toolbar-center"
        onClick={onCenter}
        className={ICON_BUTTON_CLASS}
      >
        <Crosshair aria-hidden="true" />
      </Button>

      <span aria-hidden="true" className="bg-border mx-1 h-6 w-px shrink-0" />

      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Undo move"
        title={canUndo ? "Undo canvas move" : "No canvas moves to undo"}
        data-testid="toolbar-undo"
        disabled={!canUndo}
        onClick={onUndo}
        className={ICON_BUTTON_CLASS}
      >
        <Undo2 aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Redo move"
        title={canRedo ? "Redo canvas move" : "No canvas moves to redo"}
        data-testid="toolbar-redo"
        disabled={!canRedo}
        onClick={onRedo}
        className={ICON_BUTTON_CLASS}
      >
        <Redo2 aria-hidden="true" />
      </Button>
    </div>
  );
}
