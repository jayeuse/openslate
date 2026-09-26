import { listOpenViewDataSources } from "@/components/systems/openview/adapters/views-api";
import { loadSandboxDocument } from "@/components/systems/sandbox/state/api";

/**
 * Where a signed-in person starts. A workspace with nothing published has
 * nothing to show in OpenView yet, so a person who can open the Sandbox
 * starts there, where the organization gets designed. Everyone else, and any
 * failed check, goes to OpenView, which explains its own state.
 */
export async function workspaceStartRoute(): Promise<"/sandbox" | "/openview"> {
  try {
    const sources = await listOpenViewDataSources({ limit: 1 });
    if (sources.items.length > 0) return "/openview";
    await loadSandboxDocument();
    return "/sandbox";
  } catch {
    return "/openview";
  }
}
