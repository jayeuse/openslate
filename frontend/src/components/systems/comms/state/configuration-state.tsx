"use client";
import { useCommsWorkspaceView } from "./use-comms-workspace";
export function useCommsConfiguration() {
  return [useCommsWorkspaceView().configuration] as const;
}
