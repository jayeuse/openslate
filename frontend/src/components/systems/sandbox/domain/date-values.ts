export type SandboxDateKind = "date" | "datetime";

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value)
  );
}

export function dateTimeInstant(value: string): number | undefined {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(
      value,
    )
  )
    return undefined;
  const [date] = value.split("T");
  if (!validDate(date)) return undefined;
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function comparable(
  value: string,
  kind: SandboxDateKind,
): string | number | undefined {
  if (kind === "date") return validDate(value) ? value : undefined;
  return dateTimeInstant(value);
}

export function dateRangeFits(
  kind: SandboxDateKind,
  sourceMinimum: string | undefined,
  sourceMaximum: string | undefined,
  targetMinimum: string | undefined,
  targetMaximum: string | undefined,
): boolean {
  const sourceMin =
    sourceMinimum === undefined ? undefined : comparable(sourceMinimum, kind);
  const sourceMax =
    sourceMaximum === undefined ? undefined : comparable(sourceMaximum, kind);
  const targetMin =
    targetMinimum === undefined ? undefined : comparable(targetMinimum, kind);
  const targetMax =
    targetMaximum === undefined ? undefined : comparable(targetMaximum, kind);
  if (
    (sourceMinimum !== undefined && sourceMin === undefined) ||
    (sourceMaximum !== undefined && sourceMax === undefined) ||
    (targetMinimum !== undefined && targetMin === undefined) ||
    (targetMaximum !== undefined && targetMax === undefined)
  )
    return false;
  return (
    (targetMin === undefined ||
      (sourceMin !== undefined && sourceMin >= targetMin)) &&
    (targetMax === undefined ||
      (sourceMax !== undefined && sourceMax <= targetMax))
  );
}

export function dateValueInRange(
  kind: SandboxDateKind,
  value: string,
  earliest: string | undefined,
  latest: string | undefined,
): boolean {
  const comparableValue = comparable(value, kind);
  const comparableEarliest =
    earliest === undefined ? undefined : comparable(earliest, kind);
  const comparableLatest =
    latest === undefined ? undefined : comparable(latest, kind);
  if (
    comparableValue === undefined ||
    (earliest !== undefined && comparableEarliest === undefined) ||
    (latest !== undefined && comparableLatest === undefined)
  )
    return false;
  return (
    (comparableEarliest === undefined ||
      comparableValue >= comparableEarliest) &&
    (comparableLatest === undefined || comparableValue <= comparableLatest)
  );
}
