import { LevelBadge } from "@/components/systems/comms/components/member-level";

import { levelLabels } from "../helpers/people";
import type { AccessLevel } from "../state/api";

/**
 * An Access level as the shared level chip (decision A6): Read is the
 * outline chip, Write the secondary chip, and Manage the one tinted level.
 * The chip is shared with OpenComms; the words are Access's own.
 */
export function AccessLevelBadge({
  level,
  className,
}: {
  level: AccessLevel;
  className?: string;
}) {
  return (
    <LevelBadge
      level={level === "write" ? "post" : level}
      label={levelLabels[level]}
      className={className}
    />
  );
}
