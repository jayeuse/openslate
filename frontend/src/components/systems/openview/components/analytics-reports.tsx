"use client";

import {
  ArrowDown,
  ArrowUp,
  Copy,
  Download,
  FileText,
  Plus,
  Printer,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
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
import { ButtonGroup } from "@/components/ui/button-group";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { initialReport } from "../domain/seeds";
import { sampleOperationMessage } from "../../shared/runtime/sample-async";
import { OpenViewFilterEditor } from "./filter-editor";
import {
  OPENVIEW_MODULES,
  audienceLabel,
  decodeReport,
  filterRows,
  getModuleDefinition,
  getOpenViewRows,
  groupRows,
  isUnresolvedAudience,
  sortRows,
  type AudienceLookup,
  type OpenViewModuleId,
  type OpenViewRow,
  type Report as OpenViewReport,
} from "../domain/model";
import {
  analyticsFilterOperatorLabel,
  clone,
  emptyFilters,
  fieldLabel,
  formatSampleSnapshotDate,
  makeId,
  normalizeReportRecord,
  normalizeReportTemplates,
  scheduleLabels,
  valueFor,
} from "./analytics-data";
import { ExportConfirmation, type ExportRequest } from "./analytics-export";
import { EmptyState } from "./analytics-shared";
import { OPENVIEW_SAMPLE_TIMEZONE } from "../helpers/operations";
import {
  AudienceField,
  Choice,
  SortEditor,
  Workbench,
} from "./analytics-shared";
import type {
  OpenViewCommandController,
  OpenViewReadSnapshot,
} from "../adapters/controller";

export function Reports({
  moduleId = "service-requests",
  commands,
  snapshot,
  audienceLookup,
  onReportDirtyChange,
}: {
  moduleId?: OpenViewModuleId;
  commands: OpenViewCommandController;
  snapshot: OpenViewReadSnapshot;
  audienceLookup: AudienceLookup;
  onReportDirtyChange?: (dirty: boolean) => void;
}) {
  const lookup = audienceLookup;
  const commandPending = commands.isPending();
  const records = snapshot.records;
  const rawDraft = snapshot.reportDraft;
  const rawTemplates = snapshot.reportTemplates;
  const storedSelectedTemplateId = snapshot.reportTemplateSelected;
  const storedDraft = useMemo(
    () => normalizeReportRecord(rawDraft ?? initialReport, lookup),
    [rawDraft, lookup.roles, lookup.identities],
  );
  const templates = useMemo(
    () => normalizeReportTemplates(rawTemplates, lookup),
    [rawTemplates, lookup.roles, lookup.identities],
  );
  const restoresStoredDraft = storedDraft.moduleId === moduleId;
  const initialDraft: OpenViewReport = restoresStoredDraft
    ? storedDraft
    : {
        ...decodeReport(initialReport, lookup),
        id: makeId("sample-report"),
        moduleId,
        fields: getModuleDefinition(moduleId)
          .fields.slice(0, 3)
          .map((field) => field.id),
        sorts: [
          {
            field: getModuleDefinition(moduleId).primaryField,
            direction: "asc",
          },
        ],
        grouping:
          getModuleDefinition(moduleId).fields.find(
            (field) => field.id === "status",
          )?.id ?? null,
      };
  const persistedSelectedTemplateId =
    typeof storedSelectedTemplateId === "string"
      ? storedSelectedTemplateId
      : "";
  const selectedTemplateIdFromStorage = restoresStoredDraft
    ? templates.some(
        (template) =>
          template.id === persistedSelectedTemplateId &&
          template.id === initialDraft.id,
      )
      ? persistedSelectedTemplateId
      : templates.some((template) => template.id === initialDraft.id)
        ? initialDraft.id
        : ""
    : "";
  const [selectedTemplateId, setSelectedTemplateId] = useState(
    selectedTemplateIdFromStorage,
  );
  const selectedTemplate = templates.find(
    (template) => template.id === selectedTemplateId,
  );
  const [draft, setDraft] = useState<OpenViewReport>(() => clone(initialDraft));
  const [baseline, setBaseline] = useState<OpenViewReport | null>(() =>
    clone(initialDraft),
  );
  const draftRevision = useRef(0);
  const [pendingTemplateId, setPendingTemplateId] = useState<string | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [message, setMessage] = useState("");
  const [exportRequest, setExportRequest] = useState<ExportRequest | null>(
    null,
  );
  const dirty =
    baseline === null || JSON.stringify(draft) !== JSON.stringify(baseline);
  useEffect(() => {
    onReportDirtyChange?.(dirty);
    return () => onReportDirtyChange?.(false);
  }, [dirty, onReportDirtyChange]);
  const rows = useMemo(
    () =>
      sortRows(
        filterRows(getOpenViewRows(draft.moduleId, records), draft.filters),
        draft.sorts,
      ),
    [draft, records],
  );
  const groups = useMemo(
    () => groupRows(rows, draft.grouping),
    [rows, draft.grouping],
  );
  const moduleDefinition = getModuleDefinition(draft.moduleId);
  const update = (change: Partial<OpenViewReport>) => {
    const next = { ...draft, ...change };
    draftRevision.current += 1;
    setDraft(next);
    setMessage("");
  };

  async function saveTemplate() {
    if (commandPending) return;
    const name = draft.name.trim();
    if (!name || draft.fields.length === 0) {
      setMessage(
        "Enter a report title and select at least one field before saving.",
      );
      return;
    }
    const next = { ...draft, name };
    const submittedRevision = draftRevision.current;
    setMessage("");
    try {
      const expectedId =
        selectedTemplate?.id ??
        (selectedTemplateId === draft.id ? selectedTemplateId : undefined);
      const result = await commands.saveReportTemplate({
        report: next,
        expectedId,
        expected: expectedId ? selectedTemplate : undefined,
      });
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      setBaseline(result.value);
      setSelectedTemplateId(result.value.id);
      if (submittedRevision !== draftRevision.current) {
        setMessage(
          "Report template saved. Your newer edits remain open as an unsaved draft.",
        );
        return;
      }
      draftRevision.current = 0;
      setDraft(result.value);
      setMessage(
        "Report template saved in this browser tab. Audience settings do not grant access, and no delivery is scheduled.",
      );
    } catch (error) {
      setMessage(
        sampleOperationMessage(
          error,
          "The report template could not be saved. Keep the editor open and try again.",
        ),
      );
    }
  }

  function createTemplate() {
    if (commandPending) return;
    const nextModule = getModuleDefinition(draft.moduleId);
    const next = {
      ...decodeReport(initialReport, lookup),
      id: makeId("sample-report"),
      name: "Untitled report",
      moduleId: draft.moduleId,
      fields: nextModule.fields.slice(0, 3).map((field) => field.id),
      grouping:
        nextModule.fields.find((field) => field.id === "status")?.id ?? null,
    };
    draftRevision.current = 0;
    setDraft(next);
    setBaseline(null);
    setSelectedTemplateId("");
    setMessage(
      "New report draft ready. Save it to create a reusable template.",
    );
  }

  async function duplicateTemplate() {
    if (commandPending) return;
    const next = {
      ...clone(draft),
      id: makeId("sample-report"),
      name: `${draft.name || "Report"} copy`,
    };
    const submittedRevision = draftRevision.current;
    setMessage("");
    try {
      const result = await commands.duplicateReportDraft(next);
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      if (submittedRevision !== draftRevision.current) {
        setMessage(
          "Report duplicated. Your newer edits remain open as an unsaved draft.",
        );
        return;
      }
      draftRevision.current = 0;
      setDraft(result.value);
      setBaseline(null);
      setSelectedTemplateId("");
      setMessage("Report duplicated as a new draft.");
    } catch (error) {
      setMessage(
        sampleOperationMessage(
          error,
          "The report could not be duplicated. Keep the editor open and try again.",
        ),
      );
    }
  }

  function chooseTemplate(id: string) {
    if (commandPending) return;
    if (!id) return;
    if (dirty) setPendingTemplateId(id);
    else {
      const next = templates.find((template) => template.id === id);
      if (next) {
        draftRevision.current = 0;
        setSelectedTemplateId(id);
        setDraft(clone(next));
        setBaseline(clone(next));
      }
    }
  }

  function updateModule(moduleId: OpenViewModuleId) {
    const nextModule = getModuleDefinition(moduleId);
    update({
      moduleId,
      fields: nextModule.fields.slice(0, 3).map((field) => field.id),
      filters: emptyFilters(),
      sorts: [{ field: nextModule.primaryField, direction: "asc" }],
      grouping:
        nextModule.fields.find((field) => field.id === "status")?.id ?? null,
    });
  }

  async function resetDraft() {
    if (commandPending) return;
    const target = selectedTemplate
      ? clone(selectedTemplate)
      : normalizeReportRecord(
          { ...initialReport, moduleId: draft.moduleId },
          lookup,
        );
    setMessage("");
    const submittedRevision = draftRevision.current;
    try {
      const result = await commands.resetReportDraft(target);
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      setBaseline(result.value);
      if (submittedRevision !== draftRevision.current) {
        setMessage(
          "The report reset was accepted, but your newer edits remain open.",
        );
        return;
      }
      draftRevision.current = 0;
      setDraft(result.value);
      setSelectedTemplateId(
        templates.some((template) => template.id === result.value.id)
          ? result.value.id
          : "",
      );
      setMessage("Unsaved report changes were reset.");
    } catch (error) {
      setMessage(
        sampleOperationMessage(
          error,
          "The report draft could not be reset. Try again.",
        ),
      );
    }
  }

  return (
    <Workbench
      controls={
        <FieldGroup>
          <div>
            <h2 className="font-semibold">Report builder</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Shape an operational report, then save the recipe for reuse.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              className="min-h-11"
              disabled={commandPending}
              onClick={createTemplate}
            >
              <Plus data-icon="inline-start" />
              New report
            </Button>
            <Button
              variant="ghost"
              className="min-h-11"
              disabled={commandPending}
              onClick={() => void duplicateTemplate()}
            >
              <Copy data-icon="inline-start" />
              {commands.isPending("openview.report.duplicate")
                ? "Duplicating…"
                : "Duplicate"}
            </Button>
          </div>
          {templates.length > 0 ? (
            <Choice
              id="report-template"
              label="Saved template"
              value={selectedTemplateId}
              values={[
                { value: "", label: "Choose a template" },
                ...templates.map((template) => ({
                  value: template.id,
                  label: template.name,
                })),
              ]}
              disabled={commandPending}
              onChange={chooseTemplate}
            />
          ) : null}
          <Choice
            id="report-module"
            label="Source module"
            value={draft.moduleId}
            values={OPENVIEW_MODULES.map((item) => ({
              value: item.id,
              label: item.name,
            }))}
            onChange={(moduleId) => updateModule(moduleId as OpenViewModuleId)}
          />
          <Field>
            <FieldLabel htmlFor="report-title">Report title</FieldLabel>
            <Input
              id="report-title"
              className="min-h-11"
              value={draft.name}
              maxLength={80}
              onChange={(event) => update({ name: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="report-subtitle">Subtitle</FieldLabel>
            <Input
              id="report-subtitle"
              className="min-h-11"
              value={draft.subtitle}
              maxLength={160}
              placeholder="Optional context for readers"
              onChange={(event) => update({ subtitle: event.target.value })}
            />
          </Field>
          <FieldSet>
            <FieldLegend>Report fields</FieldLegend>
            <p className="text-muted-foreground text-sm">
              Check fields, then use the arrows to set column order.
            </p>
            <FieldGroup>
              {moduleDefinition.fields.map((field) => (
                <Field
                  key={field.id}
                  className="min-h-11 flex-row items-center gap-3"
                >
                  <Checkbox
                    id={`report-field-${field.id}`}
                    className="size-5 after:-inset-3"
                    checked={draft.fields.includes(field.id)}
                    onCheckedChange={(checked) => {
                      const fields = checked
                        ? [...draft.fields, field.id]
                        : draft.fields.filter((item) => item !== field.id);
                      update({ fields });
                    }}
                  />
                  <FieldLabel htmlFor={`report-field-${field.id}`}>
                    {field.label}
                  </FieldLabel>
                  {draft.fields.includes(field.id) ? (
                    <ButtonGroup className="ml-auto">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="min-h-11 min-w-11"
                        disabled={draft.fields.indexOf(field.id) === 0}
                        aria-label={`Move ${field.label} up`}
                        onClick={() => {
                          const index = draft.fields.indexOf(field.id);
                          const fields = [...draft.fields];
                          [fields[index - 1], fields[index]] = [
                            fields[index],
                            fields[index - 1],
                          ];
                          update({ fields });
                        }}
                      >
                        <ArrowUp data-icon="inline-start" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="min-h-11 min-w-11"
                        disabled={
                          draft.fields.indexOf(field.id) ===
                          draft.fields.length - 1
                        }
                        aria-label={`Move ${field.label} down`}
                        onClick={() => {
                          const index = draft.fields.indexOf(field.id);
                          const fields = [...draft.fields];
                          [fields[index + 1], fields[index]] = [
                            fields[index],
                            fields[index + 1],
                          ];
                          update({ fields });
                        }}
                      >
                        <ArrowDown data-icon="inline-start" />
                      </Button>
                    </ButtonGroup>
                  ) : null}
                </Field>
              ))}
            </FieldGroup>
          </FieldSet>
          <OpenViewFilterEditor
            module={moduleDefinition}
            rows={getOpenViewRows(draft.moduleId, records)}
            filters={draft.filters}
            onChange={(filters) => update({ filters })}
            title="Report filters"
            idPrefix="openview-report-filter"
            operatorMode="all"
            clearValueOnFieldChange
            selectValueFields
            showLogicWhenEmpty={false}
            logicControl="select"
            logicLabel="Match"
            logicOptions={{
              and: "All conditions (AND)",
              or: "Any condition (OR)",
            }}
            valueMaxLength={null}
            operatorLabel={analyticsFilterOperatorLabel}
            addOperator="contains"
          />
          <SortEditor
            moduleId={draft.moduleId}
            sorts={draft.sorts}
            onChange={(sorts) => update({ sorts })}
          />
          <Choice
            id="report-grouping"
            label="Group rows by"
            value={draft.grouping ?? "none"}
            values={[
              { value: "none", label: "Do not group" },
              ...moduleDefinition.fields.map((field) => ({
                value: field.id,
                label: field.label,
              })),
            ]}
            onChange={(grouping) =>
              update({ grouping: grouping === "none" ? null : grouping })
            }
          />
          <Field className="min-h-11 flex-row items-center gap-3">
            <Checkbox
              id="report-totals"
              className="size-5 after:-inset-3"
              checked={draft.totals}
              onCheckedChange={(totals) => update({ totals: Boolean(totals) })}
            />
            <FieldLabel htmlFor="report-totals">Show group totals</FieldLabel>
          </Field>
          <Choice
            id="report-schedule"
            label="Schedule preview"
            value={draft.schedule.cadence}
            values={[
              { value: "manual", label: "Manual" },
              { value: "daily", label: "Daily" },
              { value: "weekly", label: "Weekly" },
              { value: "monthly", label: "Monthly" },
            ]}
            onChange={(cadence) =>
              update({
                schedule: {
                  ...draft.schedule,
                  cadence: cadence as OpenViewReport["schedule"]["cadence"],
                },
              })
            }
            description="No report delivery or background job runs here."
          />
          <Choice
            id="report-timezone"
            label="Timezone"
            value={draft.schedule.timezone}
            values={["Asia/Manila", "Asia/Singapore", "UTC"]}
            onChange={(timezone) =>
              update({ schedule: { ...draft.schedule, timezone } })
            }
          />
          <AudienceField
            id="report-audience"
            audience={draft.audience}
            audienceLookup={lookup}
            onChange={(audience) => update({ audience })}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              className="min-h-11"
              disabled={commandPending}
              onClick={() => void saveTemplate()}
            >
              <Save data-icon="inline-start" />
              {commands.isPending(`openview.report.save:${draft.id}`)
                ? "Saving…"
                : dirty
                  ? "Save template"
                  : "Saved"}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={!dirty || commandPending}
              onClick={() => void resetDraft()}
            >
              <RotateCcw data-icon="inline-start" />
              {commands.isPending("openview.report.reset")
                ? "Resetting…"
                : "Reset draft"}
            </Button>
          </div>
        </FieldGroup>
      }
    >
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <CardTitle className="mt-2 text-2xl">
                {draft.name || "Untitled report"}
              </CardTitle>
              {draft.subtitle ? (
                <CardDescription className="mt-2">
                  {draft.subtitle}
                </CardDescription>
              ) : null}
              <p className="text-muted-foreground mt-2 text-sm">
                Source: {moduleDefinition.name} · {rows.length} matching records
                · Snapshot: {formatSampleSnapshotDate()} ·{" "}
                {OPENVIEW_SAMPLE_TIMEZONE} ·{" "}
                {scheduleLabels[draft.schedule.cadence]} preview · schedule
                timezone: {draft.schedule.timezone}
              </p>
              <p className="text-muted-foreground mt-2 max-w-3xl text-sm">
                This report uses generated records and will not be delivered
                automatically.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={
                  draft.audience.kind === "everyone" ||
                  isUnresolvedAudience(draft.audience)
                    ? "warning"
                    : "secondary"
                }
              >
                {audienceLabel(draft.audience, lookup)}
              </Badge>
              <Badge variant="outline">{dirty ? "Draft" : "Saved"}</Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {draft.fields.length === 0 ? (
            <EmptyState
              icon={<FileText />}
              title="Choose fields for this report"
              description="Select at least one field from the builder to render a report preview."
            />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<FileText />}
              title="No matching records"
              description="Try clearing a filter or choosing another source module."
            />
          ) : (
            <ReportTable report={draft} groups={groups} rows={rows} />
          )}
          <Separator className="my-6" />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold">Export</h3>
              <p className="text-muted-foreground text-sm">
                Exports include only this preview, its selected fields, and its
                current filters.
              </p>
              <p className="text-muted-foreground mt-1 text-xs">
                Snapshot: {formatSampleSnapshotDate()} ·{" "}
                {OPENVIEW_SAMPLE_TIMEZONE} · generated records; nothing is
                uploaded or delivered.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                className="min-h-11"
                disabled={draft.fields.length === 0 || rows.length === 0}
                onClick={() =>
                  setExportRequest({
                    kind: "csv",
                    title: draft.name || "OpenView report",
                    source: moduleDefinition.name,
                    subtitle: draft.subtitle,
                    fields: draft.fields,
                    fieldLabels: Object.fromEntries(
                      draft.fields.map((field) => [
                        field,
                        fieldLabel(draft.moduleId, field),
                      ]),
                    ),
                    rows,
                    filters: draft.filters,
                    grouping: draft.grouping,
                    totals: draft.totals,
                    groups: draft.grouping ? groups : undefined,
                  })
                }
              >
                <Download data-icon="inline-start" />
                Download CSV
              </Button>
              <Button
                variant="outline"
                className="min-h-11"
                disabled={draft.fields.length === 0 || rows.length === 0}
                onClick={() =>
                  setExportRequest({
                    kind: "pdf",
                    title: draft.name || "OpenView report",
                    source: moduleDefinition.name,
                    subtitle: draft.subtitle,
                    fields: draft.fields,
                    fieldLabels: Object.fromEntries(
                      draft.fields.map((field) => [
                        field,
                        fieldLabel(draft.moduleId, field),
                      ]),
                    ),
                    rows,
                    filters: draft.filters,
                    grouping: draft.grouping,
                    totals: draft.totals,
                    groups: draft.grouping ? groups : undefined,
                  })
                }
              >
                <Printer data-icon="inline-start" />
                Print / save PDF
              </Button>
            </div>
          </div>
          {message ? (
            <Alert
              variant={
                message.includes("before") ||
                message.includes("could not") ||
                message.includes("changed")
                  ? "warning"
                  : "success"
              }
              className="mt-5"
            >
              {message}
            </Alert>
          ) : null}
        </CardContent>
        <CardFooter className="flex-wrap justify-between">
          <p className="text-muted-foreground text-xs">
            Audience settings do not grant access. Invitations, delivery jobs,
            and background refresh do not run.
          </p>
          <Button
            variant="destructive"
            className="min-h-11"
            disabled={!selectedTemplate || commandPending}
            onClick={() => {
              setDeleteError("");
              setConfirmDelete(true);
            }}
          >
            <Trash2 data-icon="inline-start" />
            {commands.isPending(
              `openview.report.delete:${selectedTemplate?.id ?? ""}`,
            )
              ? "Deleting…"
              : "Delete template"}
          </Button>
        </CardFooter>
      </Card>
      <ExportConfirmation
        request={exportRequest}
        onClose={() => setExportRequest(null)}
        onComplete={(result) => {
          setExportRequest(null);
          setMessage(result);
        }}
      />
      <AlertDialog
        open={pendingTemplateId !== null}
        onOpenChange={(open) => {
          if (!open && commandPending) return;
          if (!open) setPendingTemplateId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard report changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your current report draft has unsaved changes. Loading a template
              will replace it.
            </AlertDialogDescription>
            {commandPending ? (
              <p role="status" className="text-muted-foreground text-sm">
                A report change is still being saved. Keep editing until it
                finishes.
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={commandPending}
              onClick={() => setPendingTemplateId(null)}
            >
              Keep editing
            </Button>
            <Button
              className="min-h-11"
              disabled={commandPending}
              onClick={() => {
                if (pendingTemplateId) {
                  const next = templates.find(
                    (template) => template.id === pendingTemplateId,
                  );
                  if (next) {
                    draftRevision.current = 0;
                    setSelectedTemplateId(next.id);
                    setDraft(clone(next));
                    setBaseline(clone(next));
                  }
                }
                setPendingTemplateId(null);
              }}
            >
              Discard and load
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={confirmDelete}
        onOpenChange={(open) => {
          if (!open && commandPending) return;
          if (!open) setDeleteError("");
          setConfirmDelete(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete “{selectedTemplate?.name}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes the saved report template from this tab. It does not
              remove source records.
            </AlertDialogDescription>
            {commandPending ? (
              <p role="status" className="text-muted-foreground text-sm">
                A report change is still being saved. Keep this confirmation
                open until it finishes.
              </p>
            ) : null}
          </AlertDialogHeader>
          {deleteError ? (
            <Alert role="alert" variant="warning">
              {deleteError}
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={commandPending}
              onClick={() => {
                setDeleteError("");
                setConfirmDelete(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="min-h-11"
              disabled={!selectedTemplate || commandPending}
              onClick={async () => {
                if (!selectedTemplate) return;
                setMessage("");
                setDeleteError("");
                try {
                  const result = await commands.deleteReportTemplate(
                    selectedTemplate.id,
                    selectedTemplate,
                  );
                  if (!result.ok) {
                    setDeleteError(result.error);
                    return;
                  }
                  setSelectedTemplateId("");
                  setDraft(result.value.draft);
                  setBaseline(result.value.draft);
                  setConfirmDelete(false);
                  setDeleteError("");
                  setMessage("Report template deleted from this tab.");
                } catch (error) {
                  setDeleteError(
                    sampleOperationMessage(
                      error,
                      "The report template could not be deleted. Try again.",
                    ),
                  );
                }
              }}
            >
              {commands.isPending(
                `openview.report.delete:${selectedTemplate?.id ?? ""}`,
              )
                ? "Deleting…"
                : "Delete template"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Workbench>
  );
}

function ReportTable({
  report,
  groups,
  rows,
}: {
  report: OpenViewReport;
  groups: { label: string; rows: OpenViewRow[] }[];
  rows: OpenViewRow[];
}) {
  return (
    <Table className="min-w-[38rem]">
      <TableCaption className="sr-only">
        {rows.length} matching records from{" "}
        {getModuleDefinition(report.moduleId).name}.
      </TableCaption>
      <TableHeader className="bg-muted/65">
        <TableRow className="hover:bg-muted/65">
          {report.fields.map((field) => (
            <TableHead
              key={field}
              className="px-4 text-xs font-semibold tracking-wide uppercase"
            >
              {fieldLabel(report.moduleId, field)}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.map((group, groupIndex) => (
          <Fragment key={group.label}>
            {report.grouping ? (
              <TableRow className="hover:bg-muted/60 bg-muted/45">
                <TableHead colSpan={report.fields.length} className="px-4">
                  <span className="flex items-center gap-2">
                    <span
                      className="size-2 rounded-full"
                      style={{
                        backgroundColor: `var(--chart-${(groupIndex % 5) + 1})`,
                      }}
                      aria-hidden="true"
                    />
                    <span className="font-semibold">{group.label}</span>
                    <span className="text-muted-foreground font-normal">
                      {group.rows.length}{" "}
                      {group.rows.length === 1 ? "record" : "records"}
                    </span>
                  </span>
                </TableHead>
              </TableRow>
            ) : null}
            {group.rows.map((row) => (
              <TableRow key={row.id} className="odd:bg-muted/15">
                {report.fields.map((field, fieldIndex) => (
                  <TableCell
                    key={`${row.id}-${field}`}
                    className={cn(
                      "px-4",
                      fieldIndex === 0 ? "font-medium" : undefined,
                    )}
                  >
                    {valueFor(row, field)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {report.totals && report.grouping ? (
              <TableRow className="bg-muted/20">
                <TableCell
                  colSpan={report.fields.length}
                  className="px-4 text-right text-xs font-medium"
                >
                  Group total: {group.rows.length}
                </TableCell>
              </TableRow>
            ) : null}
          </Fragment>
        ))}
      </TableBody>
      {report.totals ? (
        <TableFooter>
          <TableRow>
            <TableCell
              colSpan={report.fields.length}
              className="px-4 text-right font-semibold"
            >
              Grand total: {rows.length}
            </TableCell>
          </TableRow>
        </TableFooter>
      ) : null}
    </Table>
  );
}
