"use client";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  OpenViewDashboardWidgetInput,
  OpenViewDashboardWidgetSize,
  OpenViewDashboardWidgetType,
} from "../adapters/dashboards-api";
import type { OpenViewDataSourceField } from "../adapters/views-api";
import { aggregationLabel, type ChartSourceDraft } from "../domain/chart-query";
import type { DashboardWidgetData } from "../domain/dashboard-draft";
import { openViewRecordFieldValue } from "../domain/record-display";
import type {
  ChartEditorActions,
  ChartEditorCatalog,
} from "./chart-editor/chart-editor";
import { ChartSourceEditor } from "./chart-editor/chart-source-editor";
import { OpenViewChartPreview } from "./chart-preview";

type DashboardWidgetEditorProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: boolean;
  value: ChartSourceDraft;
  onChange: (value: ChartSourceDraft) => void;
  onTypeChange: (type: OpenViewDashboardWidgetType) => void;
  size: OpenViewDashboardWidgetSize;
  onSizeChange: (size: OpenViewDashboardWidgetSize) => void;
  catalog: ChartEditorCatalog;
  actions: ChartEditorActions;
  fieldsByModule: Record<string, OpenViewDataSourceField[]>;
  widgetCount: number;
  busy: boolean;
  sourceLoading: boolean;
  disabled: boolean;
  refusedChartId: string | null;
  onRetrySource: () => void;
  onUnavailable: () => void;
  error: string;
  preview: { signature: string; data: DashboardWidgetData } | null;
  onPreview: (input: OpenViewDashboardWidgetInput) => void;
  onApply: (input: OpenViewDashboardWidgetInput) => void;
};

/** Controlled presentation; the page owns the editor read and Dashboard draft. */
export function DashboardWidgetEditor(props: DashboardWidgetEditorProps) {
  const disabled = props.busy || props.sourceLoading || props.disabled;
  const signature = JSON.stringify(props.value);
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {props.editing ? "Edit widget" : "Add widget"}
          </DialogTitle>
          <DialogDescription>
            Preview one result without saving. Keep changes in your draft, then
            save the Dashboard when ready.
          </DialogDescription>
        </DialogHeader>
        {props.sourceLoading ? (
          <p role="status" className="text-muted-foreground text-sm">
            Checking the current widget definition…
          </p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="dashboard-widget-type">Widget type</FieldLabel>
            <Select
              id="dashboard-widget-type"
              className="min-h-11"
              value={props.value.inline.widgetType}
              disabled={disabled}
              onValueChange={(type) =>
                props.onTypeChange(type as OpenViewDashboardWidgetType)
              }
            >
              <option value="summary">Summary</option>
              <option value="workload">Workload</option>
              <option value="records">Record list</option>
              <option value="chart">Chart</option>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="dashboard-widget-size">Widget size</FieldLabel>
            <Select
              id="dashboard-widget-size"
              className="min-h-11"
              value={props.size}
              disabled={disabled}
              onValueChange={(size) =>
                props.onSizeChange(size as OpenViewDashboardWidgetSize)
              }
            >
              <option value="S">S · One third</option>
              <option value="M">M · Half row</option>
              <option value="L">L · Full row</option>
            </Select>
            <FieldDescription>
              Every widget uses the full row below 768 px.
            </FieldDescription>
          </Field>
        </div>
        {props.open ? (
          <ChartSourceEditor
            value={props.value}
            onChange={props.onChange}
            disabled={disabled}
            catalog={props.catalog}
            actions={props.actions}
            refusedChartId={props.refusedChartId}
            onRetrySource={props.onRetrySource}
            onUnavailable={props.onUnavailable}
          >
            {(input, sourceStamp) => (
              <>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 self-start"
                  disabled={!input || disabled}
                  onClick={() => {
                    if (input) props.onPreview(input);
                  }}
                >
                  {props.busy ? "Loading preview…" : "Preview widget"}
                </Button>
                {props.error ? (
                  <Alert role="alert" variant="destructive">
                    {props.error}
                  </Alert>
                ) : null}
                {props.preview?.signature === signature &&
                (props.value.chartId === null ||
                  props.preview.data.sourceStamp === sourceStamp) ? (
                  <DraftWidgetPreview
                    data={props.preview.data}
                    fieldsByModule={props.fieldsByModule}
                  />
                ) : null}
                <DialogFooter>
                  <Button
                    variant="outline"
                    className="min-h-11"
                    onClick={() => props.onOpenChange(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    className="min-h-11"
                    disabled={
                      !input ||
                      disabled ||
                      (!props.editing && props.widgetCount >= 12)
                    }
                    onClick={() => {
                      if (input) props.onApply(input);
                    }}
                  >
                    {props.editing ? "Apply widget changes" : "Add widget"}
                  </Button>
                </DialogFooter>
              </>
            )}
          </ChartSourceEditor>
        ) : null}
        <p role="status" className="text-muted-foreground text-sm">
          {props.widgetCount} of 12 widgets used.
        </p>
      </DialogContent>
    </Dialog>
  );
}

function DraftWidgetPreview({
  data,
  fieldsByModule,
}: {
  data: DashboardWidgetData;
  fieldsByModule: Record<string, OpenViewDataSourceField[]>;
}) {
  return (
    <div className="space-y-3" aria-label="Draft widget preview">
      <p className="text-muted-foreground text-sm">
        Read-only draft preview. No widget has been saved.
      </p>
      {data.kind === "aggregate" ? (
        <>
          {"chartType" in data.config ? (
            <OpenViewChartPreview
              type={data.config.chartType}
              data={data.result.items.map((item) => ({
                key: item.key ?? "null",
                label: item.label,
                value: item.value === null ? null : Number(item.value),
              }))}
              valueLabel={
                "mode" in data.config.query
                  ? aggregationLabel(data.config.query.aggregation)
                  : "Value"
              }
            />
          ) : null}
          <div className="overflow-x-auto">
            <table aria-label="Draft preview values" className="w-full text-sm">
              <thead>
                <tr>
                  <th scope="col" className="p-2 text-left">
                    Group or period
                  </th>
                  <th scope="col" className="p-2 text-right">
                    Value
                  </th>
                  <th scope="col" className="p-2 text-right">
                    Record count
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.result.items.map((item) => (
                  <tr key={item.key ?? "null"}>
                    <td className="p-2">{item.label}</td>
                    <td className="p-2 text-right">{item.value ?? "—"}</td>
                    <td className="p-2 text-right">{item.recordCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          <p>{data.result.pagination.total} matching records</p>
          <div className="overflow-x-auto">
            <table
              aria-label="Draft preview records"
              className="w-full text-sm"
            >
              <thead>
                <tr>
                  {data.config.query.definition.columns.map((ref) => (
                    <th key={ref.fieldId} scope="col" className="p-2 text-left">
                      {fieldsByModule[data.config.query.moduleId]?.find(
                        (field) =>
                          field.id === ref.fieldId &&
                          field.type === ref.expectedType,
                      )?.name ?? "Unavailable field"}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.result.items.map((record) => (
                  <tr key={record.id}>
                    {data.config.query.definition.columns.map((ref) => (
                      <td key={ref.fieldId} className="p-2">
                        {String(
                          openViewRecordFieldValue(record, {
                            id: ref.fieldId,
                            type: ref.expectedType,
                          }) ?? "—",
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
