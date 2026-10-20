"use client";
import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import type { CommsToolsDialog } from "./tools-dialog";

const LiveTools = dynamic(() =>
  import("./tools-dialog").then((module) => module.CommsToolsDialog),
);
const ExampleTools = dynamic(() =>
  import("./example-tools").then((module) => module.ExampleTools),
);
export function AdminTools(props: ComponentProps<typeof CommsToolsDialog>) {
  return ["management", "templates", "history"].includes(props.view) ? (
    <ExampleTools {...props} />
  ) : (
    <LiveTools {...props} />
  );
}
export type ToolView = ComponentProps<typeof CommsToolsDialog>["view"];
export const mainToolViews: readonly ToolView[] = [
  "management",
  "templates",
  "history",
  "moderation",
  "outbox",
  "retention",
  "export",
];
export const toolViews: readonly ToolView[] = [
  "management",
  "templates",
  "history",
  "moderation",
  "outbox",
  "retention",
  "export",
  "thread",
  "message-history",
  "report",
];
