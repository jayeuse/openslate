import { queryOptions } from "@tanstack/react-query";
import { getSandboxBindings } from "./lifecycle-api";

export const sandboxKeys = {
  bindings: ["sandbox", "bindings"] as const,
  bindingsRevision: (revision: number) =>
    ["sandbox", "bindings", revision] as const,
};

export function sandboxBindingsOptions(revision: number) {
  return queryOptions({
    queryKey: sandboxKeys.bindingsRevision(revision),
    queryFn: ({ signal }) => getSandboxBindings(signal),
    enabled: revision > 0,
  });
}
