"use client";

import Link from "next/link";
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  BarChart3,
  Copy,
  List,
  Pin,
  RefreshCw,
  Settings2,
  Trash2,
  Users,
} from "lucide-react";
import { useEffect, useState } from "react";

import { Alert } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import { initialPeople, initialRoles } from "../access/model";
import { useSampleState } from "../sample-state";
import type { SampleRecord } from "../sample-data";
import { OpenViewChartPreview } from "./chart-preview";
import { OpenViewAudienceConfirmation } from "./audience-confirmation";
import { OpenViewFilterEditor } from "./filter-editor";
import { normalizeFilterGroup } from "./filter-helpers";
import {
  OPENVIEW_MODULE_IDS,
  OPENVIEW_MODULES,
  audienceLabel,
  filterRows,
  getModuleDefinition,
  getOpenViewRows,
  isUnresolvedAudience,
  projectAudienceLookup,
  type AudienceLookup,
  type AudienceRef,
  type FilterGroup,
  type FilterOperator,
  type OpenViewModuleId,
  type OpenViewRow,
  type OpenViewWidget,
} from "./model";
import {
  OPENVIEW_SAMPLE_SNAPSHOT_DATE,
  getOpenViewOperationalFacts,
  summarizeOpenViewOperationalRows,
} from "./operations";

/**
 * Boards predates the typed OpenView model and stores these six fields in its
 * local sample snapshot. Keep that shape exported while this surface works
 * with OpenViewWidget values internally. New widgets include both
 * representations, so a Board and a dashboard can share one widget without
 * breaking Access' legacy federation projection.
 */
export type SampleWidget = {
  id: string;
  type: string;
  size: string;
  permission: string;
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

type WidgetInput = SampleWidget | OpenViewWidget;
type RowsByModule = Partial<Record<OpenViewModuleId, OpenViewRow[]>>;

type WidgetSurfaceBaseProps = {
  /** Legacy service-request rows used by Boards and the first OpenView build. */
  records?: SampleRecord[];
  /** Rows for the currently selected module. */
  rows?: OpenViewRow[];
  /** Module-specific rows for a dashboard containing mixed sources. */
  rowsByModule?: RowsByModule;
  /** Alias accepted by existing dashboard callers. */
  moduleRows?: RowsByModule;
  /** Fallback module when a legacy widget has no source. */
  moduleId?: OpenViewModuleId;
  board?: boolean;
  maxWidgets?: number;
  audienceLookup?: AudienceLookup;
  error?: string | null;
  widgetErrors?: Partial<Record<string, string>>;
  lastRecomputedAt?: Partial<Record<string, string>>;
  /** Alias for callers that already use the model's recompute terminology. */
  recomputedAt?: Partial<Record<string, string>>;
  onDuplicate?: (widget: OpenViewWidget) => void;
  onRemove?: (widget: OpenViewWidget) => void;
  onRecompute?: (widget: OpenViewWidget, timestamp: string) => void;
};

type WidgetSurfaceEditProps<T extends WidgetInput> = WidgetSurfaceBaseProps & {
  mode?: "edit";
  widgets: T[];
  onChange: (widgets: T[]) => void;
};

type WidgetSurfaceViewProps<T extends WidgetInput> = Omit<
  WidgetSurfaceBaseProps,
  "onDuplicate" | "onRemove"
> & {
  mode: "view";
  widgets: T[];
  onChange?: never;
};

type WidgetSurfaceProps<T extends WidgetInput> =
  WidgetSurfaceEditProps<T> | WidgetSurfaceViewProps<T>;

/**
 * `newWidget` returns an intersection: canonical OpenView fields power new
 * dashboards, while legacy aliases keep Board snapshots and Access
 * projections source-compatible.
 */
export function newWidget(type: string): OpenViewWidget & SampleWidget {
  const normalizedType = normalizeWidgetType(type);
  const moduleDefinition = getModuleDefinition("service-requests");
  return {
    id: createWidgetId(),
    name: defaultWidgetName(normalizedType),
    type: normalizedType,
    moduleId: "service-requests",
    size: "half",
    audience: { kind: "everyone" },
    refresh: "manual",
    pinned: false,
    fields: moduleDefinition.fields.slice(0, 3).map((field) => field.id),
    filters: { logic: "and", clauses: [] },
    metric: "count",
    visualization: "bar",
    permission: "Everyone",
  };
}

export function WidgetSurface<T extends WidgetInput>(
  props: WidgetSurfaceProps<T>,
) {
  const {
    widgets,
    records = [],
    rows,
    rowsByModule,
    moduleRows,
    moduleId,
    board = false,
    maxWidgets,
    audienceLookup: suppliedAudienceLookup,
    error,
    widgetErrors,
    lastRecomputedAt,
    recomputedAt: suppliedRecomputedAt,
    onRecompute,
  } = props;
  const mode = props.mode ?? "edit";
  const onChange = props.mode === "view" ? undefined : props.onChange;
  const onDuplicate = props.mode === "view" ? undefined : props.onDuplicate;
  const onRemove = props.mode === "view" ? undefined : props.onRemove;
  const [roles] = useSampleState("access-roles", initialRoles);
  const [people] = useSampleState("access-people", initialPeople);
  const [openSettings, setOpenSettings] = useState<Record<string, boolean>>({});
  const [recomputedAt, setRecomputedAt] = useState<Record<string, string>>({});
  const [pendingRemoval, setPendingRemoval] = useState<OpenViewWidget | null>(
    null,
  );
  const audienceLookup: AudienceLookup =
    suppliedAudienceLookup ?? projectAudienceLookup(roles, people);
  const widgetLimit =
    maxWidgets === undefined ? undefined : Math.max(0, Math.floor(maxWidgets));
  const canDuplicate =
    widgetLimit === undefined || widgets.length < widgetLimit;

  useEffect(() => {
    if (mode === "view") {
      setOpenSettings({});
      setPendingRemoval(null);
    }
  }, [mode]);

  const commit = (next: WidgetInput[]) => {
    if (mode !== "edit" || !onChange) return;
    // `writeWidget` preserves the concrete collection shape. The generic
    // public API ensures callers receive the same shape they passed in.
    onChange(orderBoardSources(next) as T[]);
  };

  const widgetEntries = widgets.map((source, sourceIndex) => ({
    source,
    sourceIndex,
    widget: normalizeWidget(source, moduleId, audienceLookup),
  }));
  const orderedEntries = board
    ? [...widgetEntries].sort(
        (left, right) =>
          Number(right.widget.pinned) - Number(left.widget.pinned) ||
          left.sourceIndex - right.sourceIndex,
      )
    : widgetEntries;

  function orderBoardSources(sources: WidgetInput[]): WidgetInput[] {
    if (!board) return sources;
    return sources
      .map((source, sourceIndex) => ({
        source,
        sourceIndex,
        widget: normalizeWidget(source, moduleId, audienceLookup),
      }))
      .sort(
        (left, right) =>
          Number(right.widget.pinned) - Number(left.widget.pinned) ||
          left.sourceIndex - right.sourceIndex,
      )
      .map(({ source }) => source);
  }

  function updateWidget(id: string, patch: Partial<OpenViewWidget>) {
    if (mode !== "edit" || !onChange) return;
    const next = widgets.map((source) => {
      if (source.id !== id) return source;
      const current = normalizeWidget(source, moduleId, audienceLookup);
      const changed = patch.moduleId
        ? prepareModuleChange({ ...current, ...patch }, patch.moduleId)
        : { ...current, ...patch };
      return writeWidget(source, changed, audienceLookup);
    });
    commit(next);
  }

  function moveWidget(id: string, direction: -1 | 1) {
    if (mode !== "edit" || !onChange) return;
    const index = orderedEntries.findIndex((entry) => entry.widget.id === id);
    const current = orderedEntries[index];
    const target = index + direction;
    const targetEntry = orderedEntries[target];
    if (!current || !targetEntry) return;
    if (board && targetEntry.widget.pinned !== current.widget.pinned) return;
    const next = [...orderedEntries];
    [next[index], next[target]] = [next[target], next[index]];
    commit(next.map(({ source }) => source));
  }

  function duplicateWidget(widget: OpenViewWidget) {
    if (mode !== "edit" || !onChange || !canDuplicate) return;
    const copy: OpenViewWidget = {
      ...widget,
      id: createWidgetId(),
      name: `${widget.name} copy`.slice(0, 80),
    };
    onDuplicate?.(copy);
    if (!onDuplicate) {
      const source = widgets.find((candidate) => candidate.id === widget.id);
      if (source)
        commit([...widgets, writeWidget(source, copy, audienceLookup)]);
    }
  }

  function confirmRemove() {
    if (mode !== "edit" || !onChange || !pendingRemoval) {
      setPendingRemoval(null);
      return;
    }
    const target = pendingRemoval;
    onRemove?.(target);
    if (!onRemove) commit(widgets.filter((widget) => widget.id !== target.id));
    setPendingRemoval(null);
  }

  function recomputeWidget(widget: OpenViewWidget) {
    const timestamp = new Date().toISOString();
    setRecomputedAt((current) => ({ ...current, [widget.id]: timestamp }));
    onRecompute?.(widget, timestamp);
  }

  function requestRemove(widget: OpenViewWidget) {
    if (mode !== "edit" || !onChange) return;
    setPendingRemoval(widget);
  }

  function setSettingsOpen(widgetId: string, open: boolean) {
    if (mode !== "edit") return;
    setOpenSettings((current) => ({ ...current, [widgetId]: open }));
  }

  return (
    <div className="grid min-w-0 gap-5 lg:grid-cols-2">
      {error ? (
        <Alert variant="destructive" className="lg:col-span-2">
          <p className="font-medium">Widgets could not be loaded</p>
          <p className="mt-1">{error}</p>
        </Alert>
      ) : null}
      {orderedEntries.map(({ widget }, index) => (
        <WidgetCard
          key={widget.id}
          widget={widget}
          rows={resolveRows(widget.moduleId, {
            records,
            rows,
            rowsByModule: rowsByModule ?? moduleRows,
          })}
          board={board}
          mode={mode}
          roles={roles}
          people={audienceLookup.identities ?? []}
          audienceLookup={audienceLookup}
          error={widgetErrors?.[widget.id]}
          settingsOpen={mode === "edit" && openSettings[widget.id] === true}
          onSettingsOpenChange={(open) => setSettingsOpen(widget.id, open)}
          recomputedAt={
            recomputedAt[widget.id] ??
            lastRecomputedAt?.[widget.id] ??
            suppliedRecomputedAt?.[widget.id] ??
            null
          }
          onChange={
            mode === "edit"
              ? (patch) => updateWidget(widget.id, patch)
              : undefined
          }
          onDuplicate={
            mode === "edit" ? () => duplicateWidget(widget) : undefined
          }
          onRemove={mode === "edit" ? () => requestRemove(widget) : undefined}
          onMoveUp={
            mode === "edit" ? () => moveWidget(widget.id, -1) : undefined
          }
          onMoveDown={
            mode === "edit" ? () => moveWidget(widget.id, 1) : undefined
          }
          onRecompute={() => recomputeWidget(widget)}
          canDuplicate={mode === "edit" && canDuplicate}
          canMoveUp={
            mode === "edit" &&
            index > 0 &&
            (!board ||
              orderedEntries[index - 1]?.widget.pinned === widget.pinned)
          }
          canMoveDown={
            mode === "edit" &&
            index < orderedEntries.length - 1 &&
            (!board ||
              orderedEntries[index + 1]?.widget.pinned === widget.pinned)
          }
        />
      ))}
      {!error && widgets.length === 0 ? (
        <Empty className="min-h-56 lg:col-span-2">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BarChart3 aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No widgets yet</EmptyTitle>
            <EmptyDescription>
              Add a summary, workload, records, or chart widget to this
              {board ? " board." : " dashboard."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {mode === "edit" ? (
        <AlertDialog
          open={pendingRemoval !== null}
          onOpenChange={(open) => {
            if (!open) setPendingRemoval(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove this widget?</AlertDialogTitle>
              <AlertDialogDescription>
                “{pendingRemoval?.name}” will be removed from this{" "}
                {board ? "board" : "dashboard"}. This only changes the sample
                workspace in this tab.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="min-h-11">
                Keep widget
              </AlertDialogCancel>
              <Button
                variant="destructive"
                className="min-h-11"
                onClick={confirmRemove}
              >
                Remove widget
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </div>
  );
}

type WidgetCardProps = {
  widget: OpenViewWidget;
  rows: OpenViewRow[];
  board: boolean;
  mode: "view" | "edit";
  roles: { id: string; name: string }[];
  people: { id: string; name: string }[];
  audienceLookup: AudienceLookup;
  error?: string;
  settingsOpen: boolean;
  onSettingsOpenChange?: (open: boolean) => void;
  recomputedAt: string | null;
  onChange?: (patch: Partial<OpenViewWidget>) => void;
  onDuplicate?: () => void;
  onRemove?: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onRecompute: () => void;
  canDuplicate: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
};

function WidgetCard({
  widget,
  rows,
  board,
  mode,
  roles,
  people,
  audienceLookup,
  error,
  settingsOpen,
  onSettingsOpenChange,
  recomputedAt,
  onChange,
  onDuplicate,
  onRemove,
  onMoveUp,
  onMoveDown,
  onRecompute,
  canDuplicate,
  canMoveUp,
  canMoveDown,
}: WidgetCardProps) {
  const moduleDefinition = getModuleDefinition(widget.moduleId);
  const filteredRows = filterRows(rows, widget.filters);
  const titleId = `widget-title-${widget.id}`;
  const reading = board && mode === "view";
  const title =
    reading &&
    widget.type === "workload" &&
    widget.metric === "count" &&
    ["Team workload", "Workload"].includes(widget.name)
      ? `${widget.moduleId === "service-requests" ? "Requests" : "Records"} by ${chooseWorkloadDimension(widget, filteredRows).label.toLocaleLowerCase()}`
      : widget.name;
  const typeLabel = widgetTypeLabel(widget.type);
  const typeIndex =
    widget.type === "summary"
      ? 0
      : widget.type === "workload"
        ? 1
        : widget.type === "records"
          ? 2
          : 3;
  const tone = widgetTone(typeIndex);
  const TypeIcon =
    widget.type === "workload"
      ? Users
      : widget.type === "records"
        ? List
        : BarChart3;

  return (
    <Card
      className={cn(
        "relative min-w-0 overflow-hidden",
        widget.size === "full" ? "lg:col-span-2" : undefined,
      )}
      aria-labelledby={titleId}
    >
      {!reading && <div className={cn("h-1", tone.solid)} aria-hidden="true" />}
      <CardHeader className="bg-muted/25 flex flex-row flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          {!reading && (
            <span
              className={cn(
                "flex size-10 shrink-0 items-center justify-center rounded-[var(--radius)] border",
                tone.surface,
                tone.border,
              )}
            >
              <TypeIcon className="size-5" aria-hidden="true" />
            </span>
          )}
          <div className="min-w-0 space-y-2">
            <CardTitle id={titleId} className="flex items-center gap-2">
              {widget.pinned && !reading ? (
                <Pin aria-label="Pinned" className="size-4 shrink-0" />
              ) : null}
              <span className="break-words">{title}</span>
            </CardTitle>
            <CardDescription className="flex flex-wrap items-center gap-2">
              {reading ? (
                moduleDefinition.name
              ) : (
                <>
                  <Badge variant="secondary">{moduleDefinition.name}</Badge>
                  <Badge variant="outline">{typeLabel}</Badge>
                </>
              )}
            </CardDescription>
          </div>
        </div>
        {mode === "edit" ? (
          <div className="bg-card flex flex-wrap items-center justify-end gap-1 rounded-[var(--radius)] p-1">
            {board ? (
              <Button
                variant={widget.pinned ? "secondary" : "ghost"}
                size="icon"
                className="min-h-11 min-w-11"
                aria-label={`${widget.pinned ? "Unpin" : "Pin"} ${widget.name}`}
                aria-pressed={widget.pinned}
                onClick={() => onChange?.({ pinned: !widget.pinned })}
              >
                <Pin aria-hidden="true" />
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              className="min-h-11 min-w-11"
              aria-label={`Move ${widget.name} up`}
              disabled={!canMoveUp}
              onClick={onMoveUp}
            >
              <ArrowUp aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="min-h-11 min-w-11"
              aria-label={`Move ${widget.name} down`}
              disabled={!canMoveDown}
              onClick={onMoveDown}
            >
              <ArrowDown aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="min-h-11 min-w-11"
              aria-label={`Duplicate ${widget.name}`}
              disabled={!canDuplicate}
              onClick={onDuplicate}
            >
              <Copy aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="text-destructive hover:text-destructive min-h-11 min-w-11"
              aria-label={`Remove ${widget.name}`}
              onClick={onRemove}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="bg-muted/10 min-w-0 py-5">
        {error ? (
          <Alert variant="destructive">
            <p className="font-medium">This widget could not be rendered</p>
            <p className="mt-1">{error}</p>
          </Alert>
        ) : (
          <WidgetPreview
            widget={widget}
            rows={filteredRows}
            totalRows={rows.length}
            moduleName={moduleDefinition.name}
            board={board}
          />
        )}
      </CardContent>
      {!reading && (
        <CardFooter className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">
              {filteredRows.length}{" "}
              {filteredRows.length === 1 ? "record" : "records"}
            </Badge>
            <Badge
              variant={
                isUnresolvedAudience(widget.audience) ? "warning" : "secondary"
              }
            >
              {audienceLabel(widget.audience, audienceLookup)}
            </Badge>
            <Badge variant="outline">
              {widget.refresh === "manual"
                ? "Manual refresh"
                : `${refreshLabel(widget.refresh)}${board ? "" : " preview"}`}
            </Badge>
          </div>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={onRecompute}
            title="Refresh this widget"
          >
            <RefreshCw aria-hidden="true" />
            {board ? "Refresh" : "Recompute now"}
          </Button>
          {(!board || recomputedAt) && (
            <p className="text-muted-foreground basis-full text-xs">
              {recomputedAt ? (
                <>
                  {board ? "Last refreshed" : "Last manually recomputed"}{" "}
                  <time dateTime={recomputedAt}>
                    {formatTimestamp(recomputedAt)}
                  </time>
                  .
                </>
              ) : (
                "Refresh cadence is a preview; nothing runs in the background."
              )}
            </p>
          )}
        </CardFooter>
      )}
      {mode === "edit" ? (
        <Collapsible
          className="border-border border-t"
          open={settingsOpen}
          onOpenChange={onSettingsOpenChange}
        >
          <CollapsibleTrigger
            aria-label={`${settingsOpen ? "Hide" : "Show"} ${widget.name} settings`}
            render={
              <Button
                variant="ghost"
                className="min-h-11 w-full justify-between rounded-none px-5"
              />
            }
          >
            <span>Widget settings</span>
            <Settings2 aria-hidden="true" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="border-border border-t">
              {onChange ? (
                <WidgetSettings
                  board={board}
                  widget={widget}
                  roles={roles}
                  people={people}
                  onChange={onChange}
                />
              ) : null}
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </Card>
  );
}

function WidgetSettings({
  board,
  widget,
  roles,
  people,
  onChange,
}: {
  board: boolean;
  widget: OpenViewWidget;
  roles: { id: string; name: string }[];
  people: { id: string; name: string }[];
  onChange: (patch: Partial<OpenViewWidget>) => void;
}) {
  const moduleDefinition = getModuleDefinition(widget.moduleId);
  const audienceValue = audienceKey(widget.audience);
  const [pendingAudience, setPendingAudience] = useState<AudienceRef | null>(
    null,
  );
  const selectedFields = new Set(widget.fields);
  const metricFields = moduleDefinition.fields.filter(
    (field) => field.type === "number",
  );

  function changeModule(nextModuleId: OpenViewModuleId) {
    const nextModule = getModuleDefinition(nextModuleId);
    onChange({
      moduleId: nextModuleId,
      fields: nextModule.fields.slice(0, 3).map((field) => field.id),
      filters: { logic: widget.filters.logic, clauses: [] },
      metric: "count",
    });
  }

  function toggleField(fieldId: string, checked: boolean) {
    const nextFields = checked
      ? [...widget.fields, fieldId]
      : widget.fields.filter((field) => field !== fieldId);
    onChange({ fields: nextFields.length ? nextFields : [fieldId] });
  }

  function changeAudience(value: string) {
    const nextAudience = audienceFromKey(value, roles, people);
    if (
      nextAudience.kind === "everyone" &&
      widget.audience.kind !== "everyone"
    ) {
      setPendingAudience(nextAudience);
      return;
    }
    onChange({ audience: nextAudience });
  }

  return (
    <>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`widget-name-${widget.id}`}>
            Widget name
          </FieldLabel>
          <Input
            id={`widget-name-${widget.id}`}
            className="min-h-11"
            maxLength={80}
            value={widget.name}
            onChange={(event) =>
              onChange({ name: event.target.value.slice(0, 80) })
            }
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`widget-source-${widget.id}`}>
              Source module
            </FieldLabel>
            <NativeSelect
              id={`widget-source-${widget.id}`}
              className="w-full [&_select]:min-h-11"
              value={widget.moduleId}
              onChange={(event) =>
                changeModule(event.target.value as OpenViewModuleId)
              }
            >
              {OPENVIEW_MODULES.map((candidate) => (
                <NativeSelectOption key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <FieldDescription>{moduleDefinition.description}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`widget-size-${widget.id}`}>Width</FieldLabel>
            <NativeSelect
              id={`widget-size-${widget.id}`}
              className="w-full [&_select]:min-h-11"
              value={widget.size}
              onChange={(event) =>
                onChange({ size: event.target.value as OpenViewWidget["size"] })
              }
            >
              <NativeSelectOption value="half">Half width</NativeSelectOption>
              <NativeSelectOption value="full">Full width</NativeSelectOption>
            </NativeSelect>
          </Field>
        </div>

        <FieldSet>
          <FieldLegend>Displayed fields</FieldLegend>
          <Field className="gap-1">
            <FieldDescription>
              Choose the fields this widget should summarize or show.
            </FieldDescription>
          </Field>
          <FieldGroup className="gap-2">
            {moduleDefinition.fields.map((field) => (
              <Field
                key={field.id}
                className="min-h-11 flex-row items-center gap-3"
              >
                <Checkbox
                  id={`widget-field-${widget.id}-${field.id}`}
                  checked={selectedFields.has(field.id)}
                  onCheckedChange={(checked) =>
                    toggleField(field.id, checked === true)
                  }
                />
                <FieldLabel
                  htmlFor={`widget-field-${widget.id}-${field.id}`}
                  className="flex min-h-11 flex-1 cursor-pointer items-center text-sm"
                >
                  <span>{field.label}</span>
                </FieldLabel>
              </Field>
            ))}
          </FieldGroup>
        </FieldSet>

        <div
          className={
            widget.type === "chart" ? "grid gap-4 sm:grid-cols-2" : undefined
          }
        >
          <Field>
            <FieldLabel htmlFor={`widget-metric-${widget.id}`}>
              Metric
            </FieldLabel>
            <NativeSelect
              id={`widget-metric-${widget.id}`}
              className="w-full [&_select]:min-h-11"
              value={widget.metric}
              onChange={(event) => onChange({ metric: event.target.value })}
            >
              <NativeSelectOption value="count">
                Count records
              </NativeSelectOption>
              {metricFields.map((field) => (
                <NativeSelectOption key={field.id} value={field.id}>
                  {field.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          {widget.type === "chart" ? (
            <Field>
              <FieldLabel htmlFor={`widget-visualization-${widget.id}`}>
                Visualization
              </FieldLabel>
              <NativeSelect
                id={`widget-visualization-${widget.id}`}
                className="w-full [&_select]:min-h-11"
                value={widget.visualization}
                onChange={(event) =>
                  onChange({
                    visualization: event.target
                      .value as OpenViewWidget["visualization"],
                  })
                }
              >
                <NativeSelectOption value="bar">Bar</NativeSelectOption>
                <NativeSelectOption value="line">Line</NativeSelectOption>
                <NativeSelectOption value="pie">Pie</NativeSelectOption>
              </NativeSelect>
            </Field>
          ) : null}
        </div>

        <OpenViewFilterEditor
          module={moduleDefinition}
          filters={widget.filters}
          onChange={(filters) => onChange({ filters })}
          idPrefix={`widget-${widget.id}-${widget.moduleId}`}
          title="Widget filters"
          description={`Only matching ${moduleDefinition.name.toLocaleLowerCase()} rows are included.`}
          logicControl="select"
          logicLabel="Match filters"
          logicOptions={{
            and: "All conditions (AND)",
            or: "Any condition (OR)",
          }}
          showEmptyState={false}
          showLimitLabel={false}
          operatorLabel={widgetOperatorLabel}
          removeVariant="ghost"
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`widget-audience-${widget.id}`}>
              Audience preview
            </FieldLabel>
            <NativeSelect
              id={`widget-audience-${widget.id}`}
              className="w-full [&_select]:min-h-11"
              value={audienceValue}
              onChange={(event) => changeAudience(event.target.value)}
            >
              <NativeSelectOption value="private">Only me</NativeSelectOption>
              <NativeSelectOption value="everyone">Everyone</NativeSelectOption>
              {roles.map((role) => (
                <NativeSelectOption
                  key={`role-${role.id}`}
                  value={`role:${role.id}`}
                >
                  Role: {role.name}
                </NativeSelectOption>
              ))}
              {people.map((person) => (
                <NativeSelectOption
                  key={`identity-${person.id}`}
                  value={`identity:${person.id}`}
                >
                  Person: {person.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <FieldDescription>
              Preview only. It does not change production permissions.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`widget-refresh-${widget.id}`}>
              Refresh preview
            </FieldLabel>
            <NativeSelect
              id={`widget-refresh-${widget.id}`}
              className="w-full [&_select]:min-h-11"
              value={widget.refresh}
              onChange={(event) =>
                onChange({
                  refresh: event.target.value as OpenViewWidget["refresh"],
                })
              }
            >
              <NativeSelectOption value="manual">Manual</NativeSelectOption>
              <NativeSelectOption value="one-minute">
                Every minute
              </NativeSelectOption>
              <NativeSelectOption value="five-minutes">
                Every 5 minutes
              </NativeSelectOption>
            </NativeSelect>
            <FieldDescription>
              {board
                ? "Runs while this board is open in the active tab, after you save."
                : "No background refresh is scheduled."}
            </FieldDescription>
          </Field>
        </div>

        <Alert variant="warning">
          {board
            ? "Audience narrows visibility within this board. Only people who can access the board can view its widgets."
            : "Audience and refresh are sample configuration previews. They never send invitations, schedule jobs, or grant access."}
        </Alert>
      </FieldGroup>
      <OpenViewAudienceConfirmation
        open={pendingAudience !== null}
        artifact="widget"
        cancelLabel="Keep current audience"
        onCancel={() => setPendingAudience(null)}
        onConfirm={() => {
          if (pendingAudience) onChange({ audience: pendingAudience });
          setPendingAudience(null);
        }}
      />
    </>
  );
}

const widgetVisualTones = [
  {
    surface: "bg-chart-1/12",
    solid: "bg-chart-1",
    border: "border-chart-1/35",
  },
  {
    surface: "bg-chart-2/12",
    solid: "bg-chart-2",
    border: "border-chart-2/35",
  },
  {
    surface: "bg-chart-3/12",
    solid: "bg-chart-3",
    border: "border-chart-3/35",
  },
  {
    surface: "bg-chart-4/12",
    solid: "bg-chart-4",
    border: "border-chart-4/35",
  },
  {
    surface: "bg-chart-5/12",
    solid: "bg-chart-5",
    border: "border-chart-5/35",
  },
] as const;

function widgetTone(index: number) {
  return (
    widgetVisualTones[index % widgetVisualTones.length] ?? widgetVisualTones[0]
  );
}

function WidgetPreview({
  widget,
  rows,
  totalRows,
  moduleName,
  board,
}: {
  widget: OpenViewWidget;
  rows: OpenViewRow[];
  totalRows: number;
  moduleName: string;
  board: boolean;
}) {
  if (!rows.length) {
    return (
      <Empty className="min-h-44 border-0 p-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <List aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>
            {totalRows > 0 ? "No matching records" : "No records yet"}
          </EmptyTitle>
          <EmptyDescription>
            {totalRows > 0
              ? "Clear a filter to see matching rows in this widget."
              : `Add sample ${moduleName.toLocaleLowerCase()} data to see this widget.`}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (widget.type === "workload") {
    return <WorkloadPreview widget={widget} rows={rows} />;
  }
  if (widget.type === "records") {
    return <RecordsPreview board={board} widget={widget} rows={rows} />;
  }
  if (widget.type === "chart") {
    return <ChartPreview widget={widget} rows={rows} />;
  }
  return <SummaryPreview widget={widget} rows={rows} />;
}

function SummaryPreview({
  widget,
  rows,
}: {
  widget: OpenViewWidget;
  rows: OpenViewRow[];
}) {
  const moduleDefinition = getModuleDefinition(widget.moduleId);
  const summary = summarizeOpenViewOperationalRows(rows, widget.moduleId);
  const dimension =
    moduleDefinition.fields.find((field) => field.id === "status") ??
    chooseDimension(widget);
  const groups = summarizeRows(rows, dimension, widget.metric);
  const noun = widget.moduleId === "service-requests" ? "request" : "record";
  const causes = [
    { label: "Blocked", state: "blocked" },
    { label: "Overdue", state: "overdue" },
    { label: "Planned after deadline", state: "late-plan" },
    { label: "Due soon", state: "due-soon" },
    { label: "Missing dates", state: "unscheduled" },
  ]
    .map((cause) => ({
      ...cause,
      count: summary.attention.filter(
        (item) => item.timingState === cause.state,
      ).length,
    }))
    .filter((cause) => cause.count > 0);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <p className="text-lg leading-snug font-semibold">
          {summary.needsAttention
            ? `${summary.needsAttention} of ${summary.total} ${noun}${summary.total === 1 ? " needs" : "s need"} attention.`
            : `All ${summary.total} ${noun}${summary.total === 1 ? " is" : "s are"} on track or complete.`}
        </p>
        <p className="text-muted-foreground text-sm">
          {summary.highPriority} high priority · Dates assessed as of{" "}
          {formatOperationalDate(summary.snapshotDate)}
        </p>
      </div>
      {!!causes.length && (
        <dl
          className="grid grid-cols-2 gap-x-5 gap-y-3"
          aria-label="Reasons for attention"
        >
          {causes.map((cause) => (
            <div
              key={cause.label}
              className="flex items-baseline justify-between gap-3"
            >
              <dt className="text-sm">{cause.label}</dt>
              <dd className="text-lg font-semibold tabular-nums">
                {cause.count}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {!!summary.attention.length && (
        <Collapsible className="flex flex-col gap-3">
          <CollapsibleTrigger
            render={
              <Button
                variant="outline"
                className="min-h-11 w-full justify-between"
              />
            }
          >
            See {summary.attention.length} {noun}
            {summary.attention.length === 1 ? "" : "s"} needing attention
            <ChevronDown data-icon="inline-end" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul
              className="divide-border max-h-80 divide-y overflow-y-auto"
              aria-label="Items needing attention"
            >
              {summary.attention.map((item) => (
                <li
                  key={item.rowId}
                  className="flex flex-col gap-2 py-3 first:pt-0"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="min-w-0 flex-1 font-medium break-words">
                      {item.label}
                    </p>
                    <Badge variant={operationalTimingVariant(item.timingState)}>
                      {operationalTimingLabel(item.timingState)}
                    </Badge>
                  </div>
                  {item.attentionReason && (
                    <p className="text-sm">{item.attentionReason}</p>
                  )}
                  <p className="text-muted-foreground text-sm">
                    {item.owner || "Unassigned"} ·{" "}
                    {item.deadline
                      ? `Due ${formatOperationalDate(item.deadline)}`
                      : "No deadline"}
                  </p>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
      <div className="flex flex-col gap-3 border-t pt-4">
        <p className="text-sm font-medium">
          By {dimension.label.toLocaleLowerCase()}
          {widget.metric !== "count"
            ? ` · total ${moduleDefinition.fields.find((field) => field.id === widget.metric)?.label ?? widget.metric}`
            : ""}
        </p>
        <ul
          className="grid gap-x-5 gap-y-2 sm:grid-cols-2"
          aria-label="Status distribution"
        >
          {groups.slice(0, 6).map((group, index) => (
            <li
              key={group.label}
              className="flex items-center justify-between gap-3 text-sm"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    widgetTone(index).solid,
                  )}
                  aria-hidden="true"
                />
                <span className="break-words">{group.label}</span>
              </span>
              <span className="font-semibold tabular-nums">
                {group.value.toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
        {groups.length > 6 && (
          <p className="text-muted-foreground text-sm">
            Showing 6 of {groups.length} groups.
          </p>
        )}
      </div>
    </div>
  );
}

function WorkloadPreview({
  widget,
  rows,
}: {
  widget: OpenViewWidget;
  rows: OpenViewRow[];
}) {
  const moduleDefinition = getModuleDefinition(widget.moduleId);
  const dimension = chooseWorkloadDimension(widget, rows);
  const groups = summarizeRows(rows, dimension, widget.metric);
  const counts = summarizeRows(rows, dimension, "count");
  const leaders = counts.filter((group) => group.value === counts[0]?.value);
  const highest = counts[0]?.value ?? 0;
  const total = groups.reduce((sum, group) => sum + group.value, 0);
  const max = Math.max(...groups.map((group) => group.value), 1);
  const noun = widget.moduleId === "service-requests" ? "request" : "record";
  const metricLabel =
    moduleDefinition.fields.find((field) => field.id === widget.metric)
      ?.label ?? widget.metric;
  const leaderNames =
    leaders.length <= 3
      ? new Intl.ListFormat("en", {
          style: "long",
          type: "conjunction",
        }).format(leaders.map((group) => group.label))
      : `${leaders.length} groups`;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <p className="text-lg leading-snug font-semibold">
          {rows.length} {noun}
          {rows.length === 1 ? "" : "s"} by{" "}
          {dimension.label.toLocaleLowerCase()}
        </p>
        {widget.metric === "count" && (
          <p className="text-muted-foreground text-sm">
            {leaders.length > 1
              ? `${leaderNames} ${leaders.length > 3 ? "tie for the most, with" : "each have"} ${highest} ${noun}${highest === 1 ? "" : "s"}${leaders.length > 3 ? " each" : ""}.`
              : `${leaderNames} has the most: ${highest} ${noun}${highest === 1 ? "" : "s"}.`}
          </p>
        )}
        {widget.metric !== "count" && (
          <p className="text-muted-foreground text-sm">
            Bars show total {metricLabel.toLocaleLowerCase()}, relative to the
            largest total.
          </p>
        )}
      </div>
      <ul
        className="flex flex-col gap-4"
        aria-label={`${widget.metric === "count" ? "Record count" : metricLabel} by ${dimension.label}`}
      >
        {groups.slice(0, 8).map((group) => (
          <li key={group.label} className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 break-words">{group.label}</span>
              <span className="shrink-0 font-semibold tabular-nums">
                {group.value.toLocaleString()}
                {widget.metric === "count" && (
                  <span className="text-muted-foreground ml-2 font-normal">
                    of {rows.length}
                  </span>
                )}
              </span>
            </div>
            <div
              className="bg-muted h-2 overflow-hidden rounded-full"
              aria-hidden="true"
            >
              <div
                className="bg-chart-1 h-full rounded-full"
                style={{
                  width: `${(group.value / (widget.metric === "count" ? Math.max(total, 1) : max)) * 100}%`,
                }}
              />
            </div>
          </li>
        ))}
      </ul>
      {groups.length > 8 && (
        <p className="text-muted-foreground text-sm">
          Showing the largest 8 of {groups.length} groups. Totals include every
          group.
        </p>
      )}
    </div>
  );
}

function RecordsPreview({
  board,
  widget,
  rows,
}: {
  board: boolean;
  widget: OpenViewWidget;
  rows: OpenViewRow[];
}) {
  const moduleDefinition = getModuleDefinition(widget.moduleId);
  const primaryField = moduleDefinition.primaryField;
  const secondaryField =
    widget.fields.find((field) => field !== primaryField) ??
    moduleDefinition.fields[1]?.id;
  const statusField = moduleDefinition.fields.find(
    (field) => field.id === "status",
  );
  return (
    <ul
      className="divide-border divide-y"
      aria-label={`${moduleDefinition.name} records`}
    >
      {rows.slice(0, 5).map((row, index) => {
        const tone = widgetTone(index);
        const facts = getOpenViewOperationalFacts(row);
        const status = statusField
          ? formatValue(row.values[statusField.id])
          : "";
        const timingLabel = operationalTimingLabel(facts.timingState);
        const timingVariant = operationalTimingVariant(facts.timingState);
        return (
          <li key={row.id}>
            <Link
              href={`/openview?module=${encodeURIComponent(widget.moduleId)}&record=${encodeURIComponent(row.id)}`}
              className="focus-visible:ring-ring hover:bg-muted/55 flex min-h-16 items-center justify-between gap-3 rounded-[var(--radius)] px-2 py-3 outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
            >
              <span
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-[var(--radius)] text-xs font-semibold tabular-nums",
                  tone.surface,
                )}
                aria-hidden="true"
              >
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {formatValue(row.values[primaryField]) || row.id}
                </span>
                {secondaryField ? (
                  <span className="text-muted-foreground mt-1 block truncate text-xs">
                    {formatValue(row.values[secondaryField])}
                  </span>
                ) : null}
                {status ? (
                  <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                    <span
                      className={cn("size-1.5 rounded-full", tone.solid)}
                      aria-hidden="true"
                    />
                    <span>{status}</span>
                    {facts.priority ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{facts.priority} priority</span>
                      </>
                    ) : null}
                  </span>
                ) : null}
                <span className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <span>{facts.owner || "Unassigned"}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {facts.deadline
                      ? `Due ${formatOperationalDate(facts.deadline)}`
                      : "No deadline"}
                  </span>
                  <Badge variant={timingVariant}>{timingLabel}</Badge>
                </span>
                {facts.progress !== null ? (
                  <span className="mt-2 flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground shrink-0">
                      Progress
                    </span>
                    <RecordProgress board={board} value={facts.progress} />
                    <span className="font-medium tabular-nums">
                      {facts.progress}%
                    </span>
                  </span>
                ) : null}
              </span>
              <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs">
                Open
                <ArrowRight className="size-3.5" aria-hidden="true" />
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function RecordProgress({ board, value }: { board: boolean; value: number }) {
  if (board) {
    return (
      <Progress
        className="h-1.5 min-w-16 flex-1"
        value={value}
        aria-label={`${value}% complete`}
      />
    );
  }
  return (
    <span
      className="bg-muted h-1.5 min-w-16 flex-1 overflow-hidden rounded-full"
      role="progressbar"
      aria-label={`${value}% complete`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
    >
      <span
        className="bg-chart-3 block h-full rounded-full"
        style={{ width: `${value}%` }}
      />
    </span>
  );
}

function ChartPreview({
  widget,
  rows,
}: {
  widget: OpenViewWidget;
  rows: OpenViewRow[];
}) {
  const dimension = chooseDimension(widget);
  const data = summarizeRows(rows, dimension, widget.metric)
    .slice(0, 8)
    .map((group, index) => ({
      ...group,
      key: `group-${index}`,
    }));
  const topGroup = data[0];
  const metricLabel =
    widget.metric === "count"
      ? "record count"
      : (getModuleDefinition(widget.moduleId).fields.find(
          (field) => field.id === widget.metric,
        )?.label ?? "metric");
  return (
    <figure
      className="space-y-4"
      aria-label={`${widget.visualization} chart of ${dimension.label}`}
    >
      <figcaption className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <span className="font-semibold">
            {topGroup
              ? `${topGroup.label} leads this view`
              : `No ${dimension.label.toLocaleLowerCase()} groups`}
          </span>
          <Badge variant="outline" className="bg-muted/40">
            {widget.metric === "count" ? "Count" : "Metric"}
          </Badge>
        </div>
        <p className="text-muted-foreground text-xs">
          Source: {getModuleDefinition(widget.moduleId).name} · grouped by{" "}
          {dimension.label.toLocaleLowerCase()} · {metricLabel} · snapshot{" "}
          {OPENVIEW_SAMPLE_SNAPSHOT_DATE} · synthetic sample preview
        </p>
      </figcaption>
      <OpenViewChartPreview
        data={data}
        type={widget.visualization}
        valueLabel={
          widget.metric === "count"
            ? "Records"
            : (getModuleDefinition(widget.moduleId).fields.find(
                (field) => field.id === widget.metric,
              )?.label ?? "Metric")
        }
        className="border-border/70 bg-muted/15 h-[18rem] w-full rounded-[var(--radius)] border p-3"
        barRadius={6}
        maxBarSize={52}
        pieInnerRadius={60}
        pieOuterRadius={92}
      />
    </figure>
  );
}

function chooseDimension(widget: OpenViewWidget) {
  const moduleDefinition = getModuleDefinition(widget.moduleId);
  const candidate = widget.fields.find((field) =>
    moduleDefinition.fields.some((definition) => definition.id === field),
  );
  const fieldId = candidate ?? moduleDefinition.primaryField;
  return (
    moduleDefinition.fields.find((field) => field.id === fieldId) ??
    moduleDefinition.fields[0]!
  );
}

function chooseWorkloadDimension(widget: OpenViewWidget, rows: OpenViewRow[]) {
  const moduleDefinition = getModuleDefinition(widget.moduleId);
  const preferred = ["assignee", "status", "location", "city"];
  const fieldId =
    preferred.find(
      (candidate) =>
        moduleDefinition.fields.some((field) => field.id === candidate) &&
        rows.some((row) => row.values[candidate] !== undefined),
    ) ?? chooseDimension(widget).id;
  return (
    moduleDefinition.fields.find((field) => field.id === fieldId) ??
    moduleDefinition.fields[0]!
  );
}

function summarizeRows(
  rows: OpenViewRow[],
  dimension: { id: string },
  metric: string,
) {
  const groups = new Map<string, number>();
  for (const row of rows) {
    const label = formatValue(row.values[dimension.id]) || "Unspecified";
    const value = metric === "count" ? 1 : numberValue(row.values[metric]);
    groups.set(label, (groups.get(label) ?? 0) + value);
  }
  return [...groups.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort(
      (left, right) =>
        right.value - left.value || left.label.localeCompare(right.label),
    );
}

function resolveRows(
  moduleId: OpenViewModuleId,
  props: {
    records: SampleRecord[];
    rows?: OpenViewRow[];
    rowsByModule?: RowsByModule;
  },
) {
  const fromMap = props.rowsByModule?.[moduleId];
  if (fromMap) return fromMap;
  if (
    props.rows &&
    (props.rows.length === 0 ||
      props.rows.some((row) => row.moduleId === moduleId))
  ) {
    return props.rows.filter((row) => row.moduleId === moduleId);
  }
  return getOpenViewRows(moduleId, props.records);
}

function normalizeWidgetType(value: string): OpenViewWidget["type"] {
  const normalized = value.toLocaleLowerCase();
  if (normalized === "workload") return "workload";
  if (normalized === "openview" || normalized === "records") return "records";
  if (normalized === "chart") return "chart";
  return "summary";
}

function defaultWidgetName(type: OpenViewWidget["type"]): string {
  if (type === "workload") return "Team workload";
  if (type === "records") return "OpenView records";
  if (type === "chart") return "Operations chart";
  return "Request summary";
}

function widgetTypeLabel(type: OpenViewWidget["type"]): string {
  if (type === "records") return "Records";
  return type[0].toLocaleUpperCase() + type.slice(1);
}

function refreshLabel(refresh: OpenViewWidget["refresh"]): string {
  if (refresh === "one-minute") return "Every minute";
  if (refresh === "five-minutes") return "Every 5 minutes";
  return "Manual";
}

function normalizeRefresh(value: unknown): OpenViewWidget["refresh"] {
  if (value === "one-minute" || value === "Every minute") return "one-minute";
  if (value === "five-minutes" || value === "Every 5 minutes") {
    return "five-minutes";
  }
  return "manual";
}

function isCanonicalWidget(widget: WidgetInput): widget is OpenViewWidget {
  return (
    !("permission" in widget) &&
    "moduleId" in widget &&
    typeof widget.moduleId === "string" &&
    "audience" in widget &&
    widget.audience !== undefined
  );
}

function normalizeWidget(
  source: WidgetInput,
  fallbackModule: OpenViewModuleId | undefined,
  lookup: AudienceLookup,
): OpenViewWidget {
  const moduleId = isModuleId(source.moduleId)
    ? source.moduleId
    : (fallbackModule ?? "service-requests");
  const moduleDefinition = getModuleDefinition(moduleId);
  const allowed = new Set(moduleDefinition.fields.map((field) => field.id));
  const fields = Array.isArray(source.fields)
    ? source.fields.filter((field) => allowed.has(field))
    : [];
  const filters = normalizeFilterGroup(source.filters, moduleDefinition);
  const legacyPermission =
    "permission" in source && typeof source.permission === "string"
      ? source.permission
      : undefined;
  const audience =
    source.audience ??
    audienceFromLegacy(
      legacyPermission,
      lookup.roles ?? [],
      lookup.identities ?? [],
    );
  return {
    id: source.id,
    name:
      typeof source.name === "string" && source.name.trim()
        ? source.name.slice(0, 80)
        : defaultWidgetName(normalizeWidgetType(source.type)),
    type: normalizeWidgetType(source.type),
    moduleId,
    size: source.size === "full" || source.size === "Full" ? "full" : "half",
    audience,
    refresh: normalizeRefresh(source.refresh),
    pinned: source.pinned === true,
    fields: fields.length
      ? fields
      : moduleDefinition.fields.slice(0, 3).map((field) => field.id),
    filters,
    metric:
      typeof source.metric === "string" &&
      (source.metric === "count" || allowed.has(source.metric))
        ? source.metric
        : "count",
    visualization:
      source.visualization === "line" || source.visualization === "pie"
        ? source.visualization
        : "bar",
  };
}

function prepareModuleChange(
  widget: OpenViewWidget,
  moduleId: OpenViewModuleId,
): OpenViewWidget {
  if (widget.moduleId === moduleId) return widget;
  const moduleDefinition = getModuleDefinition(moduleId);
  return {
    ...widget,
    moduleId,
    fields: moduleDefinition.fields.slice(0, 3).map((field) => field.id),
    filters: { logic: widget.filters.logic, clauses: [] },
    metric: "count",
  };
}

function writeWidget(
  source: WidgetInput,
  widget: OpenViewWidget,
  lookup: AudienceLookup,
): WidgetInput {
  if (isCanonicalWidget(source)) {
    const permission =
      "permission" in source && typeof source.permission === "string"
        ? audienceToLegacy(widget.audience, lookup)
        : undefined;
    return permission
      ? ({ ...widget, permission } as OpenViewWidget & SampleWidget)
      : widget;
  }
  return {
    ...source,
    id: widget.id,
    name: widget.name,
    moduleId: widget.moduleId,
    audience: widget.audience,
    fields: [...widget.fields],
    filters: {
      logic: widget.filters.logic,
      clauses: widget.filters.clauses.map((clause) => ({ ...clause })),
    },
    metric: widget.metric,
    visualization: widget.visualization,
    size: widget.size === "full" ? "Full" : "Half",
    permission: audienceToLegacy(widget.audience, lookup),
    refresh: refreshLabel(widget.refresh),
    pinned: widget.pinned,
  };
}

function isModuleId(value: unknown): value is OpenViewModuleId {
  return (
    typeof value === "string" &&
    OPENVIEW_MODULE_IDS.includes(value as OpenViewModuleId)
  );
}

function audienceKey(audience: AudienceRef): string {
  if (audience.kind === "private" || audience.kind === "everyone") {
    return audience.kind;
  }
  return `${audience.kind}:${audience.id}`;
}

function audienceFromKey(
  value: string,
  roles: { id: string; name: string }[],
  people: { id: string; name: string }[],
): AudienceRef {
  if (value === "everyone") return { kind: "everyone" };
  if (
    value.startsWith("role:") &&
    roles.some((role) => role.id === value.slice(5))
  ) {
    return { kind: "role", id: value.slice(5) };
  }
  if (
    value.startsWith("identity:") &&
    people.some((person) => person.id === value.slice(9))
  ) {
    return { kind: "identity", id: value.slice(9) };
  }
  return { kind: "private" };
}

function audienceFromLegacy(
  value: string | undefined,
  roles: { id: string; name: string }[],
  people: { id: string; name: string }[],
): AudienceRef {
  if (value === "Everyone") return { kind: "everyone" };
  if (!value || value === "Only me" || value === "Private") {
    return { kind: "private" };
  }
  const roleName = value.startsWith("Role: ") ? value.slice(6) : value;
  const role = roles.find((candidate) => candidate.name === roleName);
  if (role) return { kind: "role", id: role.id };
  const personName = value.startsWith("User: ") ? value.slice(6) : value;
  const person = people.find((candidate) => candidate.name === personName);
  return person ? { kind: "identity", id: person.id } : { kind: "private" };
}

function audienceToLegacy(
  audience: AudienceRef,
  lookup: AudienceLookup,
): string {
  if (audience.kind === "everyone") return "Everyone";
  if (audience.kind === "role") {
    return `Role: ${lookup.roles?.find((role) => role.id === audience.id)?.name ?? "Unresolved"}`;
  }
  if (audience.kind === "identity") {
    return `User: ${lookup.identities?.find((person) => person.id === audience.id)?.name ?? "Unresolved"}`;
  }
  return "Only me";
}

function widgetOperatorLabel(operator: FilterOperator): string {
  return operator
    .split("-")
    .map((word) => word[0]?.toLocaleUpperCase() + word.slice(1))
    .join(" ");
}

function formatValue(value: OpenViewRow["values"][string] | undefined): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return value === undefined || value === null ? "" : String(value);
}

function formatOperationalDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function operationalTimingLabel(state: string): string {
  if (state === "blocked") return "Blocked";
  if (state === "overdue") return "Overdue";
  if (state === "late-plan") return "Planned after deadline";
  if (state === "due-soon") return "Due soon";
  if (state === "unscheduled") return "Missing dates";
  return "On track";
}

function operationalTimingVariant(state: string) {
  if (state === "overdue") return "destructive" as const;
  if (state === "blocked" || state === "late-plan" || state === "due-soon") {
    return "warning" as const;
  }
  if (state === "on-track") return "success" as const;
  return "outline" as const;
}

function numberValue(value: OpenViewRow["values"][string] | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown time" : date.toLocaleString();
}

function createWidgetId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `sample-widget-${crypto.randomUUID()}`;
  }
  return `sample-widget-${Date.now().toString(36)}`;
}
