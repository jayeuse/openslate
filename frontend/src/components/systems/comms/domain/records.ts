/** Department color index on the Sandbox canvas; 0 is the neutral mark. */
export type GroupTone = 0 | 1 | 2 | 3 | 4;

/**
 * Where a record lives. Comms reads no record department, so the module names
 * it and the mark stays neutral.
 */
export function recordContext(record: { moduleName?: string } | undefined): {
  module: string;
  group: { name: string; tone: GroupTone } | undefined;
} {
  return { module: record?.moduleName ?? "Record", group: undefined };
}
