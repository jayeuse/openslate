"use client";

import type { SandboxInspectorProps } from "./sandbox-inspector-types";
import { SandboxInspectorOutline } from "./sandbox-inspector-outline";
import { SandboxInspectorProperties } from "./sandbox-inspector-properties";

export type {
  SandboxInspectorTargetKind,
  SandboxInspectorTarget,
  SandboxInspectorProps,
} from "./sandbox-inspector-types";

/** Persistent inspector coordinator; focused sections own only their local view state. */
export function SandboxInspector(props: SandboxInspectorProps) {
  const { mode = "combined", ...sectionProps } = props;
  const showOutline = mode !== "properties";
  const showProperties = mode !== "outline";

  return (
    <section
      aria-label={
        showOutline && showProperties
          ? "Inspector"
          : showOutline
            ? "Structure"
            : "Properties"
      }
      data-testid={
        showOutline && showProperties
          ? "inspector-root"
          : showOutline
            ? "inspector-outline-root"
            : "inspector-properties"
      }
      className="flex flex-col gap-4"
    >
      <SandboxInspectorOutline {...sectionProps} visible={showOutline} />
      <SandboxInspectorProperties {...sectionProps} visible={showProperties} />
    </section>
  );
}
