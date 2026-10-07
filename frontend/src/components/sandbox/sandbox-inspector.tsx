"use client";

import type { SandboxInspectorProps } from "./sandbox-inspector-types";
import { SandboxInspectorOutline } from "./sandbox-inspector-outline";

export type {
  SandboxInspectorTargetKind,
  SandboxInspectorTarget,
  SandboxInspectorProps,
} from "./sandbox-inspector-types";

/** Persistent structure inspector; the Designer owns the visible properties editor. */
export function SandboxInspector(props: SandboxInspectorProps) {
  return (
    <section
      aria-label="Structure"
      data-testid="inspector-outline-root"
      className="flex flex-col gap-4"
    >
      <SandboxInspectorOutline {...props} visible />
    </section>
  );
}
