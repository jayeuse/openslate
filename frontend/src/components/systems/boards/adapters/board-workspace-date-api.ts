import { z } from "zod";
import { apiFetch } from "@/lib/api";

const workspaceDateSchema = z.object({ today: z.iso.date() });

export async function getBoardWorkspaceToday(): Promise<string> {
  const workspace = await apiFetch("/workspace", workspaceDateSchema, {
    cache: "no-store",
  });
  return workspace.today;
}
