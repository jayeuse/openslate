"use client";
import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import type { CommsToolsDialog } from "./tools-dialog";

export const AdminTools = dynamic(() =>
  import("./tools-dialog").then((module) => module.CommsToolsDialog),
);
export type ToolView = ComponentProps<typeof CommsToolsDialog>["view"];
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
