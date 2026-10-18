import { useSyncExternalStore } from "react";

import type { SandboxState } from "@/lib/sandbox/model";

/**
 * The cells tied to a hovered module or relationship: the module, the
 * relationships that touch it, and the modules at their other ends. Returns
 * null for anything else, such as a department frame.
 */
export function tracedCellIds(
  state: SandboxState,
  cellId: string,
): Set<string> | null {
  const link = state.links.find((item) => item.id === cellId);
  if (link) return new Set([link.id, link.sourceModuleId, link.targetModuleId]);
  if (!state.modules.some((item) => item.id === cellId)) return null;
  const traced = new Set([cellId]);
  for (const item of state.links) {
    if (item.sourceModuleId !== cellId && item.targetModuleId !== cellId)
      continue;
    traced.add(item.id);
    traced.add(item.sourceModuleId);
    traced.add(item.targetModuleId);
  }
  return traced;
}

export type TraceMark = "on" | "dim" | null;
export type FieldMarks = Readonly<Record<string, string>>;

/**
 * Hovering a module or relationship marks its connections `data-trace="on"`
 * and fades other modules and relationships (`data-trace="dim"`). Department
 * frames stay as context. A pinned cell ("Show on canvas") traces the same
 * way whenever nothing is hovered. Field marks show a Test run on the rows.
 *
 * Nodes read their own mark through `useTraceMark`, so a hover re-renders
 * only the nodes whose mark changes.
 */
export class SandboxCanvasTraceStore {
  private listeners = new Set<() => void>();
  private state: SandboxState | null = null;
  private hovered: string | null = null;
  private pinnedId: string | null = null;
  private traced: Set<string> | null = null;
  private marks: FieldMarks | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  traceOf(cellId: string): TraceMark {
    if (this.traced === null || this.state === null) return null;
    if (this.traced.has(cellId)) return "on";
    return this.state.departments.some((item) => item.id === cellId)
      ? null
      : "dim";
  }

  fieldMarks = (): FieldMarks | null => this.marks;

  get pinned(): string | null {
    return this.pinnedId;
  }

  setState(state: SandboxState): void {
    this.state = state;
    this.update();
  }

  hover(cellId: string): void {
    this.hovered = cellId;
    this.update();
  }

  /** Moving from a frame onto a module inside it can fire the frame's leave
   * after the module's enter, so only the hovered cell clears. */
  leave(cellId: string): void {
    if (this.hovered !== cellId) return;
    this.hovered = null;
    this.update();
  }

  pin(cellId: string | null): void {
    this.pinnedId = cellId;
    this.update();
  }

  markFields(marks: FieldMarks | null): void {
    this.marks = marks;
    this.emit();
  }

  /** A click on empty canvas: drop the hover, the pin, and the marks.
   * Returns whether a pin was cleared. */
  clear(): boolean {
    const wasPinned = this.pinnedId !== null;
    if (this.hovered === null && !wasPinned && this.marks === null)
      return false;
    this.hovered = null;
    this.pinnedId = null;
    this.marks = null;
    this.update();
    return wasPinned;
  }

  private update(): void {
    const target = this.hovered ?? this.pinnedId;
    this.traced =
      target === null || this.state === null
        ? null
        : tracedCellIds(this.state, target);
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export function useTraceMark(
  store: SandboxCanvasTraceStore,
  cellId: string,
): TraceMark {
  return useSyncExternalStore(
    store.subscribe,
    () => store.traceOf(cellId),
    () => null,
  );
}

export function useFieldMarks(
  store: SandboxCanvasTraceStore,
): FieldMarks | null {
  return useSyncExternalStore(store.subscribe, store.fieldMarks, () => null);
}

/** Says a Test mark, not only shows it. */
export function fieldMarkDescription(mark: string): string {
  return [
    mark.includes("trigger") ? "started the test" : "",
    mark.includes("changed") ? "changed in the test" : "",
  ]
    .filter(Boolean)
    .join(", ");
}
