"use client";
import type { ReactNode } from "react";
import { useCommsClient } from "../state/client-context";
import { SettingsAdvanced } from "./settings-advanced";

export function ToolAdvanced({
  tool,
  count = 0,
  children,
}: {
  tool: string;
  count?: number;
  children: ReactNode;
}) {
  const { client } = useCommsClient();
  return (
    <SettingsAdvanced
      storageKey={`openslate:comms:advanced:${client?.context.org_id}:${client?.context.user_id}:tools:${tool}`}
      count={count}
    >
      {children}
    </SettingsAdvanced>
  );
}
