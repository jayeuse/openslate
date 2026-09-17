"use client";

import { useCallback } from "react";
import {
  useSampleCommands,
  useSampleResource,
} from "../../shared/runtime/sample-async";
import {
  useSampleRuntime,
  type SampleTransactionDraft,
} from "../../shared/runtime/sample-state";
import { initialPeople, initialRoles } from "../../access/domain/model";
import {
  INITIAL_RECORDS,
  type SampleRecord,
} from "../../shared/data/sample-data";
import {
  initialDashboards,
  initialReport,
  initialReportTemplates,
} from "../domain/seeds";
import {
  INITIAL_CHART_SETTINGS,
  decodeChartSettings,
  decodeDashboards,
  decodeReport,
  decodeReports,
  decodeSavedViews,
  projectAudienceLookup,
  toLegacyDashboard,
  toLegacyReport,
  type AudienceLookup,
  type ChartSettings,
  type Dashboard,
  type OpenViewModuleId,
  type Report,
  type SavedView,
} from "../domain/model";

export const OPENVIEW_RUNTIME_KEYS = [
  "views-section",
  "views-module",
  "views-current",
  "views-saved",
  "views-default",
  "views-defaults",
  "views-selected",
  "views-dashboards",
  "views-dashboard-selected",
  "views-dashboard-default",
  "views-chart",
  "views-report-draft",
  "views-report-templates",
  "views-report-template-selected",
] as const;

const ACCESS_KEYS = ["access-roles", "access-people"] as const;
export const OPENVIEW_READ_KEYS = [
  "records",
  ...ACCESS_KEYS,
  ...OPENVIEW_RUNTIME_KEYS,
] as const;

export type OpenViewReadSnapshot = {
  records: SampleRecord[];
  roles: typeof initialRoles;
  people: typeof initialPeople;
  section: unknown;
  module: unknown;
  config: unknown;
  savedViews: unknown;
  defaultId: unknown;
  defaultMap: unknown;
  selectedView: unknown;
  dashboards: unknown;
  dashboardSelected: unknown;
  dashboardDefault: unknown;
  chart: unknown;
  reportDraft: unknown;
  reportTemplates: unknown;
  reportTemplateSelected: unknown;
};

export type OpenViewCommandFailure = {
  ok: false;
  error: string;
};

export type OpenViewCommandSuccess<T> = {
  ok: true;
  value: T;
};

export type OpenViewCommandResult<T> =
  OpenViewCommandSuccess<T> | OpenViewCommandFailure;

export function useOpenViewResource() {
  const runtime = useSampleRuntime();
  const load = useCallback(
    (signal: AbortSignal) =>
      runtime.load<OpenViewReadSnapshot>(
        (source) => ({
          records: source.read("records", INITIAL_RECORDS),
          roles: source.read("access-roles", initialRoles),
          people: source.read("access-people", initialPeople),
          section: source.read<unknown>("views-section", "views"),
          module: source.read<unknown>("views-module", "service-requests"),
          config: source.read<unknown>("views-current", null),
          savedViews: source.read<unknown>("views-saved", []),
          defaultId: source.read<unknown>("views-default", ""),
          defaultMap: source.read<unknown>("views-defaults", {}),
          selectedView: source.read<unknown>("views-selected", ""),
          dashboards: source.read<unknown>(
            "views-dashboards",
            initialDashboards,
          ),
          dashboardSelected: source.read<unknown>(
            "views-dashboard-selected",
            "",
          ),
          dashboardDefault: source.read<unknown>("views-dashboard-default", ""),
          chart: source.read<unknown>("views-chart", INITIAL_CHART_SETTINGS),
          reportDraft: source.read<unknown>("views-report-draft", null),
          reportTemplates: source.read<unknown>(
            "views-report-templates",
            initialReportTemplates,
          ),
          reportTemplateSelected: source.read<unknown>(
            "views-report-template-selected",
            "",
          ),
        }),
        { keys: OPENVIEW_READ_KEYS, signal },
      ),
    [runtime],
  );
  return useSampleResource({
    keys: OPENVIEW_READ_KEYS,
    queryKey: "openview:workspace",
    load,
  });
}

export type ViewCommandInput = {
  view: SavedView;
  expectedId?: string;
  expected?: SavedView;
};

export type DuplicateViewCommandInput = {
  sourceId: string;
  view: SavedView;
  expectedSource?: SavedView;
};

export type DashboardCommandInput = {
  dashboard: Dashboard;
  expectedId?: string;
  expected?: Dashboard;
};

export type DuplicateDashboardCommandInput = {
  sourceId: string;
  dashboard: Dashboard;
  expectedSource?: Dashboard;
};

export type ReportCommandInput = {
  report: Report;
  expectedId?: string;
  expected?: Report;
};

type DeleteDashboardResult = {
  remaining: Dashboard[];
  selectedId: string;
};

type DeleteReportResult = {
  remaining: Report[];
  draft: Report;
};

function accessLookup(draft: Pick<SampleTransactionDraft, "read">) {
  const roles = draft.read("access-roles", initialRoles);
  const people = draft.read("access-people", initialPeople);
  return projectAudienceLookup(roles, people);
}

function defaultMap(value: unknown): Partial<Record<OpenViewModuleId, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([moduleId, viewId]) =>
        ["service-requests", "equipment", "customers"].includes(moduleId) &&
        typeof viewId === "string" &&
        viewId.length > 0,
    ),
  ) as Partial<Record<OpenViewModuleId, string>>;
}

function savedViewsFrom(
  draft: Pick<SampleTransactionDraft, "read">,
  lookup: AudienceLookup,
): SavedView[] {
  return decodeSavedViews(draft.read("views-saved", []), lookup);
}

function dashboardsFrom(
  draft: Pick<SampleTransactionDraft, "read">,
  lookup: AudienceLookup,
): Dashboard[] {
  return decodeDashboards(
    draft.read("views-dashboards", initialDashboards),
    lookup,
  );
}

function reportsFrom(
  draft: Pick<SampleTransactionDraft, "read">,
  lookup: AudienceLookup,
): Report[] {
  return decodeReports(
    draft.read("views-report-templates", initialReportTemplates),
    lookup,
  );
}

function normalizedView(
  view: SavedView,
  lookup: AudienceLookup,
): SavedView | undefined {
  return decodeSavedViews([view], lookup)[0];
}

function normalizedDashboard(
  dashboard: Dashboard,
  lookup: AudienceLookup,
): Dashboard | undefined {
  return decodeDashboards([dashboard], lookup)[0];
}

function normalizedReport(report: Report, lookup: AudienceLookup): Report {
  return decodeReport(report, lookup);
}

function reject(draft: SampleTransactionDraft, error: string): never {
  return draft.reject<OpenViewCommandFailure>({ ok: false, error });
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * The report-save transaction is shared by the hook and isolated regression
 * coverage so a saved report, its draft, and its selected identity commit as
 * one recoverable state change.
 */
export function saveReportTemplateRecipe({
  report,
  expectedId,
  expected,
}: ReportCommandInput) {
  return (draft: SampleTransactionDraft): OpenViewCommandResult<Report> => {
    const lookup = accessLookup(draft);
    const templates = reportsFrom(draft, lookup);
    const current = templates.find((template) => template.id === expectedId);
    if (expectedId && !current)
      return reject(
        draft,
        "This report template changed or was deleted. Keep the editor open and try again.",
      );
    if (expectedId && expected && current && !sameValue(current, expected))
      return reject(
        draft,
        "This report template changed while it was being saved. Keep the editor open and try again.",
      );
    if (expectedId && report.id !== expectedId)
      return reject(
        draft,
        "This report template no longer matches the editor.",
      );
    if (!report.name.trim())
      return reject(draft, "Give this report a title before saving.");
    if (!report.fields.length)
      return reject(draft, "Select at least one field before saving.");
    const next = normalizedReport(
      { ...report, name: report.name.trim().slice(0, 80) },
      lookup,
    );
    if (!current && templates.some((template) => template.id === next.id))
      return reject(draft, "A report with this identity already exists.");
    draft.update(
      "views-report-templates",
      initialReportTemplates,
      [...templates.filter((template) => template.id !== next.id), next].map(
        (entry) => toLegacyReport(entry, lookup),
      ),
    );
    draft.update(
      "views-report-draft",
      initialReport,
      toLegacyReport(next, lookup),
    );
    draft.update("views-report-template-selected", "", next.id);
    return { ok: true, value: next };
  };
}

export type OpenViewCommandController = {
  saveView(input: ViewCommandInput): Promise<OpenViewCommandResult<SavedView>>;
  duplicateView(
    input: DuplicateViewCommandInput,
  ): Promise<OpenViewCommandResult<SavedView>>;
  deleteView(
    id: string,
    expected?: SavedView,
  ): Promise<OpenViewCommandResult<{ selectedId: string }>>;
  setViewDefault(
    moduleId: OpenViewModuleId,
    id: string | null,
  ): Promise<OpenViewCommandResult<string | null>>;
  saveDashboard(
    input: DashboardCommandInput,
  ): Promise<OpenViewCommandResult<Dashboard>>;
  createDashboard(
    dashboard: Dashboard,
  ): Promise<OpenViewCommandResult<Dashboard>>;
  duplicateDashboard(
    input: DuplicateDashboardCommandInput,
  ): Promise<OpenViewCommandResult<Dashboard>>;
  deleteDashboard(
    id: string,
    expected?: Dashboard,
  ): Promise<OpenViewCommandResult<DeleteDashboardResult>>;
  setDashboardDefault(
    id: string | null,
  ): Promise<OpenViewCommandResult<string | null>>;
  saveChartSettings(
    settings: ChartSettings,
  ): Promise<OpenViewCommandResult<ChartSettings>>;
  resetChartSettings(
    moduleId: OpenViewModuleId,
  ): Promise<OpenViewCommandResult<ChartSettings>>;
  duplicateReportDraft(report: Report): Promise<OpenViewCommandResult<Report>>;
  saveReportTemplate(
    input: ReportCommandInput,
  ): Promise<OpenViewCommandResult<Report>>;
  deleteReportTemplate(
    id: string,
    expected?: Report,
  ): Promise<OpenViewCommandResult<DeleteReportResult>>;
  resetReportDraft(report: Report): Promise<OpenViewCommandResult<Report>>;
  resetOpenView(): Promise<OpenViewCommandResult<null>>;
  isPending(key?: string): boolean;
  pendingKeys: readonly string[];
};

/**
 * OpenView's asynchronous command boundary. Every recipe reads current state
 * inside the runtime transaction, and edit commands compare the submitted
 * baseline with that current entry before accepting a save, duplicate, or
 * delete. A command therefore cannot silently overwrite a change that arrived
 * while it was waiting.
 */
export function useOpenViewCommands(): OpenViewCommandController {
  const runtime = useSampleRuntime();
  const commands = useSampleCommands();
  const run = useCallback(
    <T>(
      key: string,
      recipe: (draft: SampleTransactionDraft) => T,
      keys: readonly string[] = OPENVIEW_RUNTIME_KEYS,
    ): Promise<T> =>
      commands.run(key, (signal) => runtime.execute(recipe, { keys, signal })),
    [commands, runtime],
  );

  const saveView = useCallback(
    ({ view, expectedId, expected }: ViewCommandInput) =>
      run(
        `openview.view.save:${expectedId ?? "new"}`,
        (draft) => {
          const lookup = accessLookup(draft);
          const views = savedViewsFrom(draft, lookup);
          const current = expectedId
            ? views.find((candidate) => candidate.id === expectedId)
            : undefined;
          if (expectedId && !current)
            return reject(
              draft,
              "This saved view changed or was deleted. Keep the editor open and try again.",
            );
          if (
            expectedId &&
            expected &&
            current &&
            !sameValue(current, expected)
          )
            return reject(
              draft,
              "This saved view changed while it was being saved. Keep the editor open and try again.",
            );
          if (!view.name.trim())
            return reject(draft, "Give this view a name before saving.");
          const next = normalizedView(
            { ...view, name: view.name.trim().slice(0, 80) },
            lookup,
          );
          if (!next)
            return reject(draft, "This view contains unsupported settings.");
          if (!current && views.some((candidate) => candidate.id === next.id))
            return reject(draft, "A view with this identity already exists.");
          draft.update(
            "views-saved",
            [],
            [...views.filter((candidate) => candidate.id !== next.id), next],
          );
          return { ok: true as const, value: next };
        },
        [...ACCESS_KEYS, "views-saved"],
      ),
    [run],
  );

  const duplicateView = useCallback(
    ({ sourceId, view, expectedSource }: DuplicateViewCommandInput) =>
      run(
        `openview.view.duplicate:${sourceId}`,
        (draft) => {
          const lookup = accessLookup(draft);
          const views = savedViewsFrom(draft, lookup);
          if (!views.some((candidate) => candidate.id === sourceId))
            return reject(
              draft,
              "This saved view changed or was deleted. Refresh the workspace and try again.",
            );
          const source = views.find((candidate) => candidate.id === sourceId);
          if (expectedSource && source && !sameValue(source, expectedSource))
            return reject(
              draft,
              "This saved view changed while it was being duplicated. Try again.",
            );
          const next = normalizedView(view, lookup);
          if (!next || views.some((candidate) => candidate.id === next.id))
            return reject(draft, "The duplicate view could not be prepared.");
          draft.update("views-saved", [], [...views, next]);
          return { ok: true as const, value: next };
        },
        [...ACCESS_KEYS, "views-saved"],
      ),
    [run],
  );

  const deleteView = useCallback(
    (id: string, expected?: SavedView) =>
      run(
        `openview.view.delete:${id}`,
        (draft) => {
          const lookup = accessLookup(draft);
          const views = savedViewsFrom(draft, lookup);
          const current = views.find((candidate) => candidate.id === id);
          if (!current)
            return reject(draft, "This saved view is no longer available.");
          if (expected && !sameValue(current, expected))
            return reject(
              draft,
              "This saved view changed while it was being deleted. Try again.",
            );
          const defaults = defaultMap(draft.read("views-defaults", {}));
          const nextDefaults = Object.fromEntries(
            Object.entries(defaults).filter(([, value]) => value !== id),
          );
          draft.update(
            "views-saved",
            [],
            views.filter((view) => view.id !== id),
          );
          draft.update("views-defaults", {}, nextDefaults);
          if (draft.read("views-default", "") === id)
            draft.update("views-default", "", "");
          return { ok: true as const, value: { selectedId: "" } };
        },
        [...ACCESS_KEYS, "views-saved", "views-defaults", "views-default"],
      ),
    [run],
  );

  const setViewDefault = useCallback(
    (moduleId: OpenViewModuleId, id: string | null) =>
      run(
        `openview.view.default:${moduleId}`,
        (draft) => {
          const lookup = accessLookup(draft);
          const views = savedViewsFrom(draft, lookup);
          if (
            id &&
            !views.some((view) => view.id === id && view.moduleId === moduleId)
          )
            return reject(
              draft,
              "Choose a saved view from this data source first.",
            );
          const defaults = defaultMap(draft.read("views-defaults", {}));
          const nextDefaults = { ...defaults };
          if (id) nextDefaults[moduleId] = id;
          else delete nextDefaults[moduleId];
          draft.update("views-defaults", {}, nextDefaults);
          if (moduleId === "service-requests")
            draft.update("views-default", "", id ?? "");
          return { ok: true as const, value: id };
        },
        [...ACCESS_KEYS, "views-saved", "views-defaults", "views-default"],
      ),
    [run],
  );

  const saveDashboard = useCallback(
    ({ dashboard, expectedId, expected }: DashboardCommandInput) =>
      run(
        `openview.dashboard.save:${expectedId ?? dashboard.id}`,
        (draft) => {
          const lookup = accessLookup(draft);
          const dashboards = dashboardsFrom(draft, lookup);
          const current = expectedId
            ? dashboards.find((candidate) => candidate.id === expectedId)
            : undefined;
          if (expectedId && !current)
            return reject(
              draft,
              "This dashboard changed or was deleted. Keep the editor open and try again.",
            );
          if (
            expectedId &&
            expected &&
            current &&
            !sameValue(current, expected)
          )
            return reject(
              draft,
              "This dashboard changed while it was being saved. Keep the editor open and try again.",
            );
          if (!dashboard.name.trim())
            return reject(draft, "Give this dashboard a name before saving.");
          const next = normalizedDashboard(
            { ...dashboard, name: dashboard.name.trim().slice(0, 80) },
            lookup,
          );
          if (!next)
            return reject(
              draft,
              "This dashboard contains unsupported settings.",
            );
          if (
            !current &&
            dashboards.some((candidate) => candidate.id === next.id)
          )
            return reject(
              draft,
              "A dashboard with this identity already exists.",
            );
          draft.update(
            "views-dashboards",
            initialDashboards,
            [
              ...dashboards.filter((candidate) => candidate.id !== next.id),
              next,
            ].map((dashboard) => toLegacyDashboard(dashboard, lookup)),
          );
          return { ok: true as const, value: next };
        },
        [...ACCESS_KEYS, "views-dashboards"],
      ),
    [run],
  );

  const createDashboard = useCallback(
    (dashboard: Dashboard) => saveDashboard({ dashboard }),
    [saveDashboard],
  );

  const duplicateDashboard = useCallback(
    ({ sourceId, dashboard, expectedSource }: DuplicateDashboardCommandInput) =>
      run(
        `openview.dashboard.duplicate:${sourceId}`,
        (draft) => {
          const lookup = accessLookup(draft);
          const dashboards = dashboardsFrom(draft, lookup);
          if (!dashboards.some((candidate) => candidate.id === sourceId))
            return reject(
              draft,
              "This dashboard changed or was deleted. Try again.",
            );
          const source = dashboards.find(
            (candidate) => candidate.id === sourceId,
          );
          if (expectedSource && source && !sameValue(source, expectedSource))
            return reject(
              draft,
              "This dashboard changed while it was being duplicated. Try again.",
            );
          const next = normalizedDashboard(dashboard, lookup);
          if (!next || dashboards.some((candidate) => candidate.id === next.id))
            return reject(
              draft,
              "The duplicate dashboard could not be prepared.",
            );
          draft.update(
            "views-dashboards",
            initialDashboards,
            [...dashboards, next].map((dashboard) =>
              toLegacyDashboard(dashboard, lookup),
            ),
          );
          return { ok: true as const, value: next };
        },
        [...ACCESS_KEYS, "views-dashboards"],
      ),
    [run],
  );

  const deleteDashboard = useCallback(
    (id: string, expected?: Dashboard) =>
      run(
        `openview.dashboard.delete:${id}`,
        (draft) => {
          const lookup = accessLookup(draft);
          const dashboards = dashboardsFrom(draft, lookup);
          const current = dashboards.find((dashboard) => dashboard.id === id);
          if (!current)
            return reject(draft, "This dashboard is no longer available.");
          if (expected && !sameValue(current, expected))
            return reject(
              draft,
              "This dashboard changed while it was being deleted. Try again.",
            );
          const remaining = dashboards.filter(
            (dashboard) => dashboard.id !== id,
          );
          draft.update(
            "views-dashboards",
            initialDashboards,
            remaining.map((dashboard) => toLegacyDashboard(dashboard, lookup)),
          );
          if (draft.read("views-dashboard-default", "") === id)
            draft.update("views-dashboard-default", "", "");
          return {
            ok: true as const,
            value: { remaining, selectedId: remaining[0]?.id ?? "" },
          };
        },
        [...ACCESS_KEYS, "views-dashboards", "views-dashboard-default"],
      ),
    [run],
  );

  const setDashboardDefault = useCallback(
    (id: string | null) =>
      run(
        "openview.dashboard.default",
        (draft) => {
          const lookup = accessLookup(draft);
          const dashboards = dashboardsFrom(draft, lookup);
          if (id && !dashboards.some((dashboard) => dashboard.id === id))
            return reject(draft, "Choose an existing dashboard first.");
          draft.update("views-dashboard-default", "", id ?? "");
          return { ok: true as const, value: id };
        },
        [...ACCESS_KEYS, "views-dashboards", "views-dashboard-default"],
      ),
    [run],
  );

  const saveChartSettings = useCallback(
    (settings: ChartSettings) =>
      run(
        "openview.chart.save",
        (draft) => {
          const next = decodeChartSettings(settings);
          draft.update("views-chart", INITIAL_CHART_SETTINGS, next);
          return { ok: true as const, value: next };
        },
        ["views-chart"],
      ),
    [run],
  );

  const resetChartSettings = useCallback(
    (moduleId: OpenViewModuleId) =>
      run(
        "openview.chart.reset",
        (draft) => {
          const next = decodeChartSettings({
            ...INITIAL_CHART_SETTINGS,
            moduleId,
          });
          draft.update("views-chart", INITIAL_CHART_SETTINGS, next);
          return { ok: true as const, value: next };
        },
        ["views-chart"],
      ),
    [run],
  );

  const duplicateReportDraft = useCallback(
    (report: Report) =>
      run(
        "openview.report.duplicate",
        (draft) => {
          const lookup = accessLookup(draft);
          const next = normalizedReport(report, lookup);
          draft.update(
            "views-report-draft",
            initialReport,
            toLegacyReport(next, lookup),
          );
          draft.update("views-report-template-selected", "", "");
          return { ok: true as const, value: next };
        },
        [
          ...ACCESS_KEYS,
          "views-report-draft",
          "views-report-template-selected",
        ],
      ),
    [run],
  );

  const saveReportTemplate = useCallback(
    ({ report, expectedId, expected }: ReportCommandInput) =>
      run(
        `openview.report.save:${expectedId ?? report.id}`,
        saveReportTemplateRecipe({ report, expectedId, expected }),
        [
          ...ACCESS_KEYS,
          "views-report-draft",
          "views-report-templates",
          "views-report-template-selected",
        ],
      ),
    [run],
  );

  const deleteReportTemplate = useCallback(
    (id: string, expected?: Report) =>
      run(
        `openview.report.delete:${id}`,
        (draft) => {
          const lookup = accessLookup(draft);
          const templates = reportsFrom(draft, lookup);
          const current = templates.find((template) => template.id === id);
          if (!current)
            return reject(
              draft,
              "This report template is no longer available.",
            );
          if (expected && !sameValue(current, expected))
            return reject(
              draft,
              "This report template changed while it was being deleted. Try again.",
            );
          const remaining = templates.filter((template) => template.id !== id);
          const next = decodeReport(initialReport, lookup);
          draft.update(
            "views-report-templates",
            initialReportTemplates,
            remaining.map((report) => toLegacyReport(report, lookup)),
          );
          draft.update(
            "views-report-draft",
            initialReport,
            toLegacyReport(next, lookup),
          );
          draft.update("views-report-template-selected", "", "");
          return { ok: true as const, value: { remaining, draft: next } };
        },
        [
          ...ACCESS_KEYS,
          "views-report-draft",
          "views-report-templates",
          "views-report-template-selected",
        ],
      ),
    [run],
  );

  const resetReportDraft = useCallback(
    (report: Report) =>
      run(
        "openview.report.reset",
        (draft) => {
          const lookup = accessLookup(draft);
          const next = normalizedReport(report, lookup);
          draft.update(
            "views-report-draft",
            initialReport,
            toLegacyReport(next, lookup),
          );
          draft.update("views-report-template-selected", "", "");
          return { ok: true as const, value: next };
        },
        [
          ...ACCESS_KEYS,
          "views-report-draft",
          "views-report-template-selected",
        ],
      ),
    [run],
  );

  const resetOpenView = useCallback(
    () =>
      commands.run("openview.reset", async (signal) => {
        if (signal.aborted)
          throw new DOMException("The reset was cancelled.", "AbortError");
        runtime.resetKeys(OPENVIEW_RUNTIME_KEYS);
        return { ok: true as const, value: null };
      }),
    [commands, runtime],
  );

  return {
    saveView,
    duplicateView,
    deleteView,
    setViewDefault,
    saveDashboard,
    createDashboard,
    duplicateDashboard,
    deleteDashboard,
    setDashboardDefault,
    saveChartSettings,
    resetChartSettings,
    duplicateReportDraft,
    saveReportTemplate,
    deleteReportTemplate,
    resetReportDraft,
    resetOpenView,
    isPending: commands.isPending,
    pendingKeys: commands.pendingKeys,
  };
}
