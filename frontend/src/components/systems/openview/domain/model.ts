import { z } from "zod";

export const OPENVIEW_SECTIONS = [
  "views",
  "dashboards",
  "charts",
  "reports",
] as const;
export type OpenViewSection = (typeof OPENVIEW_SECTIONS)[number];

const LEGACY_MODULE_IDS = [
  "service-requests",
  "equipment",
  "customers",
] as const;
type LegacyModuleId = (typeof LEGACY_MODULE_IDS)[number];

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function isSafeStoredIdentifier(value: unknown): value is string {
  return typeof value === "string" && identifierPattern.test(value);
}

function safeIdentifier(value: string | null): string | undefined {
  return isSafeStoredIdentifier(value) ? value : undefined;
}
export type OpenViewUrlState = {
  section?: OpenViewSection;
  module?: string;
  view?: string;
  dashboard?: string;
  /** The department whose dashboard the dashboards section shows (BD1). */
  department?: string;
  record?: string;
  report?: string;
  run?: string;
  /** Temporary View changes (`domain/temporary-view.ts`); never saved. */
  changes?: string;
  invalid?: boolean;
  invalidReportSelection?: boolean;
};

export function parseOpenViewUrl(
  raw: string,
): Required<Pick<OpenViewUrlState, "section" | "module">> &
  Omit<OpenViewUrlState, "section" | "module"> {
  const url = new URL(raw, "https://openslate.local/openview");
  const sectionValue = url.searchParams.get("section");
  const moduleValue = url.searchParams.get("module");
  const recordValue = url.searchParams.get("record");
  const viewValue = url.searchParams.get("view");
  const dashboardValue = url.searchParams.get("dashboard");
  const departmentValue = url.searchParams.get("department");
  const reportValue = url.searchParams.get("report");
  const runValue = url.searchParams.get("run");
  const changesValue = url.searchParams.get("changes");
  const legacyRecordsSection = sectionValue === "records";
  const section = legacyRecordsSection
    ? "views"
    : OPENVIEW_SECTIONS.includes(sectionValue as OpenViewSection)
      ? (sectionValue as OpenViewSection)
      : "views";
  let invalid = false;
  if (
    sectionValue &&
    !legacyRecordsSection &&
    !OPENVIEW_SECTIONS.includes(sectionValue as OpenViewSection)
  )
    invalid = true;
  const legacyModule = LEGACY_MODULE_IDS.includes(
    moduleValue as LegacyModuleId,
  );
  const uuidModule = z.string().uuid().safeParse(moduleValue).success;
  if (moduleValue && !legacyModule && !(section === "views" && uuidModule))
    invalid = true;
  for (const value of [recordValue, viewValue, dashboardValue])
    if (value && !safeIdentifier(value)) invalid = true;
  const report = z.string().uuid().safeParse(reportValue);
  const run = z.string().uuid().safeParse(runValue);
  const invalidReportSelection =
    section === "reports" &&
    ((reportValue !== null && !report.success) ||
      (runValue !== null && (!run.success || !report.success)));
  if (invalidReportSelection) invalid = true;
  const record = safeIdentifier(recordValue);
  const result: ReturnType<typeof parseOpenViewUrl> = {
    section: record ? "views" : section,
    module:
      record && !moduleValue
        ? "service-requests"
        : legacyModule || (section === "views" && uuidModule)
          ? (moduleValue ?? "service-requests")
          : "service-requests",
    invalid,
  };
  const view = safeIdentifier(viewValue);
  const dashboard = safeIdentifier(dashboardValue);
  if (record) result.record = record;
  if (view) result.view = view;
  if (dashboard) result.dashboard = dashboard;
  if (invalidReportSelection) result.invalidReportSelection = true;
  const department = z.string().uuid().safeParse(departmentValue);
  if (result.section === "dashboards" && department.success)
    result.department = department.data;
  if (result.section === "reports" && report.success)
    result.report = report.data;
  if (result.section === "reports" && report.success && run.success)
    result.run = run.data;
  if (changesValue && result.section === "views") result.changes = changesValue;
  return result;
}

export function serializeOpenViewUrl(state: OpenViewUrlState): string {
  const parameters = new URLSearchParams();
  if (state.report && !z.string().uuid().safeParse(state.report).success)
    return "/openview";
  if (
    state.run &&
    (!state.report || !z.string().uuid().safeParse(state.run).success)
  )
    return "/openview";
  if (state.record && !safeIdentifier(state.record)) return "/openview";
  if (state.view && !safeIdentifier(state.view)) return "/openview";
  if (state.dashboard && !safeIdentifier(state.dashboard)) return "/openview";
  if (state.section && OPENVIEW_SECTIONS.includes(state.section))
    parameters.set("section", state.section);
  if (state.module) {
    const isLegacyModule = LEGACY_MODULE_IDS.includes(
      state.module as LegacyModuleId,
    );
    const isViewsUuid =
      state.section === "views" &&
      z.string().uuid().safeParse(state.module).success;
    if (isLegacyModule || isViewsUuid) parameters.set("module", state.module);
  }
  if (state.view) parameters.set("view", state.view);
  if (
    state.section === "dashboards" &&
    state.department &&
    z.string().uuid().safeParse(state.department).success
  )
    parameters.set("department", state.department);
  if (state.dashboard) parameters.set("dashboard", state.dashboard);
  if (state.record) parameters.set("record", state.record);
  if (state.section === "reports" && state.report)
    parameters.set("report", state.report);
  if (state.section === "reports" && state.run)
    parameters.set("run", state.run);
  if (state.changes && state.section === "views")
    parameters.set("changes", state.changes);
  const query = parameters.toString();
  return query ? `/openview?${query}` : "/openview";
}
