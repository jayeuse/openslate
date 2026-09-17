"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CalendarDays,
  Columns3,
  Copy,
  CircleHelp,
  Filter,
  GalleryHorizontal,
  GanttChart,
  Group,
  LayoutGrid,
  Link2,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Save,
  Search,
  SlidersHorizontal,
  Table2,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { initialPeople, initialRoles } from "../access/model";
import { useSampleState, useSampleStorage } from "../sample-state";
import { sampleOperationMessage } from "../sample-async";
import {
  completeCollection,
  pageCollection,
  type PageResult,
} from "../sample-collections";
import { GanttView } from "./gantt";
import { Alert } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select } from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { OpenViewFilterEditor } from "./filter-editor";
import { filterOperatorLabel } from "./filter-helpers";
import {
  OPENVIEW_MODULES,
  OPENVIEW_SECTIONS,
  audienceLabel,
  decodeAudienceRef,
  decodeSavedViews,
  decodeViewConfig,
  defaultViewConfig,
  filterRowsByDateRange,
  getModuleDefinition,
  getOpenViewRows,
  groupRows,
  isUnresolvedAudience,
  parseOpenViewUrl,
  projectAudienceLookup,
  selectRows,
  serializeOpenViewUrl,
  type AudienceLookup,
  type AudienceRef,
  type FilterGroup,
  type OpenViewField,
  type OpenViewModule,
  type OpenViewModuleId,
  type OpenViewRow,
  type OpenViewSection,
  type SavedView as ModelSavedView,
  type SortRule,
  type ViewConfig,
  type ViewLayout,
} from "./model";
import {
  OPENVIEW_SAMPLE_SNAPSHOT_DATE,
  getOpenViewLanes,
  getOpenViewOperationalFacts,
  getOpenViewOperationalProfile,
  summarizeOpenViewOperationalRows,
} from "./operations";
import { type LegacySavedView } from "./seeds";
import {
  type OpenViewCommandController,
  useOpenViewResource,
  useOpenViewCommands,
} from "./controller";
import SampleAnalytics from "./analytics";

const legacyLookup: AudienceLookup = projectAudienceLookup(
  initialRoles,
  initialPeople,
);

export function normalizeSavedViews(raw: unknown): LegacySavedView[] {
  return decodeSavedViews(raw, legacyLookup).map((view) => {
    const statusClause = view.config.filters.clauses.find(
      (clause) => clause.field === "status" && clause.operator === "equals",
    );
    return {
      id: view.id,
      name: view.name,
      audience: audienceLabel(view.audience, legacyLookup),
      type: titleCase(view.config.layout.kind),
      search: view.config.search,
      status: statusClause?.value ?? "All statuses",
      sort:
        view.config.sorts[0]?.field ??
        view.config.layout.primaryField ??
        "title",
      group: view.config.groupBy ?? "None",
    };
  });
}

const sectionLabels: Record<OpenViewSection, string> = {
  views: "Views",
  dashboards: "Dashboards",
  charts: "Charts",
  reports: "Reports",
};

type PendingTransition =
  | {
      kind: "section";
      section: OpenViewSection;
      source: "view" | "dashboard" | "chart" | "report";
    }
  | { kind: "module"; module: OpenViewModuleId; source: "view" }
  | { kind: "saved-view"; id: string; source: "view" };

type OpenViewResetResult = { ok: true } | { ok: false; error: string };

function dateRangeLabel(range: ViewLayout["dateRange"]): string {
  if (range === "week") return "Week";
  if (range === "quarter") return "Quarter";
  if (range === "year") return "Year";
  return "Month";
}

function dateFieldForLayout(
  module: OpenViewModule,
  layout: ViewLayout,
): string | undefined {
  const dateFields = module.fields.filter((field) => field.type === "date");
  if (
    layout.dateField &&
    dateFields.some((field) => field.id === layout.dateField)
  )
    return layout.dateField;
  return dateFields[0]?.id;
}

function sanitizeOpenViewConfig(config: ViewConfig): ViewConfig {
  const moduleDefinition = getModuleDefinition(config.moduleId);
  const dateField = dateFieldForLayout(moduleDefinition, config.layout);
  return {
    ...config,
    layout: {
      ...config.layout,
      dateField,
    },
  };
}

const layoutMeta: {
  kind: ViewLayout["kind"];
  label: string;
  shortLabel: string;
  icon: LucideIcon;
}[] = [
  {
    kind: "table",
    label: "Operational register",
    shortLabel: "Table",
    icon: Table2,
  },
  {
    kind: "grid",
    label: "Scan cards",
    shortLabel: "Grid",
    icon: LayoutGrid,
  },
  {
    kind: "kanban",
    label: "Workflow board",
    shortLabel: "Kanban",
    icon: Columns3,
  },
  {
    kind: "calendar",
    label: "Deadline calendar",
    shortLabel: "Calendar",
    icon: CalendarDays,
  },
  {
    kind: "timeline",
    label: "Planned schedule",
    shortLabel: "Gantt",
    icon: GanttChart,
  },
  {
    kind: "gallery",
    label: "Visual highlights",
    shortLabel: "Gallery",
    icon: GalleryHorizontal,
  },
];

const layoutQuestions: Record<ViewLayout["kind"], string> = {
  table: "Compare exact values and choose the next action.",
  grid: "Scan the records side by side for a quick comparison.",
  kanban: "See where work is concentrated and which items need attention.",
  calendar: "Understand what happens when and what is due next.",
  timeline: "See the planned work windows and schedule pressure over time.",
  gallery: "Spot the records and signals that stand out at a glance.",
};

function layoutLabel(kind: ViewLayout["kind"]): string {
  return layoutMeta.find((entry) => entry.kind === kind)?.label ?? "View";
}

function timingStateLabel(state: string): string {
  if (state === "due-soon") return "Due soon";
  if (state === "late-plan") return "Late plan";
  if (state === "on-track") return "On track";
  if (state === "unscheduled") return "Needs scheduling";
  return titleCase(state);
}

function displayDate(value: string): string {
  return value ? formatCalendarDate(value, true) : "Unscheduled";
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

const visualTones = [
  {
    surface: "bg-chart-1/12",
    border: "border-chart-1/35",
    solid: "bg-chart-1",
  },
  {
    surface: "bg-chart-2/12",
    border: "border-chart-2/35",
    solid: "bg-chart-2",
  },
  {
    surface: "bg-chart-3/12",
    border: "border-chart-3/35",
    solid: "bg-chart-3",
  },
  {
    surface: "bg-chart-4/12",
    border: "border-chart-4/35",
    solid: "bg-chart-4",
  },
  {
    surface: "bg-chart-5/12",
    border: "border-chart-5/35",
    solid: "bg-chart-5",
  },
] as const;

function visualTone(value: string, fallback = 0) {
  const normalized = value.toLocaleLowerCase();
  let index = fallback % visualTones.length;
  if (normalized.includes("hold") || normalized.includes("repair")) index = 4;
  else if (
    normalized.includes("done") ||
    normalized.includes("complete") ||
    normalized.includes("active") ||
    normalized.includes("in service")
  )
    index = 2;
  else if (normalized.includes("progress")) index = 3;
  else if (
    normalized.includes("scheduled") ||
    normalized.includes("due") ||
    normalized.includes("review")
  )
    index = 1;
  else if (normalized.includes("open") || normalized.includes("requested"))
    index = 0;
  else if (value) {
    index =
      [...value].reduce(
        (total, character) => total + character.charCodeAt(0),
        0,
      ) % visualTones.length;
  }
  return visualTones[index] ?? visualTones[0];
}

function formatCalendarDate(value: string, includeYear = false): string {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf())) return value || "Unscheduled";
  return new Intl.DateTimeFormat("en", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: includeYear ? "numeric" : undefined,
  }).format(date);
}

function moduleIdFromUnknown(value: unknown): OpenViewModuleId {
  return typeof value === "string" &&
    OPENVIEW_MODULES.some((module) => module.id === value)
    ? (value as OpenViewModuleId)
    : "service-requests";
}

function sectionFromUnknown(value: unknown): OpenViewSection {
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (OPENVIEW_SECTIONS.includes(lower as OpenViewSection)) {
      return lower as OpenViewSection;
    }
  }
  return "views";
}

function cloneConfig(config: ViewConfig): ViewConfig {
  return {
    ...config,
    filters: {
      logic: config.filters.logic,
      clauses: config.filters.clauses.map((clause) => ({ ...clause })),
    },
    sorts: config.sorts.map((sort) => ({ ...sort })),
    layout: {
      ...config.layout,
      columns: [...config.layout.columns],
      pinnedColumns: [...config.layout.pinnedColumns],
    },
  };
}

function sameConfig(left: ViewConfig, right: ViewConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function audienceValue(audience: AudienceRef): string {
  if (audience.kind === "private") return "private";
  if (audience.kind === "everyone") return "everyone";
  return `${audience.kind}:${audience.id}`;
}

function audienceFromValue(value: string, lookup: AudienceLookup): AudienceRef {
  if (value === "everyone") return { kind: "everyone" };
  if (value === "private") return { kind: "private" };
  const [kind, id] = value.split(":", 2);
  return decodeAudienceRef(
    kind === "role" || kind === "identity" ? { kind, id } : null,
    lookup,
  );
}

function createSampleId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function defaultMapFromUnknown(
  value: unknown,
): Partial<Record<OpenViewModuleId, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      ([moduleId, viewId]) =>
        OPENVIEW_MODULES.some((module) => module.id === moduleId) &&
        typeof viewId === "string" &&
        viewId.length > 0,
    ),
  ) as Partial<Record<OpenViewModuleId, string>>;
}

function fieldLabel(module: OpenViewModule, fieldId: string): string {
  return module.fields.find((field) => field.id === fieldId)?.label ?? fieldId;
}

function OpenViewLoading() {
  return (
    <div
      className="flex flex-col gap-4"
      role="status"
      aria-label="Opening OpenView"
    >
      <Skeleton className="h-8 w-52" />
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function OpenViewReadError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <Alert role="alert" variant="warning" className="flex flex-wrap gap-3">
      <div className="min-w-0 flex-1">
        <p className="font-medium">OpenView data is temporarily unavailable.</p>
        <p className="mt-1 text-sm">{message}</p>
      </div>
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        onClick={onRetry}
      >
        Retry
      </Button>
    </Alert>
  );
}

export default function SampleOpenView() {
  return (
    <Suspense fallback={<OpenViewLoading />}>
      <OpenViewContent />
    </Suspense>
  );
}

function OpenViewContent() {
  const pathname = usePathname();
  const router = useRouter();
  const query = useSearchParams();
  const urlState = parseOpenViewUrl(`${pathname}?${query.toString()}`);
  const hasSection = query.has("section");
  const hasModule = query.has("module");

  const workspaceResource = useOpenViewResource();
  const [, setStoredSection] = useSampleState<unknown>(
    "views-section",
    "views",
  );
  const [, setStoredModule] = useSampleState<unknown>(
    "views-module",
    "service-requests",
  );
  const [, setStoredSelectedView] = useSampleState<unknown>(
    "views-selected",
    "",
  );
  const { storageUnavailable } = useSampleStorage();
  const openViewCommands = useOpenViewCommands();
  const openViewPending = openViewCommands.isPending();
  const [dashboardDirty, setDashboardDirty] = useState(false);
  const [chartDirty, setChartDirty] = useState(false);
  const [reportDirty, setReportDirty] = useState(false);
  const [pendingTransition, setPendingTransition] =
    useState<PendingTransition | null>(null);

  const snapshot = workspaceResource.data;
  const records = snapshot?.records ?? [];
  const roles = snapshot?.roles ?? initialRoles;
  const people = snapshot?.people ?? initialPeople;
  const storedSection = snapshot?.section ?? "views";
  const storedModule = snapshot?.module ?? "service-requests";
  const storedConfig = snapshot?.config ?? null;
  const rawSavedViews = snapshot?.savedViews ?? [];
  const storedDefault = snapshot?.defaultId ?? "";
  const storedDefaultMap = snapshot?.defaultMap ?? {};
  const storedSelectedView = snapshot?.selectedView ?? "";

  const audienceLookup = projectAudienceLookup(roles, people);
  const storedSectionValue = sectionFromUnknown(storedSection);
  const storedModuleValue = moduleIdFromUnknown(storedModule);
  const section =
    hasSection || urlState.record ? urlState.section : storedSectionValue;
  const moduleId =
    urlState.record && !hasModule
      ? "service-requests"
      : hasModule
        ? urlState.module
        : storedModuleValue;
  const selectedModule = getModuleDefinition(moduleId);
  const savedViews = decodeSavedViews(rawSavedViews, audienceLookup);
  const defaults = defaultMapFromUnknown(storedDefaultMap);
  const legacyDefaultId =
    typeof storedDefault === "string" ? storedDefault : "";
  const defaultId = defaults[moduleId] ?? legacyDefaultId;
  const moduleDefault = savedViews.find(
    (view) => view.id === defaultId && view.moduleId === moduleId,
  );
  const storedSelectedId =
    typeof storedSelectedView === "string" ? storedSelectedView : "";
  const selectedViewId = urlState.view ?? moduleDefault?.id ?? storedSelectedId;
  const activeSaved = savedViews.find(
    (view) => view.id === selectedViewId && view.moduleId === moduleId,
  );
  const storedDecodedConfig = sanitizeOpenViewConfig(
    decodeViewConfig(storedConfig),
  );
  const fallbackConfig =
    storedDecodedConfig.moduleId === moduleId
      ? storedDecodedConfig
      : defaultViewConfig(moduleId);
  const initialConfig = sanitizeOpenViewConfig(
    activeSaved?.config ?? fallbackConfig,
  );
  const configKey = `${moduleId}:${selectedViewId}`;
  const workspaceReady = snapshot !== undefined;
  const workspaceReadyRef = useRef(false);
  const [draftConfig, setDraftConfig] = useState<ViewConfig>(() =>
    cloneConfig(initialConfig),
  );
  const [draftKey, setDraftKey] = useState(configKey);
  const config =
    draftKey === configKey ? draftConfig : cloneConfig(initialConfig);

  const openViewDirty =
    draftKey === configKey &&
    !sameConfig(
      config,
      activeSaved
        ? sanitizeOpenViewConfig(activeSaved.config)
        : defaultViewConfig(moduleId),
    );

  useEffect(() => {
    if (!workspaceReady) return;
    if (draftKey === configKey && workspaceReadyRef.current) return;
    const next = cloneConfig(initialConfig);
    setDraftConfig(next);
    setDraftKey(configKey);
    workspaceReadyRef.current = true;
  }, [configKey, draftKey, initialConfig, workspaceReady]);

  if (!snapshot) {
    return workspaceResource.status === "error" ? (
      <OpenViewReadError
        message={workspaceResource.error}
        onRetry={workspaceResource.reload}
      />
    ) : (
      <OpenViewLoading />
    );
  }

  const updateUrl = (
    next: {
      section?: OpenViewSection;
      module?: OpenViewModuleId;
      view?: string;
      dashboard?: string;
      record?: string;
    },
    options: { replace?: boolean } = {},
  ) => {
    if (openViewPending) return;
    const target = serializeOpenViewUrl({
      section,
      module: moduleId,
      view: selectedViewId || undefined,
      record: urlState.record,
      ...next,
    }) as Route;
    if (options.replace) router.replace(target, { scroll: false });
    else router.push(target, { scroll: false });
  };

  const updateConfig = (next: ViewConfig) => {
    const safe = sanitizeOpenViewConfig(decodeViewConfig(next));
    setDraftConfig(safe);
    setDraftKey(configKey);
  };

  const discardOpenViewDraft = () => {
    const next = sanitizeOpenViewConfig(
      activeSaved?.config ?? defaultViewConfig(moduleId),
    );
    setDraftConfig(cloneConfig(next));
    setDraftKey(configKey);
  };

  const performSectionChange = (next: OpenViewSection) => {
    if (openViewPending || next === section) return;
    if (section === "views" && openViewDirty) discardOpenViewDraft();
    if (section === "dashboards") setDashboardDirty(false);
    if (section === "charts") setChartDirty(false);
    if (section === "reports") setReportDirty(false);
    setStoredSection(next);
    updateUrl({
      section: next,
      view: next === "views" ? selectedViewId || undefined : undefined,
      dashboard:
        next === "dashboards"
          ? (query.get("dashboard") ?? undefined)
          : undefined,
      record: undefined,
    });
  };

  const requestSectionChange = (next: OpenViewSection) => {
    if (openViewPending || next === section) return;
    if (section === "views" && openViewDirty) {
      setPendingTransition({ kind: "section", section: next, source: "view" });
      return;
    }
    if (section === "dashboards" && dashboardDirty) {
      setPendingTransition({
        kind: "section",
        section: next,
        source: "dashboard",
      });
      return;
    }
    if (section === "charts" && chartDirty) {
      setPendingTransition({ kind: "section", section: next, source: "chart" });
      return;
    }
    if (section === "reports" && reportDirty) {
      setPendingTransition({
        kind: "section",
        section: next,
        source: "report",
      });
      return;
    }
    performSectionChange(next);
  };

  const performModuleChange = (next: OpenViewModuleId) => {
    if (openViewPending || next === moduleId) return;
    const nextDefaultId = defaults[next] ?? legacyDefaultId;
    const nextDefault = savedViews.find(
      (view) => view.id === nextDefaultId && view.moduleId === next,
    );
    const nextSelection = nextDefault?.id ?? "";
    const nextConfig = sanitizeOpenViewConfig(
      nextDefault?.config ?? defaultViewConfig(next),
    );
    setStoredModule(next);
    setStoredSelectedView(nextSelection);
    setDraftConfig(nextConfig);
    setDraftKey(`${next}:${nextSelection}`);
    updateUrl({
      module: next,
      view: nextSelection || undefined,
      record: undefined,
      dashboard: undefined,
    });
  };

  const requestModuleChange = (next: OpenViewModuleId) => {
    if (openViewPending || next === moduleId) return;
    if (section === "views" && openViewDirty) {
      setPendingTransition({ kind: "module", module: next, source: "view" });
      return;
    }
    performModuleChange(next);
  };

  const performSavedViewSelection = (id: string) => {
    if (openViewPending || id === selectedViewId) return;
    const next = savedViews.find(
      (view) => view.id === id && view.moduleId === moduleId,
    );
    setStoredSelectedView(id);
    if (next) {
      const nextConfig = sanitizeOpenViewConfig(cloneConfig(next.config));
      setDraftConfig(nextConfig);
      setDraftKey(`${moduleId}:${id}`);
    }
    updateUrl({ section: "views", view: id || undefined, record: undefined });
  };

  const requestSavedViewSelection = (id: string) => {
    if (openViewPending || id === selectedViewId) return;
    if (section === "views" && openViewDirty) {
      setPendingTransition({ kind: "saved-view", id, source: "view" });
      return;
    }
    performSavedViewSelection(id);
  };

  const confirmPendingTransition = () => {
    if (openViewPending) return;
    const transition = pendingTransition;
    if (!transition) return;
    setPendingTransition(null);
    if (transition.kind === "section") {
      performSectionChange(transition.section);
    } else if (transition.kind === "module") {
      performModuleChange(transition.module);
    } else {
      performSavedViewSelection(transition.id);
    }
  };

  const rows = getOpenViewRows(moduleId, records);
  const selectedRows = selectRows(rows, config);
  const dateRangeLayout =
    config.layout.kind === "calendar" || config.layout.kind === "timeline";
  const dateField = dateFieldForLayout(selectedModule, config.layout);
  const dateRangeRows = dateRangeLayout
    ? filterRowsByDateRange(
        selectedRows,
        dateField,
        config.layout.dateRange,
        rows,
      )
    : selectedRows;
  const selectedRecordId = section === "views" ? urlState.record : undefined;
  const inspected = selectedRecordId
    ? rows.find((row) => row.id === selectedRecordId)
    : undefined;
  const unknownRecord = Boolean(selectedRecordId && !inspected);
  const savedViewLinkCanBeJudged =
    workspaceResource.status === "ready" &&
    !workspaceResource.refreshing &&
    workspaceResource.error === null;
  const isInvalidLink = Boolean(
    urlState.invalid ||
    (savedViewLinkCanBeJudged && urlState.view && !activeSaved),
  );
  const activeFilterCount =
    config.filters.clauses.length + (config.search.trim() ? 1 : 0);
  const audienceOptions = [
    { value: "private", label: "Only me" },
    { value: "everyone", label: "Everyone" },
    ...roles.map((role) => ({
      value: `role:${role.id}`,
      label: `Role: ${role.name}`,
    })),
    ...(audienceLookup.identities ?? []).map((person) => ({
      value: `identity:${person.id}`,
      label: `User: ${person.name}`,
    })),
  ];

  const acceptSavedView = (saved: ModelSavedView) => {
    const nextConfig = sanitizeOpenViewConfig(cloneConfig(saved.config));
    setStoredModule(saved.moduleId);
    setStoredSelectedView(saved.id);
    setDraftConfig(nextConfig);
    setDraftKey(`${saved.moduleId}:${saved.id}`);
    router.push(
      serializeOpenViewUrl({
        section: "views",
        module: saved.moduleId,
        view: saved.id,
      }) as Route,
      { scroll: false },
    );
  };

  const resetOpenView = async (): Promise<OpenViewResetResult> => {
    if (openViewPending)
      return {
        ok: false,
        error: "Another OpenView change is still being saved.",
      };
    try {
      const result = await openViewCommands.resetOpenView();
      if (!result.ok) return { ok: false, error: result.error };
      router.push("/openview", { scroll: false });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: sampleOperationMessage(
          error,
          "The OpenView settings could not be reset. Try again.",
        ),
      };
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3 sm:gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              OpenView
            </h1>
            <Badge variant="outline" className="min-h-7">
              Local preview
            </Badge>
          </div>
          <p className="text-muted-foreground mt-2 max-w-2xl text-sm">
            Explore operational records, compose reusable views, and prepare
            sample analytics for your team.
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:items-end">
          {section === "views" ? (
            <Field className="w-full sm:w-64">
              <FieldLabel htmlFor="openview-module">Data source</FieldLabel>
              <Combobox
                value={moduleId}
                onValueChange={(value) => {
                  if (typeof value === "string")
                    requestModuleChange(moduleIdFromUnknown(value));
                }}
                itemToStringLabel={(value) =>
                  OPENVIEW_MODULES.find((entry) => entry.id === value)?.name ??
                  ""
                }
              >
                <ComboboxTrigger
                  id="openview-module"
                  aria-label="Data source"
                  className="min-h-11"
                  disabled={openViewPending}
                >
                  {selectedModule.name}
                </ComboboxTrigger>
                <ComboboxContent>
                  <ComboboxInput
                    placeholder="Search data sources"
                    aria-label="Search data sources"
                    className="min-h-11"
                  />
                  <ComboboxList>
                    {OPENVIEW_MODULES.map((entry) => (
                      <ComboboxItem
                        key={entry.id}
                        value={entry.id}
                        className="min-h-11"
                      >
                        <span className="flex flex-col gap-0.5">
                          <span>{entry.name}</span>
                          <span className="text-muted-foreground text-xs">
                            {entry.description}
                          </span>
                        </span>
                      </ComboboxItem>
                    ))}
                    <ComboboxEmpty>No matching data source.</ComboboxEmpty>
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
              <FieldDescription>
                {rows.length} records · {selectedModule.fields.length} fields
              </FieldDescription>
            </Field>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{selectedModule.name}</Badge>
              <Badge variant="outline">{rows.length} records</Badge>
            </div>
          )}
        </div>
      </header>

      <Alert role="note" className="flex items-center gap-2 py-2.5 text-xs">
        <CircleHelp aria-hidden="true" className="size-4 shrink-0" />
        <p className="min-w-0">
          <span className="font-medium">Sample workspace.</span> Synthetic
          records stay in this tab; audience, refresh, and schedule controls are
          previews only.
        </p>
      </Alert>
      {storageUnavailable ? (
        <Alert role="note" variant="warning">
          Browser storage is unavailable. Your latest changes exist in memory
          only and may be lost on reload.
        </Alert>
      ) : null}
      {workspaceResource.refreshing ? (
        <Alert role="status" className="text-sm">
          Refreshing OpenView data…
        </Alert>
      ) : null}
      {openViewPending ? (
        <Alert role="status" className="text-sm">
          Saving an OpenView change… Navigation and conflicting actions are
          paused until it finishes.
        </Alert>
      ) : null}
      {workspaceResource.error ? (
        <Alert
          role="alert"
          variant="warning"
          className="flex flex-wrap items-center justify-between gap-3"
        >
          <span>
            {workspaceResource.error} Your current data is still shown.
          </span>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={workspaceResource.reload}
          >
            Retry refresh
          </Button>
        </Alert>
      ) : null}
      {isInvalidLink ? (
        <Alert
          role="alert"
          variant="warning"
          className="flex flex-wrap items-center justify-between gap-3"
        >
          <span>
            This OpenView link is unavailable or contains unsupported state. You
            can return to the current workspace.
          </span>
          <Button
            variant="outline"
            className="min-h-11"
            disabled={openViewPending}
            onClick={() =>
              updateUrl(
                {
                  view: undefined,
                  record: undefined,
                  dashboard: undefined,
                },
                { replace: true },
              )
            }
          >
            Return to workspace
          </Button>
        </Alert>
      ) : null}

      <div className="md:hidden">
        <Field>
          <FieldLabel htmlFor="openview-section-mobile">
            OpenView section
          </FieldLabel>
          <NativeSelect
            id="openview-section-mobile"
            className="w-full [&_select]:min-h-11"
            value={section}
            disabled={openViewPending}
            onChange={(event) =>
              requestSectionChange(sectionFromUnknown(event.target.value))
            }
          >
            {OPENVIEW_SECTIONS.map((entry) => (
              <NativeSelectOption key={entry} value={entry}>
                {sectionLabels[entry]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <Tabs
        value={section}
        onValueChange={(value) =>
          requestSectionChange(sectionFromUnknown(value))
        }
        className="gap-3"
      >
        <nav
          aria-label="OpenView sections"
          className="hidden border-b pb-2 md:block"
        >
          <TabsList className="grid w-full grid-cols-4 gap-1 sm:inline-flex sm:w-fit">
            {OPENVIEW_SECTIONS.map((entry) => (
              <TabsTrigger
                key={entry}
                value={entry}
                type="button"
                className="min-h-11 min-w-24"
                disabled={openViewPending}
              >
                {sectionLabels[entry]}
              </TabsTrigger>
            ))}
          </TabsList>
        </nav>
      </Tabs>

      {section === "views" ? (
        <ViewsWorkspace
          module={selectedModule}
          rows={rows}
          config={config}
          updateConfig={updateConfig}
          selectedRows={dateRangeRows}
          matchingRows={selectedRows}
          activeFilterCount={activeFilterCount}
          savedViews={savedViews}
          activeSaved={activeSaved}
          selectedViewId={selectedViewId}
          moduleDefault={moduleDefault}
          dirty={openViewDirty}
          audienceOptions={audienceOptions}
          lookup={audienceLookup}
          commands={openViewCommands}
          selectSavedView={requestSavedViewSelection}
          updateUrl={updateUrl}
          inspected={inspected}
          unknownRecord={unknownRecord}
          onInspect={(id) =>
            updateUrl({ section: "views", module: moduleId, record: id })
          }
          onCloseInspect={() => updateUrl({ record: undefined })}
          onResetOpenView={resetOpenView}
          onAcceptedView={acceptSavedView}
        />
      ) : (
        <SampleAnalytics
          section={section}
          commands={openViewCommands}
          snapshot={snapshot}
          audienceLookup={audienceLookup}
          moduleId={moduleId}
          dashboardUrlId={urlState.dashboard}
          onDashboardUrlChange={(id) =>
            updateUrl({
              section: "dashboards",
              dashboard: id,
              view: undefined,
              record: undefined,
            })
          }
          onDashboardDirtyChange={setDashboardDirty}
          onChartDirtyChange={setChartDirty}
          onReportDirtyChange={setReportDirty}
        />
      )}
      <AlertDialog
        open={pendingTransition !== null}
        onOpenChange={(open) => {
          if (!open && !openViewPending) setPendingTransition(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Discard unsaved {pendingTransition?.source ?? "view"} changes?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Your current {pendingTransition?.source ?? "view"} draft has
              unsaved changes. Continuing will discard them.
            </AlertDialogDescription>
            {openViewPending ? (
              <p role="status" className="text-muted-foreground text-sm">
                An OpenView change is still being saved. Keep editing until it
                finishes.
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={openViewPending}
              onClick={() => setPendingTransition(null)}
            >
              Keep editing
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="min-h-11"
              disabled={openViewPending}
              onClick={confirmPendingTransition}
            >
              Discard and continue
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type ViewsWorkspaceProps = {
  module: OpenViewModule;
  rows: OpenViewRow[];
  config: ViewConfig;
  updateConfig: (config: ViewConfig) => void;
  selectedRows: OpenViewRow[];
  matchingRows: OpenViewRow[];
  activeFilterCount: number;
  savedViews: ModelSavedView[];
  activeSaved?: ModelSavedView;
  selectedViewId: string;
  moduleDefault?: ModelSavedView;
  dirty: boolean;
  audienceOptions: { value: string; label: string }[];
  lookup: AudienceLookup;
  commands: OpenViewCommandController;
  selectSavedView: (id: string) => void;
  updateUrl: (next: {
    section?: OpenViewSection;
    module?: OpenViewModuleId;
    view?: string;
    dashboard?: string;
    record?: string;
  }) => void;
  inspected?: OpenViewRow;
  unknownRecord: boolean;
  onInspect: (id: string) => void;
  onCloseInspect: () => void;
  onResetOpenView: () => Promise<OpenViewResetResult>;
  onAcceptedView: (view: ModelSavedView) => void;
};

type SaveViewIntent =
  { kind: "create" } | { kind: "update"; id: string; expected: ModelSavedView };

function ViewsWorkspace({
  module,
  rows,
  config,
  updateConfig,
  selectedRows,
  matchingRows,
  activeFilterCount,
  savedViews,
  activeSaved,
  selectedViewId,
  moduleDefault,
  dirty,
  audienceOptions,
  lookup,
  commands,
  selectSavedView,
  updateUrl,
  inspected,
  unknownRecord,
  onInspect,
  onCloseInspect,
  onResetOpenView,
  onAcceptedView,
}: ViewsWorkspaceProps) {
  const [filtersOpen, setFiltersOpen] = useState(activeFilterCount > 0);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [pendingAudience, setPendingAudience] = useState<AudienceRef | null>(
    null,
  );
  const [viewName, setViewName] = useState(activeSaved?.name ?? "");
  const [audience, setAudience] = useState(
    audienceValue(activeSaved?.audience ?? { kind: "private" }),
  );
  const [saveIntent, setSaveIntent] = useState<SaveViewIntent | null>(null);
  const [saveError, setSaveError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [resetError, setResetError] = useState("");
  const [notice, setNotice] = useState("");
  const [pageOffset, setPageOffset] = useState(0);
  const draftRevision = useRef(0);
  const effectiveSaveIntent: SaveViewIntent =
    saveIntent ??
    (activeSaved
      ? { kind: "update", id: activeSaved.id, expected: activeSaved }
      : { kind: "create" });
  const saveKey = `openview.view.save:${
    effectiveSaveIntent.kind === "update" ? effectiveSaveIntent.id : "new"
  }`;
  const deleteKey = `openview.view.delete:${activeSaved?.id ?? ""}`;
  const commandPending = commands.isPending();
  const savePending = commands.isPending(saveKey);
  const deletePending = commands.isPending(deleteKey);

  const change = (partial: Partial<ViewConfig>) => {
    draftRevision.current += 1;
    updateConfig({ ...config, ...partial });
    setSaveError("");
    setNotice("");
  };
  const changeViewName = (value: string) => {
    draftRevision.current += 1;
    setViewName(value);
    setSaveError("");
  };
  const changeAudience = (value: string) => {
    draftRevision.current += 1;
    setAudience(value);
    setSaveError("");
  };
  const changeFilters = (filters: FilterGroup) => change({ filters });
  const changeLayout = (layout: ViewLayout) => change({ layout });
  const handleAudienceChange = (value: string) => {
    const nextAudience = audienceFromValue(value, lookup);
    const currentAudience = audienceFromValue(audience, lookup);
    if (
      nextAudience.kind === "everyone" &&
      currentAudience.kind !== "everyone"
    ) {
      setPendingAudience(nextAudience);
      return;
    }
    changeAudience(value);
  };
  const filterCount = config.filters.clauses.length;
  const dateRangeLayout =
    config.layout.kind === "calendar" || config.layout.kind === "timeline";
  const dateField = dateFieldForLayout(module, config.layout);
  const dateRangeSupported = dateRangeLayout && Boolean(dateField);
  const noDateRangeMatches =
    dateRangeSupported && matchingRows.length > 0 && selectedRows.length === 0;
  const completeRows = completeCollection(
    selectedRows,
    `openview:${module.id}:${JSON.stringify({
      search: config.search,
      filters: config.filters,
      sorts: config.sorts,
      groupBy: config.groupBy,
      layout: config.layout.kind,
      dateRange: config.layout.dateRange,
    })}`,
  );
  const page =
    config.layout.kind === "table" && !config.groupBy
      ? pageCollection(completeRows, pageOffset, 10)
      : undefined;
  const displayedRows = [...(page?.items ?? completeRows.items)];
  const grouped = groupRows(displayedRows, config.groupBy);

  useEffect(() => {
    if (page && page.offset !== pageOffset) setPageOffset(page.offset);
  }, [page, pageOffset]);

  useEffect(() => {
    setPageOffset(0);
  }, [completeRows.queryKey]);
  const clearNoRows = () => {
    if (noDateRangeMatches) {
      change({
        layout: { ...config.layout, dateRange: "year" },
      });
      return;
    }
    change({
      search: "",
      filters: { ...config.filters, clauses: [] },
    });
  };
  const emptyResults = (
    <Empty className="min-h-64 border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Search aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>
          {noDateRangeMatches
            ? `No records in this ${dateRangeLabel(config.layout.dateRange).toLowerCase()} range`
            : "No records match these filters"}
        </EmptyTitle>
        <EmptyDescription>
          {noDateRangeMatches
            ? "Broaden the date range to include more of the matching records."
            : "Try a broader search or remove one of the active filters."}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" className="min-h-11" onClick={clearNoRows}>
          {noDateRangeMatches ? "Show full sample year" : "Clear filters"}
        </Button>
      </EmptyContent>
    </Empty>
  );

  const saveCurrent = async (
    nextName: string,
    nextAudience: AudienceRef,
    intent: SaveViewIntent,
  ) => {
    if (commandPending) return;
    setSaveError("");
    const cleanName = nextName.trim();
    if (!cleanName) {
      const error = "Give this view a name before saving.";
      setSaveError(error);
      setNotice(error);
      return;
    }
    const existingId = intent.kind === "update" ? intent.id : undefined;
    const view: ModelSavedView = {
      id: existingId ?? createSampleId("sample-view"),
      name: cleanName.slice(0, 80),
      moduleId: module.id,
      audience: nextAudience,
      config: cloneConfig(config),
    };
    const submittedRevision = draftRevision.current;
    setNotice("");
    try {
      const result = await commands.saveView({
        view,
        expectedId: existingId,
        expected: intent.kind === "update" ? intent.expected : undefined,
      });
      if (!result.ok) {
        setSaveError(result.error);
        setNotice(result.error);
        return;
      }
      const saved = result.value;
      if (submittedRevision !== draftRevision.current) {
        setNotice(
          `“${saved.name}” was saved. Your newer edits remain open as an unsaved draft.`,
        );
        return;
      }
      onAcceptedView(saved);
      setSaveOpen(false);
      setRenameOpen(false);
      setSaveIntent(null);
      setSaveError("");
      setViewName(saved.name);
      setAudience(audienceValue(saved.audience));
      setNotice(`“${saved.name}” is saved in this sample workspace.`);
    } catch (error) {
      const message = sampleOperationMessage(
        error,
        "The view could not be saved. Keep the editor open and try again.",
      );
      setSaveError(message);
      setNotice(message);
    }
  };

  const duplicateView = async () => {
    if (commandPending) return;
    if (!activeSaved) return;
    const duplicate: ModelSavedView = {
      ...activeSaved,
      id: createSampleId("sample-view"),
      name: `${activeSaved.name} copy`.slice(0, 80),
      config: cloneConfig(config),
    };
    const submittedRevision = draftRevision.current;
    setNotice("");
    try {
      const result = await commands.duplicateView({
        sourceId: activeSaved.id,
        view: duplicate,
        expectedSource: activeSaved,
      });
      if (!result.ok) {
        setNotice(result.error);
        return;
      }
      if (submittedRevision !== draftRevision.current) {
        setNotice(
          `“${result.value.name}” was duplicated. Your newer edits remain open as an unsaved draft.`,
        );
        return;
      }
      onAcceptedView(result.value);
      setNotice(`“${result.value.name}” was duplicated.`);
    } catch (error) {
      setNotice(
        sampleOperationMessage(
          error,
          "The view could not be duplicated. Try again.",
        ),
      );
    }
  };

  const deleteView = async () => {
    if (commandPending) return;
    if (!activeSaved) return;
    setNotice("");
    setDeleteError("");
    try {
      const result = await commands.deleteView(activeSaved.id, activeSaved);
      if (!result.ok) {
        setDeleteError(result.error);
        return;
      }
      updateUrl({
        section: "views",
        module: module.id,
        view: undefined,
        record: undefined,
      });
      selectSavedView("");
      setDeleteError("");
      setDeleteOpen(false);
      setNotice(`“${activeSaved.name}” was deleted from this tab.`);
    } catch (error) {
      setDeleteError(
        sampleOperationMessage(
          error,
          "The view could not be deleted. Try again.",
        ),
      );
    }
  };

  const resetDraft = () => {
    if (commandPending) return;
    const next = activeSaved?.config ?? defaultViewConfig(module.id);
    change(cloneConfig(next));
    setNotice(
      activeSaved
        ? `Unsaved changes to “${activeSaved.name}” were reset.`
        : "The view was reset to its starting configuration.",
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section
        className="flex flex-col gap-4 rounded-[var(--radius)] border p-4 sm:p-5"
        aria-label="View controls"
      >
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center">
            <Field className="min-w-0 flex-1">
              <FieldLabel htmlFor="openview-search" className="sr-only">
                Search {module.name}
              </FieldLabel>
              <InputGroup className="h-11">
                <InputGroupAddon>
                  <Search aria-hidden="true" />
                </InputGroupAddon>
                <InputGroupInput
                  id="openview-search"
                  className="h-11"
                  placeholder={`Search ${module.name.toLowerCase()}…`}
                  value={config.search}
                  onChange={(event) =>
                    change({ search: event.target.value.slice(0, 240) })
                  }
                />
                {config.search ? (
                  <InputGroupAddon align="inline-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-11"
                      aria-label="Clear search"
                      onClick={() => change({ search: "" })}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </InputGroupAddon>
                ) : null}
              </InputGroup>
            </Field>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen((open) => !open)}
            >
              <Filter data-icon="inline-start" aria-hidden="true" /> Filters{" "}
              {filterCount ? (
                <Badge variant="secondary">{filterCount}</Badge>
              ) : null}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              aria-expanded={layoutOpen}
              onClick={() => setLayoutOpen((open) => !open)}
            >
              <SlidersHorizontal data-icon="inline-start" aria-hidden="true" />{" "}
              View settings
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SavedViewMenu
              module={module}
              savedViews={savedViews}
              selectedViewId={selectedViewId}
              moduleDefault={moduleDefault}
              disabled={commandPending}
              onSelect={selectSavedView}
              onCreate={() => {
                setSaveIntent({ kind: "create" });
                setViewName("");
                setAudience("private");
                setSaveError("");
                setSaveOpen(true);
              }}
            />
            {activeSaved && dirty ? (
              <Button
                type="button"
                className="min-h-11"
                disabled={commandPending}
                onClick={() =>
                  saveCurrent(activeSaved.name, activeSaved.audience, {
                    kind: "update",
                    id: activeSaved.id,
                    expected: activeSaved,
                  })
                }
              >
                <Save data-icon="inline-start" aria-hidden="true" /> Save
                changes
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={commandPending}
                onClick={() => {
                  setSaveIntent(
                    activeSaved
                      ? {
                          kind: "update",
                          id: activeSaved.id,
                          expected: activeSaved,
                        }
                      : { kind: "create" },
                  );
                  setViewName(activeSaved?.name ?? "");
                  setAudience(
                    audienceValue(activeSaved?.audience ?? { kind: "private" }),
                  );
                  setSaveError("");
                  setSaveOpen(true);
                }}
              >
                <Save data-icon="inline-start" aria-hidden="true" /> Save view
              </Button>
            )}
            <Popover>
              <PopoverTrigger
                render={
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="size-11"
                    aria-label="More view actions"
                  />
                }
              >
                <MoreHorizontal aria-hidden="true" />
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64">
                <PopoverHeader>
                  <PopoverTitle>View actions</PopoverTitle>
                  <PopoverDescription>
                    Manage this tab-local saved view.
                  </PopoverDescription>
                </PopoverHeader>
                <div className="flex flex-col gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-11 justify-start"
                    disabled={!activeSaved || commandPending}
                    onClick={() => {
                      if (!activeSaved) return;
                      setSaveIntent({
                        kind: "update",
                        id: activeSaved.id,
                        expected: activeSaved,
                      });
                      setViewName(activeSaved?.name ?? "");
                      setSaveError("");
                      setRenameOpen(true);
                    }}
                  >
                    Rename saved view
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-11 justify-start"
                    disabled={!activeSaved || commandPending}
                    onClick={duplicateView}
                  >
                    <Copy data-icon="inline-start" aria-hidden="true" />{" "}
                    Duplicate view
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-11 justify-start"
                    disabled={!activeSaved || commandPending}
                    onClick={() => {
                      setDeleteError("");
                      setDeleteOpen(true);
                    }}
                  >
                    <Trash2 data-icon="inline-start" aria-hidden="true" />{" "}
                    Delete view
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-11 justify-start"
                    disabled={!dirty || commandPending}
                    onClick={resetDraft}
                  >
                    <RotateCcw data-icon="inline-start" aria-hidden="true" />{" "}
                    Reset changes
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-11 justify-start"
                    disabled={commandPending}
                    onClick={() => setResetOpen(true)}
                  >
                    Reset OpenView settings
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
        <div className="border-border flex flex-col gap-2 border-t pt-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="-mx-1 overflow-x-auto px-1 pb-1">
            <ToggleGroup
              value={[config.layout.kind]}
              onValueChange={(value) => {
                const kind = value[0] as ViewLayout["kind"] | undefined;
                if (kind) changeLayout({ ...config.layout, kind });
              }}
              aria-label="Record view"
              variant="outline"
              className="w-max min-w-full justify-start"
            >
              {layoutMeta.map(({ kind, shortLabel, label, icon: Icon }) => (
                <ToggleGroupItem
                  key={kind}
                  value={kind}
                  disabled={
                    (kind === "calendar" || kind === "timeline") &&
                    !module.fields.some((field) => field.type === "date")
                  }
                  className="min-h-11 shrink-0 px-3"
                  aria-label={`${shortLabel}: ${label}`}
                >
                  <Icon aria-hidden="true" />
                  <span>{shortLabel}</span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <p className="text-muted-foreground max-w-xl text-sm lg:text-right">
            <span className="text-foreground font-medium">
              {layoutLabel(config.layout.kind)}.
            </span>{" "}
            {layoutQuestions[config.layout.kind]}
          </p>
        </div>
        {!module.fields.some((field) => field.type === "date") ? (
          <Alert role="note" variant="warning">
            Calendar and Gantt are unavailable for {module.name} because it has
            no date fields.
          </Alert>
        ) : null}
        {activeFilterCount > 0 ? (
          <div
            className="flex flex-wrap items-center gap-2"
            aria-label="Active filters"
          >
            <span className="text-muted-foreground text-xs font-medium">
              Active filters
            </span>
            {config.search ? (
              <Badge variant="outline">Search: {config.search}</Badge>
            ) : null}
            {config.filters.clauses.map((clause, index) => (
              <Badge
                key={`${clause.field}-${clause.operator}-${index}`}
                variant="outline"
                className="gap-1"
              >
                {fieldLabel(module, clause.field)}{" "}
                {filterOperatorLabel(clause.operator)} {clause.value}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-11"
                  aria-label={`Remove ${fieldLabel(module, clause.field)} filter`}
                  onClick={() =>
                    changeFilters({
                      ...config.filters,
                      clauses: config.filters.clauses.filter(
                        (_, clauseIndex) => clauseIndex !== index,
                      ),
                    })
                  }
                >
                  <X aria-hidden="true" />
                </Button>
              </Badge>
            ))}
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              onClick={() =>
                change({
                  search: "",
                  filters: { ...config.filters, clauses: [] },
                })
              }
            >
              Clear all
            </Button>
          </div>
        ) : null}
        <Collapsible open={filtersOpen} onOpenChange={setFiltersOpen}>
          <CollapsibleContent className="flex flex-col gap-4 border-t pt-4">
            <OpenViewFilterEditor
              module={module}
              filters={config.filters}
              onChange={changeFilters}
              idPrefix="openview-view-filter"
              description="Match records with up to eight conditions."
              showEmptyState
              removeVariant="outline"
            />
            <SortBuilder
              module={module}
              sorts={config.sorts}
              onChange={(sorts) => change({ sorts })}
            />
            <Field className="max-w-sm">
              <FieldLabel htmlFor="openview-group-by">
                Group records by
              </FieldLabel>
              <Select
                id="openview-group-by"
                className="min-h-11"
                value={config.groupBy ?? "none"}
                onValueChange={(value) =>
                  change({ groupBy: value === "none" ? null : value })
                }
              >
                <option value="none">No grouping</option>
                {module.fields.map((field) => (
                  <option key={field.id} value={field.id}>
                    {field.label}
                  </option>
                ))}
              </Select>
            </Field>
          </CollapsibleContent>
        </Collapsible>
        <Collapsible open={layoutOpen} onOpenChange={setLayoutOpen}>
          <CollapsibleContent className="flex flex-col gap-5 border-t pt-4">
            <LayoutBuilder
              module={module}
              layout={config.layout}
              groupBy={config.groupBy}
              onGroupByChange={(groupBy) => change({ groupBy })}
              onChange={changeLayout}
            />
          </CollapsibleContent>
        </Collapsible>
      </section>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">
            {page
              ? `${page.items.length} of ${page.total} matching records`
              : `${selectedRows.length} of ${rows.length} records`}
          </Badge>
          {dateRangeSupported ? (
            <Badge variant="outline">
              {dateRangeLabel(config.layout.dateRange)} date window
            </Badge>
          ) : null}
          {config.groupBy ? (
            <Badge variant="outline">
              <Group data-icon="inline-start" aria-hidden="true" /> Grouped by{" "}
              {fieldLabel(module, config.groupBy)}
            </Badge>
          ) : null}
          {activeSaved ? (
            <>
              <Badge variant="outline">{activeSaved.name}</Badge>
              <Badge
                variant={
                  isUnresolvedAudience(activeSaved.audience)
                    ? "warning"
                    : "outline"
                }
              >
                Audience preview: {audienceLabel(activeSaved.audience, lookup)}
              </Badge>
            </>
          ) : (
            <Badge variant="outline">Unsaved view</Badge>
          )}
          {dirty ? <Badge variant="outline">Unsaved changes</Badge> : null}
          {moduleDefault ? (
            <Badge variant="outline">Module default</Badge>
          ) : null}
        </div>
        {moduleDefault ? (
          <Button
            type="button"
            variant="ghost"
            className="min-h-11"
            disabled={commandPending}
            onClick={async () => {
              if (commandPending) return;
              setNotice("");
              try {
                const result = await commands.setViewDefault(module.id, null);
                if (!result.ok) {
                  setNotice(result.error);
                  return;
                }
                setNotice(
                  `“${moduleDefault.name}” is no longer the default for ${module.name}.`,
                );
              } catch (error) {
                setNotice(
                  sampleOperationMessage(
                    error,
                    "The default could not be changed. Try again.",
                  ),
                );
              }
            }}
          >
            Unset module default
          </Button>
        ) : activeSaved ? (
          <Button
            type="button"
            variant="ghost"
            className="min-h-11"
            disabled={commandPending}
            onClick={async () => {
              if (commandPending) return;
              setNotice("");
              try {
                const result = await commands.setViewDefault(
                  module.id,
                  activeSaved.id,
                );
                if (!result.ok) {
                  setNotice(result.error);
                  return;
                }
                setNotice(
                  `“${activeSaved.name}” is now the default for ${module.name}.`,
                );
              } catch (error) {
                setNotice(
                  sampleOperationMessage(
                    error,
                    "The default could not be changed. Try again.",
                  ),
                );
              }
            }}
          >
            Set as module default
          </Button>
        ) : null}
      </div>
      {notice ? (
        <Alert
          role="status"
          variant={
            notice.includes("could not") || notice.includes("changed")
              ? "warning"
              : "success"
          }
        >
          {notice}
        </Alert>
      ) : null}
      <OperationalContextBand
        module={module}
        layout={config.layout}
        rows={selectedRows}
      />
      {unknownRecord ? (
        <Empty className="min-h-56 border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Link2 aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>Record unavailable</EmptyTitle>
            <EmptyDescription>
              This record link does not belong to the selected sample data
              source.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={onCloseInspect}
            >
              Return to records
            </Button>
          </EmptyContent>
        </Empty>
      ) : inspected ? (
        <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]">
          {selectedRows.length > 0 ? (
            <RecordResults
              module={module}
              grouped={grouped}
              layout={config.layout}
              groupBy={config.groupBy}
              page={page}
              onPageChange={setPageOffset}
              onInspect={onInspect}
            />
          ) : (
            emptyResults
          )}
          <RecordInspector
            module={module}
            rows={selectedRows}
            inspected={inspected}
            onClose={onCloseInspect}
            onNavigate={onInspect}
          />
        </div>
      ) : selectedRows.length === 0 ? (
        emptyResults
      ) : (
        <RecordResults
          module={module}
          grouped={grouped}
          layout={config.layout}
          groupBy={config.groupBy}
          page={page}
          onPageChange={setPageOffset}
          onInspect={onInspect}
        />
      )}
      <SaveViewDialog
        open={saveOpen}
        onOpenChange={(open) => {
          if (!open && savePending) return;
          if (!open) {
            setSaveIntent(null);
            setSaveError("");
          }
          setSaveOpen(open);
        }}
        pending={savePending}
        error={saveError}
        name={viewName}
        onNameChange={changeViewName}
        audience={audience}
        onAudienceChange={handleAudienceChange}
        options={audienceOptions}
        description={
          effectiveSaveIntent.kind === "update"
            ? "Update this saved view's configuration and audience preview."
            : "Save this configuration for quick reuse in this tab."
        }
        submitLabel={
          effectiveSaveIntent.kind === "update" ? "Update view" : "Save view"
        }
        onSubmit={() =>
          saveCurrent(
            viewName,
            audienceFromValue(audience, lookup),
            effectiveSaveIntent,
          )
        }
      />
      <AlertDialog
        open={pendingAudience !== null}
        onOpenChange={(open) => {
          if (!open && commandPending) return;
          if (!open) setPendingAudience(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Preview sharing with everyone?</AlertDialogTitle>
            <AlertDialogDescription>
              This sample setting demonstrates a wider audience. It does not
              grant access, send invitations, or publish this view.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={commandPending}
              onClick={() => setPendingAudience(null)}
            >
              Not now
            </Button>
            <Button
              type="button"
              className="min-h-11"
              disabled={commandPending}
              onClick={() => {
                if (pendingAudience)
                  changeAudience(audienceValue(pendingAudience));
                setPendingAudience(null);
              }}
            >
              Use Everyone preview
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog
        open={renameOpen}
        onOpenChange={(open) => {
          if (!open && savePending) return;
          if (!open) {
            setSaveIntent(null);
            setSaveError("");
          }
          setRenameOpen(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename saved view</DialogTitle>
            <DialogDescription>
              The name is stored locally with this sample workspace.
            </DialogDescription>
          </DialogHeader>
          {savePending ? (
            <p role="status" className="text-muted-foreground text-sm">
              Saving this view… Keep the rename dialog open until it finishes.
            </p>
          ) : null}
          {saveError ? (
            <Alert role="alert" variant="destructive">
              {saveError}
            </Alert>
          ) : null}
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="openview-rename">View name</FieldLabel>
              <Input
                id="openview-rename"
                className="min-h-11"
                maxLength={80}
                value={viewName}
                disabled={savePending}
                onChange={(event) => changeViewName(event.target.value)}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={savePending}
              onClick={() => setRenameOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="min-h-11"
              disabled={!activeSaved || savePending}
              onClick={() =>
                effectiveSaveIntent.kind === "update" &&
                saveCurrent(
                  viewName,
                  effectiveSaveIntent.expected.audience,
                  effectiveSaveIntent,
                )
              }
            >
              Rename view
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!open && deletePending) return;
          if (!open) setDeleteError("");
          setDeleteOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this saved view?</AlertDialogTitle>
            <AlertDialogDescription>
              “{activeSaved?.name}” will be removed from this tab. This does not
              delete any records.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deletePending ? (
            <p role="status" className="text-muted-foreground text-sm">
              Deleting this view… Keep the confirmation open until it finishes.
            </p>
          ) : null}
          {deleteError ? (
            <Alert role="alert" variant="warning">
              {deleteError}
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={deletePending}
              onClick={() => {
                setDeleteError("");
                setDeleteOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="min-h-11"
              disabled={deletePending}
              onClick={deleteView}
            >
              {commands.isPending(deleteKey) ? "Deleting…" : "Delete view"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={resetOpen}
        onOpenChange={(open) => {
          if (!open && commandPending) return;
          if (!open) setResetError("");
          setResetOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset OpenView settings?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes saved views and restores this tab to the default
              OpenView configuration. Records are not changed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {commandPending ? (
            <p role="status" className="text-muted-foreground text-sm">
              An OpenView change is still being saved. Keep this confirmation
              open until it finishes.
            </p>
          ) : null}
          <AlertDialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={commandPending}
              onClick={() => {
                setResetError("");
                setResetOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="min-h-11"
              disabled={commandPending}
              onClick={async () => {
                setResetError("");
                const result = await onResetOpenView();
                if (result.ok) {
                  setResetError("");
                  setResetOpen(false);
                } else setResetError(result.error);
              }}
            >
              {commandPending ? "Resetting OpenView…" : "Reset OpenView"}
            </Button>
          </AlertDialogFooter>
          {resetError ? (
            <Alert role="alert" variant="warning">
              {resetError}
            </Alert>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SavedViewMenu({
  module,
  savedViews,
  selectedViewId,
  moduleDefault,
  disabled = false,
  onSelect,
  onCreate,
}: {
  module: OpenViewModule;
  savedViews: ModelSavedView[];
  selectedViewId: string;
  moduleDefault?: ModelSavedView;
  disabled?: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  const moduleViews = savedViews.filter((view) => view.moduleId === module.id);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Field className="min-w-0 sm:min-w-48">
        <FieldLabel htmlFor="openview-saved-view" className="sr-only">
          Saved view
        </FieldLabel>
        <Select
          id="openview-saved-view"
          className="min-h-11"
          value={selectedViewId}
          disabled={disabled}
          onValueChange={onSelect}
          aria-label="Saved view"
        >
          <option value="">Unsaved view</option>
          {moduleViews.map((view) => (
            <option key={view.id} value={view.id}>
              {view.name}
              {view.id === moduleDefault?.id ? " · default" : ""}
            </option>
          ))}
        </Select>
      </Field>
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-11"
        aria-label="Create saved view"
        disabled={disabled}
        onClick={onCreate}
      >
        <Plus aria-hidden="true" />
      </Button>
    </div>
  );
}

function OperationalContextBand({
  module,
  layout,
  rows,
}: {
  module: OpenViewModule;
  layout: ViewLayout;
  rows: OpenViewRow[];
}) {
  const summary = summarizeOpenViewOperationalRows(rows, module.id);
  const profile = getOpenViewOperationalProfile(module.id);
  const layoutTitle = layoutLabel(layout.kind);
  const facts = [
    { label: "Visible", value: summary.total },
    { label: "Needs attention", value: summary.needsAttention },
    {
      label: "Blocked / overdue / due soon",
      value: `${summary.blocked} / ${summary.overdue} / ${summary.dueSoon}`,
    },
    { label: "High priority", value: summary.highPriority },
  ];

  return (
    <section
      className="border-y py-3"
      aria-labelledby="openview-operational-context"
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h2
            id="openview-operational-context"
            className="text-base font-semibold"
          >
            {layoutTitle}
          </h2>
          <p className="text-muted-foreground mt-1 max-w-3xl text-sm">
            {layoutQuestions[layout.kind]} Showing {module.name.toLowerCase()}{" "}
            by {profile.dateMeaning.toLocaleLowerCase()}.
          </p>
        </div>
        <p className="text-muted-foreground shrink-0 text-xs">
          Sample snapshot: {displayDate(summary.snapshotDate)} ·{" "}
          {summary.timezone}
        </p>
      </div>
      <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
        {facts.map((fact) => (
          <div key={fact.label} className="flex items-baseline gap-1.5">
            <dt className="text-muted-foreground">{fact.label}</dt>
            <dd className="font-semibold tabular-nums">{fact.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function SortBuilder({
  module,
  sorts,
  onChange,
}: {
  module: OpenViewModule;
  sorts: SortRule[];
  onChange: (sorts: SortRule[]) => void;
}) {
  const addSort = () => {
    if (sorts.length >= 3) return;
    const unused = module.fields.find(
      (field) => !sorts.some((sort) => sort.field === field.id),
    );
    if (unused) onChange([...sorts, { field: unused.id, direction: "asc" }]);
  };
  return (
    <FieldSet>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <FieldLegend>Sort order</FieldLegend>
          <p className="text-muted-foreground text-xs">
            The first rule has the highest priority.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={sorts.length >= 3}
          onClick={addSort}
        >
          <Plus data-icon="inline-start" aria-hidden="true" /> Add sort
        </Button>
      </div>
      {sorts.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Records keep their source order.
        </p>
      ) : null}
      <div className="flex flex-col gap-3">
        {sorts.map((sort, index) => (
          <div
            key={`${index}-${sort.field}`}
            className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_auto] sm:items-end"
          >
            <Field>
              <FieldLabel htmlFor={`openview-sort-field-${index}`}>
                Sort {index + 1} by
              </FieldLabel>
              <Select
                id={`openview-sort-field-${index}`}
                className="min-h-11"
                value={sort.field}
                onValueChange={(field) =>
                  onChange(
                    sorts.map((entry, entryIndex) =>
                      entryIndex === index ? { ...entry, field } : entry,
                    ),
                  )
                }
              >
                {module.fields.map((field) => (
                  <option key={field.id} value={field.id}>
                    {field.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor={`openview-sort-direction-${index}`}>
                Direction
              </FieldLabel>
              <Select
                id={`openview-sort-direction-${index}`}
                className="min-h-11"
                value={sort.direction}
                onValueChange={(direction) =>
                  onChange(
                    sorts.map((entry, entryIndex) =>
                      entryIndex === index
                        ? {
                            ...entry,
                            direction: direction as SortRule["direction"],
                          }
                        : entry,
                    ),
                  )
                }
              >
                <option value="asc">Ascending (A → Z)</option>
                <option value="desc">Descending (Z → A)</option>
              </Select>
            </Field>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-11"
              aria-label={`Remove sort ${index + 1}`}
              onClick={() =>
                onChange(sorts.filter((_, entryIndex) => entryIndex !== index))
              }
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        ))}
      </div>
    </FieldSet>
  );
}

function LayoutBuilder({
  module,
  layout,
  groupBy,
  onGroupByChange,
  onChange,
}: {
  module: OpenViewModule;
  layout: ViewLayout;
  groupBy: string | null;
  onGroupByChange: (groupBy: string | null) => void;
  onChange: (layout: ViewLayout) => void;
}) {
  const update = (partial: Partial<ViewLayout>) =>
    onChange({ ...layout, ...partial });
  const visibleColumns = layout.columns.flatMap((fieldId) => {
    const field = module.fields.find((candidate) => candidate.id === fieldId);
    return field ? [field] : [];
  });
  const visibleColumnIds = visibleColumns.map((field) => field.id);
  const orderedFields = [
    ...visibleColumns,
    ...module.fields.filter((field) => !visibleColumnIds.includes(field.id)),
  ];
  const moveColumn = (fieldId: string, direction: -1 | 1) => {
    const index = visibleColumnIds.indexOf(fieldId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= visibleColumnIds.length)
      return;
    const columns = [...layout.columns];
    const sourceIndex = columns.indexOf(visibleColumnIds[index]);
    const targetIndex = columns.indexOf(visibleColumnIds[nextIndex]);
    if (sourceIndex < 0 || targetIndex < 0) return;
    [columns[sourceIndex], columns[targetIndex]] = [
      columns[targetIndex],
      columns[sourceIndex],
    ];
    update({ columns });
  };
  const dateFields = module.fields.filter((field) => field.type === "date");
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {layout.kind === "table" ? (
        <FieldSet>
          <FieldLegend>Visible columns and order</FieldLegend>
          <Field>
            <FieldDescription>
              Use the arrows to set the order shown in the table. Pin one column
              to keep it visible while scrolling horizontally.
            </FieldDescription>
          </Field>
          <div className="flex flex-col gap-2">
            {orderedFields.map((field) => {
              const checked = layout.columns.includes(field.id);
              const index = visibleColumnIds.indexOf(field.id);
              return (
                <div
                  key={field.id}
                  className="flex items-center justify-between gap-3 rounded-[var(--radius)] border p-2"
                >
                  <Field className="min-h-11 flex-1 flex-row items-center gap-3">
                    <Checkbox
                      id={`openview-column-${field.id}`}
                      checked={checked}
                      onCheckedChange={(next) => {
                        if (!next && layout.columns.length <= 1) return;
                        update({
                          columns: next
                            ? [...layout.columns, field.id]
                            : layout.columns.filter((id) => id !== field.id),
                          pinnedColumns: next
                            ? layout.pinnedColumns
                            : layout.pinnedColumns.filter(
                                (id) => id !== field.id,
                              ),
                        });
                      }}
                    />
                    <FieldLabel
                      htmlFor={`openview-column-${field.id}`}
                      className="font-normal"
                    >
                      {field.label}
                    </FieldLabel>
                  </Field>
                  <Field className="min-h-11 flex-row items-center gap-2">
                    <Checkbox
                      id={`openview-pin-${field.id}`}
                      checked={layout.pinnedColumns.includes(field.id)}
                      disabled={!checked}
                      onCheckedChange={(next) =>
                        update({
                          pinnedColumns: next ? [field.id] : [],
                        })
                      }
                    />
                    <FieldLabel
                      htmlFor={`openview-pin-${field.id}`}
                      className="font-normal"
                    >
                      Pin
                    </FieldLabel>
                  </Field>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-11"
                      disabled={!checked || index <= 0}
                      aria-label={`Move ${field.label} up`}
                      onClick={() => moveColumn(field.id, -1)}
                    >
                      <ArrowUp aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-11"
                      disabled={!checked || index === visibleColumns.length - 1}
                      aria-label={`Move ${field.label} down`}
                      onClick={() => moveColumn(field.id, 1)}
                    >
                      <ArrowDown aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </FieldSet>
      ) : (
        <FieldSet>
          <FieldLegend>Card content</FieldLegend>
          <Field>
            <FieldDescription>
              Choose the most useful fields for this layout.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="openview-layout-primary">
              Primary field
            </FieldLabel>
            <Select
              id="openview-layout-primary"
              className="min-h-11"
              value={layout.primaryField ?? module.primaryField}
              onValueChange={(primaryField) => update({ primaryField })}
            >
              {module.fields.map((field) => (
                <option key={field.id} value={field.id}>
                  {field.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="openview-layout-secondary">
              Secondary field
            </FieldLabel>
            <Select
              id="openview-layout-secondary"
              className="min-h-11"
              value={
                layout.secondaryField ??
                module.fields[1]?.id ??
                module.primaryField
              }
              onValueChange={(secondaryField) => update({ secondaryField })}
            >
              {module.fields.map((field) => (
                <option key={field.id} value={field.id}>
                  {field.label}
                </option>
              ))}
            </Select>
          </Field>
          {layout.kind === "grid" || layout.kind === "gallery" ? (
            <Field>
              <FieldLabel>Card size</FieldLabel>
              <ToggleGroup
                value={[layout.cardSize]}
                onValueChange={(value) => {
                  const cardSize = value[0];
                  if (cardSize === "comfortable" || cardSize === "compact")
                    update({ cardSize });
                }}
                variant="outline"
                aria-label="Card size"
              >
                <ToggleGroupItem value="comfortable" className="min-h-11">
                  Comfortable
                </ToggleGroupItem>
                <ToggleGroupItem value="compact" className="min-h-11">
                  Compact
                </ToggleGroupItem>
              </ToggleGroup>
            </Field>
          ) : null}
          {layout.kind === "kanban" ? (
            <Field>
              <FieldLabel htmlFor="openview-kanban-group">
                Kanban lanes
              </FieldLabel>
              <Select
                id="openview-kanban-group"
                className="min-h-11"
                value={groupBy ?? "status"}
                onValueChange={(value) =>
                  onGroupByChange(value === "none" ? null : value)
                }
              >
                <option value="none">No lanes</option>
                {module.fields.map((field) => (
                  <option key={field.id} value={field.id}>
                    {field.label}
                  </option>
                ))}
              </Select>
              <FieldDescription>
                Choose the field that creates each lane.
              </FieldDescription>
            </Field>
          ) : null}
        </FieldSet>
      )}
      <FieldSet>
        <FieldLegend>Presentation</FieldLegend>
        <Field className="min-h-11 flex-row items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <FieldLabel htmlFor="openview-wrap">Wrap long text</FieldLabel>
            <FieldDescription>
              Keep full values visible when space is tight.
            </FieldDescription>
          </div>
          <Checkbox
            id="openview-wrap"
            checked={layout.wrap}
            onCheckedChange={(wrap) => update({ wrap: Boolean(wrap) })}
          />
        </Field>
        {layout.kind === "table" ? (
          <Field>
            <FieldLabel>Row density</FieldLabel>
            <ToggleGroup
              value={[layout.density]}
              onValueChange={(value) => {
                const density = value[0];
                if (density === "comfortable" || density === "compact")
                  update({ density });
              }}
              variant="outline"
              aria-label="Row density"
            >
              <ToggleGroupItem value="comfortable" className="min-h-11">
                Comfortable
              </ToggleGroupItem>
              <ToggleGroupItem value="compact" className="min-h-11">
                Compact
              </ToggleGroupItem>
            </ToggleGroup>
          </Field>
        ) : null}
        {layout.kind === "calendar" || layout.kind === "timeline" ? (
          dateFields.length ? (
            <>
              <Field>
                <FieldLabel htmlFor="openview-date-field">
                  Date field
                </FieldLabel>
                <Select
                  id="openview-date-field"
                  className="min-h-11"
                  value={
                    dateFieldForLayout(module, layout) ??
                    dateFields[0]?.id ??
                    ""
                  }
                  onValueChange={(dateField) => {
                    if (dateFields.some((field) => field.id === dateField))
                      update({ dateField });
                  }}
                >
                  {dateFields.map((field) => (
                    <option key={field.id} value={field.id}>
                      {field.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field>
                <FieldLabel>
                  {layout.kind === "timeline"
                    ? "Gantt density"
                    : "Calendar view"}
                </FieldLabel>
                <ToggleGroup
                  value={[layout.scale ?? "month"]}
                  onValueChange={(value) => {
                    const scale = value[0];
                    if (scale === "month" || scale === "list")
                      update({ scale });
                  }}
                  variant="outline"
                  aria-label={
                    layout.kind === "timeline"
                      ? "Gantt density"
                      : "Calendar view"
                  }
                >
                  <ToggleGroupItem value="month" className="min-h-11">
                    {layout.kind === "timeline" ? "Detailed" : "Month view"}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="list" className="min-h-11">
                    {layout.kind === "timeline" ? "Compact" : "List view"}
                  </ToggleGroupItem>
                </ToggleGroup>
              </Field>
              <Field>
                <FieldLabel>Date range</FieldLabel>
                <ToggleGroup
                  value={[layout.dateRange]}
                  onValueChange={(value) => {
                    const dateRange = value[0];
                    if (
                      dateRange === "week" ||
                      dateRange === "month" ||
                      dateRange === "quarter" ||
                      dateRange === "year"
                    )
                      update({ dateRange });
                  }}
                  variant="outline"
                  aria-label="Date range"
                  className="flex-wrap"
                >
                  <ToggleGroupItem value="week" className="min-h-11">
                    Week
                  </ToggleGroupItem>
                  <ToggleGroupItem value="month" className="min-h-11">
                    Month
                  </ToggleGroupItem>
                  <ToggleGroupItem value="quarter" className="min-h-11">
                    Quarter
                  </ToggleGroupItem>
                  <ToggleGroupItem value="year" className="min-h-11">
                    Year
                  </ToggleGroupItem>
                </ToggleGroup>
              </Field>
            </>
          ) : (
            <Alert role="note" variant="warning">
              This layout is unavailable because {module.name} has no date
              fields. Choose another layout.
            </Alert>
          )
        ) : null}
      </FieldSet>
    </div>
  );
}

function RecordResults({
  module,
  grouped,
  layout,
  groupBy,
  page,
  onPageChange,
  onInspect,
}: {
  module: OpenViewModule;
  grouped: { label: string; rows: OpenViewRow[] }[];
  layout: ViewLayout;
  groupBy: string | null;
  page?: PageResult<OpenViewRow>;
  onPageChange?: (offset: number) => void;
  onInspect: (id: string) => void;
}) {
  const anchorRows = grouped.flatMap((group) => group.rows);
  const usesOperationalStatusLanes =
    layout.kind === "kanban" &&
    (groupBy === null ||
      groupBy === getOpenViewOperationalProfile(module.id).statusField);
  if (usesOperationalStatusLanes) {
    return (
      <div className="flex min-w-0 flex-col gap-3">
        <RecordLayout
          module={module}
          rows={anchorRows}
          anchorRows={anchorRows}
          layout={layout}
          groupBy={groupBy}
          onInspect={onInspect}
        />
        {page && onPageChange ? (
          <OpenViewPageControls page={page} onPageChange={onPageChange} />
        ) : null}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-5">
      {grouped.map((group, index) => (
        <section
          key={group.label}
          className="flex min-w-0 flex-col gap-3"
          aria-labelledby={
            grouped.length > 1 ? `openview-group-${index}` : undefined
          }
        >
          {grouped.length > 1 ? (
            <h2
              id={`openview-group-${index}`}
              className="text-sm font-semibold"
            >
              {group.label}{" "}
              <span className="text-muted-foreground font-normal">
                · {group.rows.length}
              </span>
            </h2>
          ) : null}
          <RecordLayout
            module={module}
            rows={group.rows}
            anchorRows={anchorRows}
            layout={layout}
            groupBy={groupBy}
            onInspect={onInspect}
          />
        </section>
      ))}
      {page && onPageChange ? (
        <OpenViewPageControls page={page} onPageChange={onPageChange} />
      ) : null}
    </div>
  );
}

function OpenViewPageControls({
  page,
  onPageChange,
}: {
  page: PageResult<OpenViewRow>;
  onPageChange: (offset: number) => void;
}) {
  if (page.total <= page.limit) return null;
  const first = page.offset + 1;
  const last = Math.min(page.offset + page.items.length, page.total);
  return (
    <nav
      aria-label="OpenView record pages"
      className="flex flex-wrap items-center justify-between gap-3 border-t pt-3"
    >
      <p className="text-muted-foreground text-sm" aria-live="polite">
        Showing {first}–{last} of {page.total} matching records
      </p>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={page.offset === 0}
          onClick={() => onPageChange(Math.max(0, page.offset - page.limit))}
        >
          <ArrowLeft data-icon="inline-start" aria-hidden="true" /> Previous
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={page.offset + page.items.length >= page.total}
          onClick={() => onPageChange(page.offset + page.limit)}
        >
          Next <ArrowRight data-icon="inline-end" aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}

function RecordLayout({
  module,
  rows,
  anchorRows,
  layout,
  groupBy,
  onInspect,
}: {
  module: OpenViewModule;
  rows: OpenViewRow[];
  anchorRows: OpenViewRow[];
  layout: ViewLayout;
  groupBy: string | null;
  onInspect: (id: string) => void;
}) {
  const configuredColumns = layout.columns.flatMap((fieldId) => {
    const field = module.fields.find((candidate) => candidate.id === fieldId);
    return field ? [field] : [];
  });
  const columns = configuredColumns.length ? configuredColumns : module.fields;
  const primary = layout.primaryField ?? module.primaryField;
  const secondary =
    layout.secondaryField ?? module.fields[1]?.id ?? module.primaryField;
  const statusField = module.fields.find((field) => field.id === "status");
  const operationalProfile = getOpenViewOperationalProfile(module.id);
  const dateField = dateFieldForLayout(module, layout);
  const dateLabel =
    module.fields.find((field) => field.id === dateField)?.label ?? "Date";
  if (
    (layout.kind === "calendar" || layout.kind === "timeline") &&
    !dateField
  ) {
    return (
      <Alert role="note" variant="warning">
        {module.name} cannot use {titleCase(layout.kind)} because it has no date
        fields. Choose another layout.
      </Alert>
    );
  }
  const renderDateField = dateField ?? "";
  const value = (row: OpenViewRow, field: OpenViewField) =>
    String(row.values[field.id] ?? "");
  const renderProgress = (row: OpenViewRow) => {
    const progress = getOpenViewOperationalFacts(row).progress;
    if (progress === null) return "Unspecified";
    return (
      <span className="flex min-w-32 items-center gap-2">
        <span
          className="bg-muted relative h-2 min-w-16 flex-1 overflow-hidden rounded-full"
          role="progressbar"
          aria-label={`Progress ${progress}%`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
        >
          <span
            className="bg-primary absolute inset-y-0 left-0 rounded-full"
            style={{ width: `${progress}%` }}
          />
        </span>
        <span className="tabular-nums">{progress}%</span>
      </span>
    );
  };
  const rendered = (row: OpenViewRow, field: OpenViewField) => {
    const rawValue = value(row, field);
    const fieldValue = rawValue || "Unspecified";
    if (field.id === operationalProfile.progressField)
      return renderProgress(row);
    if (field.type === "date")
      return rawValue ? displayDate(rawValue) : "Unscheduled";
    if (field.type !== "select") return fieldValue || "—";
    const tone = visualTone(fieldValue);
    return (
      <Badge
        variant="outline"
        className={cn("gap-1.5 font-medium", tone.surface, tone.border)}
      >
        <span
          className={cn("size-1.5 rounded-full", tone.solid)}
          aria-hidden="true"
        />
        {fieldValue}
      </Badge>
    );
  };
  if (layout.kind === "table") {
    const summaryField = columns[0];

    return (
      <>
        <section className="md:hidden" aria-label={`${module.name} records`}>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {rows.map((row, rowIndex) => {
              const rowStatus = statusField
                ? String(row.values[statusField.id] ?? "")
                : "";
              const tone = visualTone(rowStatus, rowIndex);
              return (
                <li key={row.id} className="bg-card rounded-lg border p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <span
                        className={cn(
                          "mt-1 h-7 w-1 shrink-0 rounded-full",
                          tone.solid,
                        )}
                        aria-hidden="true"
                      />
                      {summaryField ? (
                        <div className="min-w-0">
                          <p className="text-muted-foreground text-[0.6875rem] font-semibold tracking-wide uppercase">
                            {summaryField.label}
                          </p>
                          <div className="mt-1 text-sm font-medium break-words">
                            {rendered(row, summaryField)}
                          </div>
                        </div>
                      ) : null}
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 shrink-0"
                      onClick={() => onInspect(row.id)}
                    >
                      Inspect
                      <ArrowRight data-icon="inline-end" aria-hidden="true" />
                    </Button>
                  </div>
                  {summaryField && columns.length > 1 ? (
                    <dl className="mt-4 grid gap-x-4 gap-y-3 border-t pt-4 sm:grid-cols-2">
                      {columns.map((field) =>
                        field.id === summaryField.id ? null : (
                          <div key={field.id} className="min-w-0">
                            <dt className="text-muted-foreground text-[0.6875rem] font-semibold tracking-wide uppercase">
                              {field.label}
                            </dt>
                            <dd className="mt-1 text-sm break-words">
                              {rendered(row, field)}
                            </dd>
                          </div>
                        ),
                      )}
                    </dl>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
        <Card className="hidden w-full overflow-hidden md:block">
          <Table className="min-w-[44rem]">
            <TableCaption className="sr-only">
              {rows.length} {rows.length === 1 ? "record" : "records"} from{" "}
              {module.name}.
            </TableCaption>
            <TableHeader className="bg-muted/65">
              <TableRow className="hover:bg-muted/65">
                {columns.map((field) => (
                  <TableHead
                    key={field.id}
                    className={cn(
                      "h-11 px-4 text-[0.6875rem] font-semibold tracking-wide uppercase",
                      layout.pinnedColumns.includes(field.id)
                        ? "bg-muted sticky left-0 z-10"
                        : undefined,
                    )}
                  >
                    {field.label}
                  </TableHead>
                ))}
                <TableHead className="h-11 px-4">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, rowIndex) => {
                const rowStatus = statusField
                  ? String(row.values[statusField.id] ?? "")
                  : "";
                const tone = visualTone(rowStatus, rowIndex);
                return (
                  <TableRow key={row.id} className="group odd:bg-muted/20">
                    {columns.map((field) => (
                      <TableCell
                        key={field.id}
                        className={cn(
                          "px-4",
                          layout.wrap
                            ? "whitespace-normal"
                            : "whitespace-nowrap",
                          layout.density === "comfortable" ? "py-3" : "py-1.5",
                          layout.pinnedColumns.includes(field.id)
                            ? "bg-card group-odd:bg-muted sticky left-0 z-10"
                            : undefined,
                        )}
                      >
                        {field.id === primary ? (
                          <Button
                            type="button"
                            variant="ghost"
                            className="h-auto min-h-11 justify-start gap-3 px-2 text-left font-medium"
                            onClick={() => onInspect(row.id)}
                          >
                            <span
                              className={cn(
                                "h-7 w-1 shrink-0 rounded-full",
                                tone.solid,
                              )}
                              aria-hidden="true"
                            />
                            {rendered(row, field)}
                          </Button>
                        ) : (
                          rendered(row, field)
                        )}
                      </TableCell>
                    ))}
                    <TableCell className="px-4 text-right">
                      <Button
                        type="button"
                        variant="ghost"
                        className="min-h-11"
                        onClick={() => onInspect(row.id)}
                      >
                        Inspect
                        <ArrowRight data-icon="inline-end" aria-hidden="true" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      </>
    );
  }
  if (layout.kind === "kanban") {
    const operationalLanes =
      groupBy === null || groupBy === operationalProfile.statusField;
    const groupField =
      module.fields.find((field) => field.id === groupBy) ??
      module.fields.find((field) => field.id === "status") ??
      module.fields[0];
    const laneValue = (row: OpenViewRow) =>
      groupField ? value(row, groupField) || "Unspecified" : "All records";
    const lanes = operationalLanes
      ? getOpenViewLanes(rows, module.id).filter(
          (lane) => lane.count > 0 || lane.configured,
        )
      : [...new Set(rows.map(laneValue))].map((label) => {
          const laneRows = rows.filter((row) => laneValue(row) === label);
          return {
            label,
            rows: laneRows,
            facts: laneRows.map((row) => getOpenViewOperationalFacts(row)),
            count: laneRows.length,
            configured: false,
          };
        });
    return (
      <div className="grid auto-cols-[minmax(17rem,1fr)] grid-flow-col gap-4 overflow-x-auto pb-2 lg:grid-flow-row lg:grid-cols-3 lg:overflow-visible xl:grid-cols-4">
        {lanes.map((lane, laneIndex) => {
          const tone = visualTone(lane.label, laneIndex);
          const attentionCount = lane.facts.filter(
            (fact) => fact.attentionRank > 0,
          ).length;
          const laneRows = lane.rows;
          const exceptionLane = attentionCount > 0;
          return (
            <Card
              key={lane.label}
              className={cn(
                "bg-muted/25 min-w-0 overflow-hidden",
                exceptionLane && "border-chart-5/50",
              )}
              aria-label={`${lane.label} lane, ${lane.count} records${attentionCount ? `, ${attentionCount} need attention` : ""}`}
            >
              <div className={cn("h-1", tone.solid)} aria-hidden="true" />
              <CardHeader className={cn("p-4", tone.surface)}>
                <CardTitle className="flex items-center justify-between gap-3 text-sm">
                  <span className="truncate">{lane.label}</span>
                  <Badge
                    variant="outline"
                    className={cn("bg-card", tone.border)}
                  >
                    {lane.count}
                  </Badge>
                </CardTitle>
                <CardDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span>
                    {operationalLanes
                      ? lane.configured
                        ? "Workflow stage"
                        : "Additional stage"
                      : `${groupField?.label ?? "Records"} group`}
                  </span>
                  {attentionCount ? (
                    <Badge variant="warning" className="text-[0.6875rem]">
                      {attentionCount} need attention
                    </Badge>
                  ) : (
                    <span>No attention flags</span>
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 p-3">
                {laneRows.map((row) => {
                  const facts = getOpenViewOperationalFacts(row);
                  const priorityTone = visualTone(facts.priority, 1);
                  return (
                    <Button
                      key={row.id}
                      type="button"
                      variant="outline"
                      className="bg-card h-auto min-h-24 overflow-hidden p-0 text-left whitespace-normal"
                      onClick={() => onInspect(row.id)}
                    >
                      <span className="flex w-full flex-col">
                        <span
                          className={cn("h-1 w-full", tone.solid)}
                          aria-hidden="true"
                        />
                        <span className="flex flex-col gap-2 p-4">
                          <span className="flex items-start justify-between gap-3">
                            <span className="leading-snug font-medium">
                              {String(row.values[primary] ?? "Untitled")}
                            </span>
                            {facts.priority ? (
                              <Badge
                                variant="outline"
                                className={cn(
                                  "shrink-0 text-[0.6875rem]",
                                  priorityTone.surface,
                                  priorityTone.border,
                                )}
                              >
                                {facts.priority}
                              </Badge>
                            ) : null}
                          </span>
                          <span className="text-muted-foreground text-xs">
                            {String(row.values[secondary] ?? "—")}
                          </span>
                          <span className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                            <span>
                              <span className="text-muted-foreground block">
                                Owner
                              </span>
                              {facts.owner || "Unassigned"}
                            </span>
                            <span>
                              <span className="text-muted-foreground block">
                                Deadline
                              </span>
                              {displayDate(facts.deadline)}
                            </span>
                            <span>
                              <span className="text-muted-foreground block">
                                Status
                              </span>
                              {facts.status || "Unspecified"}
                            </span>
                            <span>
                              <span className="text-muted-foreground block">
                                Progress
                              </span>
                              {facts.progress === null
                                ? "Unspecified"
                                : `${facts.progress}%`}
                            </span>
                          </span>
                          {facts.attentionReason ? (
                            <span className="text-chart-5 text-xs font-medium">
                              {timingStateLabel(facts.timingState)}:{" "}
                              {facts.attentionReason}
                            </span>
                          ) : null}
                        </span>
                      </span>
                    </Button>
                  );
                })}
              </CardContent>
            </Card>
          );
        })}
      </div>
    );
  }
  if (layout.kind === "calendar") {
    const scheduledRows = rows.flatMap((row) => {
      const date = String(row.values[renderDateField] ?? "");
      return /^\d{4}-\d{2}-\d{2}$/.test(date) ? [{ row, date }] : [];
    });
    const unscheduledRows = rows.filter(
      (row) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(String(row.values[renderDateField] ?? "")),
    );
    const dates = [...new Set(scheduledRows.map((entry) => entry.date))].sort();
    const sparseSchedule = scheduledRows.length <= 10;
    if (layout.scale === "list")
      return (
        <Card className="w-full overflow-hidden">
          <CardHeader className="bg-muted/40 p-4">
            <CardTitle>Upcoming schedule</CardTitle>
            <CardDescription>
              Showing {dateLabel.toLocaleLowerCase()} ·{" "}
              {operationalProfile.dateMeaning}.{" "}
              {sparseSchedule
                ? "List view keeps this sparse schedule easy to scan."
                : `${dateRangeLabel(layout.dateRange)} range · ${rows.length} records.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="divide-border divide-y p-0">
            {[...dates, ...(unscheduledRows.length ? [""] : [])].map((date) => {
              const dateRows = date
                ? scheduledRows
                    .filter((entry) => entry.date === date)
                    .map((entry) => entry.row)
                : unscheduledRows;
              return (
                <div
                  key={date || "unscheduled"}
                  className="grid gap-3 p-3 sm:grid-cols-[7rem_1fr] sm:p-4"
                >
                  <div className="flex items-center gap-3 sm:flex-col sm:items-start sm:gap-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold tabular-nums">
                        {formatCalendarDate(date, true)}
                      </span>
                      {date === OPENVIEW_SAMPLE_SNAPSHOT_DATE ? (
                        <Badge variant="secondary" className="text-[0.6875rem]">
                          Sample date
                        </Badge>
                      ) : null}
                    </div>
                    <span className="text-muted-foreground text-xs">
                      {date
                        ? new Intl.DateTimeFormat("en", {
                            timeZone: "UTC",
                            weekday: "long",
                          }).format(new Date(`${date}T00:00:00Z`))
                        : "Needs scheduling"}
                    </span>
                  </div>
                  <div className="grid gap-2">
                    {dateRows.map((row, rowIndex) => {
                      const facts = getOpenViewOperationalFacts(row);
                      const tone = visualTone(facts.status, rowIndex);
                      return (
                        <Button
                          key={row.id}
                          type="button"
                          variant="ghost"
                          className={cn(
                            "h-auto min-h-11 justify-start border px-3 text-left whitespace-normal",
                            tone.surface,
                            tone.border,
                          )}
                          onClick={() => onInspect(row.id)}
                        >
                          <span
                            className={cn(
                              "size-2 shrink-0 rounded-full",
                              tone.solid,
                            )}
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">
                              {String(row.values[primary] ?? "Untitled")}
                            </span>
                            <span className="text-muted-foreground mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs sm:grid-cols-4">
                              <span>
                                Status: {facts.status || "Unspecified"}
                              </span>
                              <span>Owner: {facts.owner || "Unassigned"}</span>
                              <span>
                                Priority: {facts.priority || "Unspecified"}
                              </span>
                              <span>{timingStateLabel(facts.timingState)}</span>
                            </span>
                          </span>
                        </Button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      );
    const monthKeys = [...new Set(dates.map((date) => date.slice(0, 7)))];
    return (
      <div className="flex min-w-0 flex-col gap-4">
        {monthKeys.map((monthKey) => {
          const [yearValue, monthValue] = monthKey.split("-").map(Number);
          const firstDay = new Date(Date.UTC(yearValue, monthValue - 1, 1));
          const dayCount = new Date(
            Date.UTC(yearValue, monthValue, 0),
          ).getUTCDate();
          const leadingDays = firstDay.getUTCDay();
          const monthLabel = new Intl.DateTimeFormat("en", {
            timeZone: "UTC",
            month: "long",
            year: "numeric",
          }).format(firstDay);
          const cells: (number | null)[] = [
            ...Array.from({ length: leadingDays }, () => null),
            ...Array.from({ length: dayCount }, (_, index) => index + 1),
          ];
          const monthRows = scheduledRows.filter((entry) =>
            entry.date.startsWith(monthKey),
          );
          return (
            <Card key={monthKey} className="w-full overflow-hidden">
              <CardHeader className="bg-muted/40 p-4 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <CardTitle>{monthLabel}</CardTitle>
                  <CardDescription>
                    {monthRows.length} scheduled{" "}
                    {monthRows.length === 1 ? "record" : "records"} by{" "}
                    {dateLabel.toLocaleLowerCase()}.{" "}
                    {operationalProfile.dateMeaning}.
                    {sparseSchedule
                      ? " List view is recommended for this sparse schedule."
                      : ""}
                  </CardDescription>
                </div>
                <Badge variant="outline">
                  {dateRangeLabel(layout.dateRange)} range
                </Badge>
              </CardHeader>
              <CardContent className="p-0">
                <div
                  className="overflow-x-auto"
                  role="region"
                  aria-label={`${monthLabel} calendar`}
                  tabIndex={0}
                >
                  <div className="min-w-[46rem]">
                    <div className="bg-muted/25 grid grid-cols-7 border-b">
                      {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
                        (day) => (
                          <div
                            key={day}
                            className="text-muted-foreground px-2 py-2 text-center text-[0.6875rem] font-semibold tracking-wide uppercase"
                          >
                            {day}
                          </div>
                        ),
                      )}
                    </div>
                    <div className="grid grid-cols-7">
                      {cells.map((day, cellIndex) => {
                        if (!day)
                          return (
                            <div
                              key={`blank-${cellIndex}`}
                              className="bg-muted/15 min-h-24 border-r border-b"
                              aria-hidden="true"
                            />
                          );
                        const date = `${monthKey}-${String(day).padStart(2, "0")}`;
                        const dayRows = monthRows.filter(
                          (entry) => entry.date === date,
                        );
                        const isSampleDate =
                          date === OPENVIEW_SAMPLE_SNAPSHOT_DATE;
                        return (
                          <div
                            key={date}
                            className={cn(
                              "min-h-24 border-r border-b p-1.5",
                              isSampleDate && "bg-primary/5",
                            )}
                          >
                            <div className="mb-1 flex items-center justify-between gap-1 px-1">
                              <p className="text-muted-foreground text-xs font-medium tabular-nums">
                                {day}
                              </p>
                              {isSampleDate ? (
                                <Badge
                                  variant="secondary"
                                  className="px-1.5 py-0 text-[0.625rem]"
                                >
                                  Sample date
                                </Badge>
                              ) : null}
                            </div>
                            <div className="flex flex-col gap-1">
                              {dayRows.map((entry, rowIndex) => {
                                const status = statusField
                                  ? String(
                                      entry.row.values[statusField.id] ?? "",
                                    )
                                  : "";
                                const tone = visualTone(status, rowIndex);
                                return (
                                  <Button
                                    key={entry.row.id}
                                    type="button"
                                    variant="ghost"
                                    className={cn(
                                      "h-auto min-h-11 w-full justify-start border px-2 py-1.5 text-left text-xs whitespace-normal",
                                      tone.surface,
                                      tone.border,
                                    )}
                                    onClick={() => onInspect(entry.row.id)}
                                  >
                                    <span
                                      className={cn(
                                        "size-1.5 shrink-0 rounded-full",
                                        tone.solid,
                                      )}
                                      aria-hidden="true"
                                    />
                                    <span className="line-clamp-2">
                                      {String(
                                        entry.row.values[primary] ?? "Untitled",
                                      )}
                                    </span>
                                  </Button>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
        {unscheduledRows.length ? (
          <Alert role="note">
            {unscheduledRows.length}{" "}
            {unscheduledRows.length === 1 ? "record has" : "records have"} no{" "}
            {module.fields
              .find((field) => field.id === renderDateField)
              ?.label.toLocaleLowerCase() ?? "date"}{" "}
            and cannot appear on the calendar grid.
          </Alert>
        ) : null}
      </div>
    );
  }
  if (layout.kind === "timeline")
    return (
      <GanttView
        module={module}
        rows={rows}
        anchorRows={anchorRows}
        layout={layout}
        dateField={renderDateField}
        onInspect={onInspect}
      />
    );
  const gallery = layout.kind === "gallery";
  const grid = gallery ? "sm:grid-cols-2 xl:grid-cols-3" : "sm:grid-cols-2";
  return (
    <div className={`grid gap-4 ${grid}`}>
      {rows.map((row, rowIndex) => {
        const facts = getOpenViewOperationalFacts(row);
        const statusTone = visualTone(facts.status, rowIndex);
        const priorityTone = visualTone(facts.priority, 1);
        const title = String(row.values[primary] ?? "Untitled");
        const supporting = String(row.values[secondary] ?? "—");
        return (
          <Button
            key={row.id}
            type="button"
            variant="outline"
            className={cn(
              "h-auto justify-start p-0 text-left whitespace-normal",
              layout.cardSize === "compact" ? "min-h-28" : "min-h-36",
            )}
            onClick={() => onInspect(row.id)}
          >
            <span
              className={cn(
                "flex w-full flex-col gap-3",
                layout.cardSize === "compact" ? "p-3" : "p-5",
              )}
            >
              {gallery ? (
                <span
                  className={cn(
                    "bg-muted/40 relative flex h-28 flex-col justify-end gap-2 overflow-hidden rounded-[var(--radius)] border p-3",
                    statusTone.surface,
                  )}
                >
                  <span
                    className={cn(
                      "absolute inset-x-0 top-0 h-1",
                      statusTone.solid,
                    )}
                    aria-hidden="true"
                  />
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-muted-foreground text-[0.6875rem] font-semibold tracking-wide uppercase">
                      {facts.status || "Unspecified"}
                    </span>
                    <span className="text-xs font-medium tabular-nums">
                      {facts.progress === null
                        ? "No progress"
                        : `${facts.progress}% complete`}
                    </span>
                  </span>
                  <span className="bg-background/80 h-2 overflow-hidden rounded-full">
                    <span
                      className={cn(
                        "block h-full rounded-full",
                        statusTone.solid,
                      )}
                      style={{ width: `${facts.progress ?? 0}%` }}
                    />
                  </span>
                  <span className="text-muted-foreground flex items-center justify-between gap-2 text-xs">
                    <span>{facts.owner || "Unassigned"}</span>
                    <span>{displayDate(facts.deadline)}</span>
                  </span>
                </span>
              ) : null}
              <span className="flex items-start justify-between gap-3">
                <span className="leading-snug font-medium">{title}</span>
                {facts.priority ? (
                  <Badge
                    variant="outline"
                    className={cn(
                      "shrink-0 text-[0.6875rem]",
                      priorityTone.surface,
                      priorityTone.border,
                    )}
                  >
                    {facts.priority}
                  </Badge>
                ) : null}
              </span>
              <span className="text-muted-foreground text-sm">
                {supporting}
              </span>
              <span className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                <span>
                  <span className="text-muted-foreground block">Status</span>
                  {facts.status || "Unspecified"}
                </span>
                <span>
                  <span className="text-muted-foreground block">Owner</span>
                  {facts.owner || "Unassigned"}
                </span>
                <span>
                  <span className="text-muted-foreground block">Deadline</span>
                  {displayDate(facts.deadline)}
                </span>
                <span>
                  <span className="text-muted-foreground block">Timing</span>
                  {timingStateLabel(facts.timingState)}
                </span>
              </span>
              {facts.progress !== null && !gallery ? (
                <span>
                  <span className="text-muted-foreground mb-1 block text-xs">
                    Progress
                  </span>
                  {renderProgress(row)}
                </span>
              ) : null}
              {facts.attentionReason ? (
                <span className="text-chart-5 text-xs font-medium">
                  {facts.attentionReason}
                </span>
              ) : null}
            </span>
          </Button>
        );
      })}
    </div>
  );
}

function RecordInspector({
  module,
  rows,
  inspected,
  onClose,
  onNavigate,
}: {
  module: OpenViewModule;
  rows: OpenViewRow[];
  inspected: OpenViewRow;
  onClose: () => void;
  onNavigate: (id: string) => void;
}) {
  const [wide, setWide] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1280px)");
    const update = () => setWide(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const index = rows.findIndex((row) => row.id === inspected.id);
  const previous = index > 0 ? rows[index - 1] : undefined;
  const next =
    index >= 0 && index < rows.length - 1 ? rows[index + 1] : undefined;
  const detail = (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Badge variant="outline">{module.name}</Badge>
          <h2 className="mt-2 text-xl font-semibold break-words">
            {String(inspected.values[module.primaryField] ?? "Untitled")}
          </h2>
          <p className="text-muted-foreground mt-1 text-xs break-all">
            {inspected.id}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11 shrink-0"
          aria-label="Close record detail"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      <dl className="flex flex-col gap-4 text-sm">
        {module.fields.map((field) => (
          <div key={field.id} className="flex flex-col gap-1">
            <dt className="text-muted-foreground text-xs">{field.label}</dt>
            <dd>
              {field.type === "select" ? (
                <Badge variant="secondary">
                  {String(inspected.values[field.id] ?? "Unspecified")}
                </Badge>
              ) : (
                String(inspected.values[field.id] ?? "—")
              )}
            </dd>
          </div>
        ))}
      </dl>
      <div className="flex items-center justify-between gap-2 border-t pt-4">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-11"
          disabled={!previous}
          aria-label="Previous record"
          onClick={() => previous && onNavigate(previous.id)}
        >
          <ArrowLeft aria-hidden="true" />
        </Button>
        <span className="text-muted-foreground text-xs">
          {index + 1} of {rows.length}
        </span>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-11"
          disabled={!next}
          aria-label="Next record"
          onClick={() => next && onNavigate(next.id)}
        >
          <ArrowRight aria-hidden="true" />
        </Button>
      </div>
      <div className="flex flex-col gap-2">
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(
                `${window.location.origin}${serializeOpenViewUrl({ section: "views", module: module.id, record: inspected.id })}`,
              );
              setCopyStatus("Safe link copied.");
            } catch {
              setCopyStatus("Copy is unavailable in this browser.");
            }
          }}
        >
          <Link2 data-icon="inline-start" aria-hidden="true" /> Copy safe link
        </Button>
        {copyStatus ? (
          <p role="status" className="text-muted-foreground text-xs">
            {copyStatus}
          </p>
        ) : null}
      </div>
      <p className="text-muted-foreground text-xs">
        Read-only sample record. OpenView does not edit the source module.
      </p>
    </div>
  );
  return wide ? (
    <Card className="sticky top-5 self-start">
      <CardHeader>
        <CardTitle>Record details</CardTitle>
        <CardDescription>Read-only inspection</CardDescription>
      </CardHeader>
      <CardContent>{detail}</CardContent>
    </Card>
  ) : (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-[min(92vw,26rem)]">
        <SheetHeader>
          <SheetTitle>Record details</SheetTitle>
          <SheetDescription>
            Read-only inspection from {module.name}.
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-1">{detail}</div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

function SaveViewDialog({
  open,
  onOpenChange,
  pending,
  error,
  name,
  onNameChange,
  audience,
  onAudienceChange,
  options,
  description,
  submitLabel,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  error: string;
  name: string;
  onNameChange: (value: string) => void;
  audience: string;
  onAudienceChange: (value: string) => void;
  options: { value: string; label: string }[];
  description: string;
  submitLabel: string;
  onSubmit: () => void | Promise<void>;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && pending) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save view</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {pending ? (
          <p role="status" className="text-muted-foreground text-sm">
            Saving this view… Keep the dialog open until it finishes.
          </p>
        ) : null}
        {error ? (
          <Alert role="alert" variant="destructive">
            {error}
          </Alert>
        ) : null}
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="openview-view-name">View name</FieldLabel>
            <Input
              id="openview-view-name"
              className="min-h-11"
              maxLength={80}
              value={name}
              disabled={pending}
              onChange={(event) => onNameChange(event.target.value)}
              placeholder="e.g. Dispatch queue"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="openview-view-audience">
              Audience preview
            </FieldLabel>
            <Select
              id="openview-view-audience"
              className="min-h-11"
              value={audience}
              disabled={pending}
              onValueChange={onAudienceChange}
            >
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
            <FieldDescription>
              Preview only. This does not grant access or send invitations.
            </FieldDescription>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            className="min-h-11"
            disabled={pending || !name.trim()}
            onClick={onSubmit}
          >
            {pending ? "Saving…" : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
