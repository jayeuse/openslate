/**
 * Where a record lives. Comms reads no record department, so the module names
 * it and the mark stays neutral.
 */
export function recordContext(record: { moduleName?: string } | undefined): {
  module: string;
} {
  return { module: record?.moduleName ?? "Record" };
}
