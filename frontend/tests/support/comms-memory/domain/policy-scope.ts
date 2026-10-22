import type { SettingsScope } from "@/components/systems/comms/contract/types";
import type { MemoryPolicyWorld, MemoryScopeKey } from "../memory/model";
import { notFound } from "./access";

export const scopeKey = (scope: SettingsScope): MemoryScopeKey =>
  scope.kind === "workspace" ? "workspace" : `${scope.kind}:${scope.id}`;

/** Resolve ancestry from owned entities, not an input-supplied category chain. */
export function scopeChain(
  world: MemoryPolicyWorld,
  scope: SettingsScope,
): SettingsScope[] {
  if (scope.kind === "workspace") return [scope];
  if (scope.kind === "category") {
    if (world.categories[scope.id]?.org_id !== world.org_id) return notFound();
    return [{ kind: "workspace" }, scope];
  }
  const channel = world.conversations[scope.id];
  if (channel?.org_id !== world.org_id || channel.kind !== "channel")
    return notFound();
  return [
    ...scopeChain(
      world,
      channel.category_id
        ? { kind: "category", id: channel.category_id }
        : { kind: "workspace" },
    ),
    scope,
  ];
}
