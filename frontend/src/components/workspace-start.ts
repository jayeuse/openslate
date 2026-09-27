import { listOpenViewDataSources } from "@/components/systems/openview/adapters/views-api";
import { listSandboxTests } from "@/components/systems/sandbox/state/api";

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
    // A one-item Test list needs the same read access as the Sandbox
    // document, without downloading the document before the page loads it.
    await listSandboxTests({ limit: 1 });
    return "/sandbox";
  } catch {
    return "/openview";
  }
}
