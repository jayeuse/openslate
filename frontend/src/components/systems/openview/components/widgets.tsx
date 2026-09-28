"use client";

import {
  ArrowDown,
  ArrowUp,
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
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
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { cn } from "@/lib/utils";
import { initialPeople, initialRoles } from "../../shared/data/sample-people";
import { useSampleState } from "../../shared/runtime/sample-state";
import type { SampleRecord } from "../../shared/data/sample-data";
import { OpenViewAudienceConfirmation } from "./audience-confirmation";
import { OpenViewFilterEditor } from "./filter-editor";
import {
  OPENVIEW_MODULES,
  audienceLabel,
  filterRows,
  getModuleDefinition,
  isUnresolvedAudience,
  projectAudienceLookup,
  type AudienceLookup,
  type AudienceRef,
  type FilterOperator,
  type OpenViewModuleId,
  type OpenViewRow,
  type OpenViewWidget,
} from "../domain/model";
import {
  audienceFromKey,
  audienceKey,
  chooseWorkloadDimension,
  defaultWidgetName,
  formatTimestamp,
  normalizeWidget,
  normalizeWidgetType,
  prepareModuleChange,
  refreshLabel,
  resolveRows,
  widgetTypeLabel,
  writeWidget,
  type RowsByModule,
  type SampleWidget,
  type WidgetInput,
} from "./widget-model";
import { WidgetPreview, widgetTone } from "./widget-preview";

export type { SampleWidget } from "./widget-model";

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
                {board ? "board" : "dashboard"}. This change stays in this
                browser tab.
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
              This does not change access permissions.
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
            : "These settings do not send invitations, schedule jobs, or grant access."}
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

function widgetOperatorLabel(operator: FilterOperator): string {
  return operator
    .split("-")
    .map((word) => word[0]?.toLocaleUpperCase() + word.slice(1))
    .join(" ");
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
