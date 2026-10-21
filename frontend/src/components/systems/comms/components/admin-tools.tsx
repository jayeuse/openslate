"use client";
import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import type { CommsToolsDialog } from "./tools-dialog";

const LiveTools = dynamic(() =>
  import("./tools-dialog").then((module) => module.CommsToolsDialog),
);
export function AdminTools(props: ComponentProps<typeof CommsToolsDialog>) {
  return <LiveTools {...props} />;
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
