import type {
  AudienceRef,
  FilterGroup,
  OpenViewModuleId,
  OpenViewWidget,
} from "./model";

/**
 * Compatibility shapes for the original sample-workspace adapters. They stay
 * independent from OpenView's screen and analytics components so Access can
 * load its federation seeds without importing the UI bundle.
 */
export type LegacyViewConfig = {
  type: string;
  search: string;
  status: string;
  sort: string;
  group: string;
};

export type LegacySavedView = LegacyViewConfig & {
  id: string;
  name: string;
  audience: string;
};

export const initialViewConfig: LegacyViewConfig = {
  type: "Table",
  search: "",
  status: "All statuses",
  sort: "title",
  group: "None",
};

export const initialSavedViews: LegacySavedView[] = [];

export type DashboardWidget = {
  id: string;
  type: string;
  size: string;
  permission?: string;
  refresh: string;
  pinned: boolean;
  name?: string;
  moduleId?: OpenViewModuleId;
  audience?: AudienceRef;
  fields?: string[];
  filters?: FilterGroup;
  metric?: string;
  visualization?: OpenViewWidget["visualization"];
};

export type Dashboard = {
  id: string;
  name: string;
  permission?: string;
  audience?: AudienceRef;
  refresh: string;
  widgets: DashboardWidget[];
};

export type Report = {
  id?: string;
  name: string;
  subtitle?: string;
  moduleId?: OpenViewModuleId;
  fields: string[];
  grouping: string | null;
  totals: boolean;
  schedule: string;
  audience: string | AudienceRef;
  audienceLabel?: string;
  permission?: string;
  filters?: unknown;
  sorts?: unknown;
};

export const initialReport: Report = {
  name: "Weekly service review",
  fields: ["title", "status", "assignee"],
  grouping: "status",
  totals: true,
  schedule: "Manual",
  audience: { kind: "private" },
  audienceLabel: "Only me",
  permission: "Only me",
};

export const initialDashboards: Dashboard[] = [
  {
    id: "sample-dashboard-operations",
    name: "Operations pulse",
    permission: "Everyone",
    audience: { kind: "everyone" },
    refresh: "Manual",
    widgets: [
      {
        id: "sample-widget-summary",
        type: "Summary",
        size: "Full",
        permission: "Everyone",
        refresh: "Manual",
        pinned: false,
      },
      {
        id: "sample-widget-workload",
        type: "Workload",
        size: "Half",
        permission: "Everyone",
        refresh: "Manual",
        pinned: false,
      },
    ],
  },
];

export const initialReportTemplates: Report[] = [];
