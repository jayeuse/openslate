import type { Page, Route } from "@playwright/test";
import { signedInAs } from "./test";
import { pageOf } from "../../helpers/pagination";
import { wireField, wireRecord } from "../../helpers/wire";

// A fake backend for a module page and its Reports view (OpenView part C,
// docs/specs/openview-reports-in-modules.md): one department with the Assets
// module, its fields, saved views and records, and the report, run, schedule
// and purge routes. Specs change its state and read what it was sent.

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const reportIds = {
  user: id(101),
  department: id(102),
  module: id(103),
  assetField: id(104),
  report: id(105),
  run: id(106),
  schedule: id(107),
  statusField: id(108),
  newReport: id(109),
  otherDepartment: id(110),
  otherModule: id(111),
  otherReport: id(112),
  inService: id(113),
  inspectionDue: id(114),
  record: id(115),
  view: id(116),
  olderRun: id(117),
  goneReport: id(118),
};
export const reportTimestamp = "2026-09-24T00:00:00Z";

type WireRecipe = {
  version: 1;
  fields: { field_id: string; expected_type: string }[];
  filters: Record<string, unknown>[];
  logic: "and" | "or";
  sorts: Record<string, unknown>[];
  group_by: { field_id: string; expected_type: string } | null;
  include_row_count: boolean;
};
export type WireReport = {
  id: string;
  module_id: string;
  name: string;
  subtitle: string | null;
  revision: number;
  recipe: WireRecipe;
  is_deleted: boolean;
  created_at: string;
  updated_at: string;
};
export type WireRun = {
  id: string;
  report_id: string;
  recipe_revision: number;
  row_count: number;
  headings: string[];
  created_at: string;
};
export type WireSchedule = {
  id: string;
  report_id: string;
  revision: number;
  enabled: boolean;
  cadence: "daily" | "weekly" | "monthly";
  timezone_name: string;
  local_time: string;
  weekday: number | null;
  month_day: number | null;
  next_due_at: string | null;
  last_run: {
    state: "pending" | "running" | "succeeded" | "failed" | "canceled";
    finished_at: string | null;
    failure_label: string | null;
  } | null;
  created_at: string;
  updated_at: string;
};

export function wireReport(overrides: Partial<WireReport> = {}): WireReport {
  return {
    id: reportIds.report,
    module_id: reportIds.module,
    name: "Operations review",
    subtitle: null,
    revision: 1,
    recipe: {
      version: 1,
      fields: [{ field_id: reportIds.assetField, expected_type: "text" }],
      filters: [],
      logic: "and",
      sorts: [],
      group_by: null,
      include_row_count: false,
    },
    is_deleted: false,
    created_at: reportTimestamp,
    updated_at: reportTimestamp,
    ...overrides,
  };
}

export function wireRun(overrides: Partial<WireRun> = {}): WireRun {
  return {
    id: reportIds.run,
    report_id: reportIds.report,
    recipe_revision: 1,
    row_count: 1,
    headings: ["Asset"],
    created_at: reportTimestamp,
    ...overrides,
  };
}

/** Every Monday at 09:00 in Manila: next Mon, Sep 28 at 09:00 there. */
export function wireSchedule(
  overrides: Partial<WireSchedule> = {},
): WireSchedule {
  return {
    id: reportIds.schedule,
    report_id: reportIds.report,
    revision: 1,
    enabled: true,
    cadence: "weekly",
    timezone_name: "Asia/Manila",
    local_time: "09:00",
    weekday: 0,
    month_day: null,
    next_due_at: "2026-09-28T01:00:00Z",
    last_run: null,
    created_at: reportTimestamp,
    updated_at: reportTimestamp,
    ...overrides,
  };
}

const assetField = wireField({
  id: reportIds.assetField,
  module_id: reportIds.module,
  name: "Asset",
  type: "text",
  required: true,
  position: 0,
});
const statusField = wireField({
  id: reportIds.statusField,
  module_id: reportIds.module,
  name: "Status",
  type: "select",
  position: 1,
  config: {
    options: [
      { id: reportIds.inService, label: "In service" },
      { id: reportIds.inspectionDue, label: "Inspection due" },
    ],
  },
});

export type ModuleReportsApiOptions = {
  /** The account role; the default is a member. */
  role?: "admin" | "member" | "guest";
  /** The member's level on the department; the default manages it. */
  level?: "read" | "write" | "manage";
  reports?: WireReport[];
  /** Copies by report, newest first. */
  runs?: Record<string, WireRun[]>;
  /** Schedules by report; a missing report has none (404). */
  schedules?: Record<string, WireSchedule>;
  /** Saved views of the Assets module. */
  views?: Record<string, unknown>[];
  /** A second department's Invoices module the member reads. */
  otherModule?: boolean;
  /** The CSV of every copy. */
  csv?: string;
  /** Module fields beyond the first page (later pages answer 403). */
  moreFields?: boolean;
};

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, json: body });

export async function installModuleReportsApi(
  page: Page,
  options: ModuleReportsApiOptions = {},
) {
  const state = {
    reports: [...(options.reports ?? [wireReport()])],
    runs: { ...(options.runs ?? { [reportIds.report]: [wireRun()] }) },
    schedules: {
      ...(options.schedules ?? { [reportIds.report]: wireSchedule() }),
    },
    csv: options.csv ?? "Asset\r\nForklift\r\n",
    /** Answers the next run command with this status, then succeeds. */
    failNextRun: 0,
    /** Answers the next report update with a stale-revision conflict. */
    conflictNextUpdate: false,
    /** Refuses (403) report reads while true. */
    denyReports: false,
    /** Holds report list reads until the returned release is called. */
    listHold: null as Promise<void> | null,
    listReads: [] as string[],
    reportReads: [] as string[],
    creates: [] as Record<string, unknown>[],
    updates: [] as Record<string, unknown>[],
    runKeys: [] as (string | null)[],
    scheduleWrites: [] as Record<string, unknown>[],
    csvReads: 0,
    purges: 0,
  };
  await signedInAs(page, {
    id: reportIds.user,
    role: options.role ?? "member",
    access: [
      {
        department_id: reportIds.department,
        module_id: null,
        level: options.level ?? "manage",
      },
      ...(options.otherModule
        ? [
            {
              department_id: reportIds.otherDepartment,
              module_id: reportIds.otherModule,
              level: "read" as const,
            },
          ]
        : []),
    ],
  });
  const department = (departmentId: string, name: string) => ({
    id: departmentId,
    department_name: name,
    created_at: reportTimestamp,
    updated_at: reportTimestamp,
    deleted_at: null,
    is_deleted: false,
    performed_by: null,
  });
  await page.route(
    (url) => url.pathname === "/api/departments",
    (route) =>
      json(
        route,
        pageOf(
          [
            department(reportIds.department, "Field operations"),
            ...(options.otherModule
              ? [department(reportIds.otherDepartment, "Finance")]
              : []),
          ],
          { limit: 100 },
        ),
      ),
  );
  await page.route("**/api/views**", (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/api/views/data-sources")
      return json(
        route,
        pageOf(
          [
            {
              id: reportIds.module,
              name: "Assets",
              department_id: reportIds.department,
              title_field_id: reportIds.assetField,
            },
            ...(options.otherModule
              ? [
                  {
                    id: reportIds.otherModule,
                    name: "Invoices",
                    department_id: reportIds.otherDepartment,
                    title_field_id: null,
                  },
                ]
              : []),
          ],
          { limit: 100 },
        ),
      );
    const fields = /^\/api\/views\/data-sources\/([^/]+)\/fields$/.exec(path);
    if (fields) {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      if (offset > 0) return json(route, { detail: "Forbidden" }, 403);
      const items = [assetField, statusField].map((field) => ({
        ...field,
        module_id: fields[1],
      }));
      return json(
        route,
        pageOf(items, {
          limit: 100,
          total: options.moreFields ? 3 : items.length,
        }),
      );
    }
    if (path === "/api/views")
      return json(route, pageOf(options.views ?? [], { limit: 20 }));
    const view = (options.views ?? []).find(
      (entry) => path === `/api/views/${String(entry.id)}`,
    );
    if (view) return json(route, view);
    return route.fallback();
  });
  await page.route("**/api/records/query", (route) =>
    json(
      route,
      pageOf(
        [
          wireRecord({
            id: reportIds.record,
            module_id: reportIds.module,
            data: { [reportIds.assetField]: "Forklift" },
            created_at: reportTimestamp,
            updated_at: reportTimestamp,
          }),
        ],
        { limit: 25 },
      ),
    ),
  );
  await page.route("**/api/reports**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const known = (reportId: string) =>
      state.reports.find((report) => report.id === reportId);
    if (path === "/api/reports" && method === "GET") {
      state.listReads.push(url.search);
      const hold = state.listHold;
      if (hold) await hold;
      if (state.denyReports) return json(route, { detail: "Forbidden" }, 403);
      const moduleId = url.searchParams.get("module_id");
      const deleted = url.searchParams.get("deleted") ?? "exclude";
      const items = state.reports.filter(
        (report) =>
          (!moduleId || report.module_id === moduleId) &&
          (deleted === "only" ? report.is_deleted : !report.is_deleted),
      );
      return json(route, pageOf(items, { limit: 100 }));
    }
    if (path === "/api/reports" && method === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.creates.push(body);
      const created = wireReport({
        id: reportIds.newReport,
        module_id: String(body.module_id),
        name: String(body.name),
        subtitle: (body.subtitle as string | null | undefined) ?? null,
        recipe: body.recipe as WireRecipe,
      });
      state.reports.push(created);
      return route.fulfill({
        status: 201,
        headers: { Location: `/api/reports/${created.id}` },
        json: created,
      });
    }
    const one = /^\/api\/reports\/([^/]+)$/.exec(path);
    if (one) {
      const report = known(one[1]!);
      if (method === "GET") {
        state.reportReads.push(one[1]!);
        if (state.denyReports) return json(route, { detail: "Forbidden" }, 403);
        return report
          ? json(route, report)
          : json(route, { detail: "Report not found" }, 404);
      }
      if (!report) return json(route, { detail: "Report not found" }, 404);
      if (method === "PATCH") {
        const body = request.postDataJSON() as Record<string, unknown>;
        state.updates.push(body);
        if (state.conflictNextUpdate) {
          state.conflictNextUpdate = false;
          report.revision += 1;
          return json(
            route,
            {
              detail: {
                code: "stale_revision",
                message: "Report changed; reload before saving",
                current_revision: report.revision,
              },
            },
            409,
          );
        }
        Object.assign(report, {
          name: body.name ?? report.name,
          subtitle: body.subtitle ?? report.subtitle,
          recipe: body.recipe ?? report.recipe,
          revision: report.revision + 1,
        });
        return json(route, report);
      }
      if (method === "DELETE") {
        report.is_deleted = true;
        report.revision += 1;
        return route.fulfill({ status: 204 });
      }
    }
    const restore = /^\/api\/reports\/([^/]+)\/restore$/.exec(path);
    if (restore && method === "POST") {
      const report = known(restore[1]!)!;
      report.is_deleted = false;
      report.revision += 1;
      return json(route, report);
    }
    const runs = /^\/api\/reports\/([^/]+)\/runs$/.exec(path);
    if (runs && method === "GET") {
      if (state.denyReports) return json(route, { detail: "Forbidden" }, 403);
      const limit = Number(url.searchParams.get("limit") ?? 25);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const all = state.runs[runs[1]!] ?? [];
      return json(
        route,
        pageOf(all.slice(offset, offset + limit), {
          limit,
          offset,
          total: all.length,
        }),
      );
    }
    if (runs && method === "POST") {
      state.runKeys.push(request.headers()["idempotency-key"] ?? null);
      if (state.failNextRun) {
        const status = state.failNextRun;
        state.failNextRun = 0;
        return json(route, { detail: "Private run failure detail" }, status);
      }
      const all = state.runs[runs[1]!] ?? [];
      const made = wireRun({
        id: id(900 + all.length),
        report_id: runs[1]!,
        row_count: 2,
        created_at: "2026-09-26T00:00:00Z",
      });
      state.runs[runs[1]!] = [made, ...all];
      return route.fulfill({ status: 201, json: made });
    }
    const csv = /^\/api\/reports\/([^/]+)\/runs\/([^/]+)\/csv$/.exec(path);
    if (csv) {
      state.csvReads += 1;
      return route.fulfill({
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="report-${csv[2]}.csv"`,
        },
        body: state.csv,
      });
    }
    const run = /^\/api\/reports\/([^/]+)\/runs\/([^/]+)$/.exec(path);
    if (run) {
      const found = (state.runs[run[1]!] ?? []).find(
        (entry) => entry.id === run[2],
      );
      return found
        ? json(route, found)
        : json(route, { detail: "Report run not found" }, 404);
    }
    const schedule = /^\/api\/reports\/([^/]+)\/schedule$/.exec(path);
    if (schedule) {
      const reportId = schedule[1]!;
      const current = state.schedules[reportId];
      if (method === "GET")
        return current
          ? json(route, current)
          : json(route, { detail: "Report schedule not found" }, 404);
      const body = request.postDataJSON() as Record<string, unknown>;
      state.scheduleWrites.push(body);
      const policy = { ...body };
      delete policy.revision;
      const saved = wireSchedule({
        ...current,
        ...(policy as Partial<WireSchedule>),
        report_id: reportId,
        revision: (current?.revision ?? 0) + 1,
      });
      if (!saved.enabled) saved.next_due_at = null;
      else saved.next_due_at ??= "2026-09-29T01:00:00Z";
      state.schedules[reportId] = saved;
      return method === "POST"
        ? route.fulfill({
            status: 201,
            headers: { Location: `/api/reports/${reportId}/schedule` },
            json: saved,
          })
        : json(route, saved);
    }
    return json(route, { detail: "Not found" }, 404);
  });
  return {
    state,
    /** Holds report list reads until the returned function is called. */
    holdLists() {
      let release: () => void = () => {};
      state.listHold = new Promise<void>((resolve) => {
        release = () => {
          state.listHold = null;
          resolve();
        };
      });
      return release;
    },
  };
}

/** The Assets module page, or its Reports view with a report and copy. */
export function modulePage(
  tab?: "reports",
  report?: string,
  copy?: string,
): string {
  const params = new URLSearchParams({
    section: "views",
    module: reportIds.module,
  });
  if (tab) params.set("tab", tab);
  if (report) params.set("report", report);
  if (copy) params.set("copy", copy);
  return `/openview?${params.toString()}`;
}
