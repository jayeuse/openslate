import {
  createMemorySeed,
  organizationChannel,
} from "../../support/comms-memory/memory/seed";
import type {
  CapabilityConfiguration,
  CommsContext,
} from "@/components/systems/comms/contract/types";

export const context: CommsContext = {
  org_id: "71000000-0000-4000-8000-000000000001",
  user_id: "71000000-0000-4000-8000-000000000002",
};
export function policyFixture() {
  const world = createMemorySeed(context, {
    role: "member",
    display_name: "You",
  });
  const person = world.people[context.user_id];
  // Without its category's department link the seed room is an organization channel.
  const channel = organizationChannel(Object.values(world.conversations)[0]);
  if (channel.kind !== "channel") throw new Error("Fixture needs a channel");
  world.conversations[channel.id] = channel;
  // Every person keeps a row a case may promote or turn into a direct message.
  world.members[channel.id] = Object.fromEntries(
    Object.keys(world.people).map((user_id) => [
      user_id,
      {
        user_id,
        member_role: "member" as const,
        joined_at: channel.created_at,
      },
    ]),
  );
  const category = Object.values(world.categories)[0];
  const department = Object.values(world.departments)[0];
  const group = Object.values(world.groups)[0];
  const peers = Object.values(world.people).filter(
    (p) => p.user_id !== context.user_id,
  );
  category.department_id = null;
  return {
    world,
    person,
    channel,
    category,
    department,
    group,
    peers,
    context,
  };
}
export function configure(
  f: ReturnType<typeof policyFixture>,
  config: CapabilityConfiguration,
) {
  const key =
    config.scope.kind === "workspace"
      ? "workspace"
      : (`${config.scope.kind}:${config.scope.id}` as const);
  f.world.configuration[key] = { settings: {}, capabilities: config };
}

export function caughtFailure(action: () => unknown): unknown {
  try {
    action();
    return null;
  } catch (error) {
    return error;
  }
}
