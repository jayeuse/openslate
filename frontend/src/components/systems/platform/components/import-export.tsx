"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import { requestSessionRecheck } from "@/lib/auth-api";
import type { WorkspaceNavigationGuard } from "@/components/workspace-navigation-guard";
import { Field, FieldLabel } from "@/components/ui/field";
import { FilePickerButton } from "@/components/ui/file-picker-button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { Action, Choice, Panel, Toggle } from "../../shared/components/ui";
import { RecordFormFields } from "../../openview/components/record-form-fields";
import {
  encodeFormValue,
  toFormValue,
  type RecordFormErrors,
  type RecordFormValues,
} from "../../openview/domain/record-form";
import {
  authMeOptions,
  boundedCatalogOptions,
  moduleWorkspaceOptions,
  openViewKeys,
} from "../../openview/adapters/openview-queries";
import { useOpenViewAccessDenied } from "../../openview/adapters/openview-access";
import {
  listOpenViewDataSources,
  listOpenViewDataSourceFields,
  listOpenViewSavedViews,
  type OpenViewQueryDefinition,
} from "../../openview/adapters/views-api";
import {
  prepareRecordCsv,
  type RecordCsv,
} from "../adapters/record-import-api";
import { useRecordImport } from "../hooks/use-record-import";

type ImportExportProps = {
  onNavigationGuardChange: (guard: WorkspaceNavigationGuard | null) => void;
};
export default function ImportExport({
  onNavigationGuardChange,
}: ImportExportProps) {
  const client = useQueryClient();
  const identity = useQuery(authMeOptions());
  const admin = identity.data?.role === "admin" && !identity.isError;
  const catalog = useQuery({ ...boundedCatalogOptions(), enabled: admin });
  const denied = useOpenViewAccessDenied();
  const [moduleId, setModuleId] = useState("");
  const [exportModuleId, setExportModuleId] = useState("");
  const [viewId, setViewId] = useState("");
  const workspace = useQuery({
    ...moduleWorkspaceOptions(moduleId),
    enabled: admin && Boolean(moduleId),
  });
  const exportWorkspace = useQuery({
    ...moduleWorkspaceOptions(exportModuleId),
    enabled: admin && Boolean(exportModuleId),
  });
  const importer = useRecordImport();
  const [mapping, setMapping] = useState<Record<number, string>>({});
  const [defaultFields, setDefaultFields] = useState<Record<string, boolean>>(
    {},
  );
  const [defaultValues, setDefaultValues] = useState<RecordFormValues>({});
  const [defaultErrors, setDefaultErrors] = useState<RecordFormErrors>({});
  const [validationPage, setValidationPage] = useState(0);
  const [exportRows, setExportRows] = useState<RecordCsv | null>(null);
  const [exportError, setExportError] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [collectionError, setCollectionError] = useState("");
  const exportController = useRef<AbortController | null>(null);
  const exportGeneration = useRef(0);
  const busy = importer.operation !== null;
  const locked = busy || importer.uncertain || !admin;
  const sources =
    !denied && !catalog.isError ? (catalog.data?.items ?? []) : [];
  const fields =
    !denied && !workspace.isError ? (workspace.data?.fields ?? []) : [];
  const views =
    !denied && !exportWorkspace.isError
      ? (exportWorkspace.data?.views.filter((view) => !view.isDeleted) ?? [])
      : [];
  const unmapped = fields.filter(
    (field) => !Object.values(mapping).includes(field.id),
  );
  const invalid =
    importer.preview?.rows.filter((row) => row.status === "invalid") ?? [];
  const previewColumns = fields.filter(
    (field) =>
      Object.values(mapping).includes(field.id) || defaultFields[field.id],
  );
  const previewValid =
    importer.preview?.rows.filter((row) => row.status !== "invalid").length ??
    0;

  useEffect(() => {
    onNavigationGuardChange(importer.guard);
    return () => onNavigationGuardChange(null);
  }, [onNavigationGuardChange, importer.guard]);
  useEffect(
    () => () => {
      exportGeneration.current += 1;
      exportController.current?.abort();
    },
    [],
  );

  function clearExport() {
    exportGeneration.current += 1;
    exportController.current?.abort();
    exportController.current = null;
    setPreparing(false);
    setExportRows(null);
    setExportError("");
  }
  function configuration() {
    const defaults: Record<string, unknown> = {};
    const errors: RecordFormErrors = {};
    for (const field of unmapped)
      if (defaultFields[field.id]) {
        const encoded = encodeFormValue(
          field,
          defaultValues[field.id] ??
            toFormValue(field, field.config.defaultValue ?? null),
        );
        if ("error" in encoded) errors[field.id] = encoded.error;
        else defaults[field.id] = encoded.value;
      }
    setDefaultErrors(errors);
    if (Object.keys(errors).length) {
      importer.setDraftError("Fix the default values before previewing.");
      return null;
    }
    return {
      module_id: moduleId,
      mapping: Object.entries(mapping)
        .filter(([, fieldId]) => fieldId)
        .map(([index, field_id]) => ({
          column_index: Number(index),
          field_id,
        })),
      defaults,
    };
  }
  async function loadMore(
    kind: "modules" | "fields" | "views",
    ownerModule = moduleId,
  ) {
    if (loadingMore) return;
    setLoadingMore(true);
    setCollectionError("");
    try {
      if (kind === "modules" && catalog.data) {
        const page = await listOpenViewDataSources({
          limit: 100,
          offset: catalog.data.nextOffset,
        });
        client.setQueryData(openViewKeys.boundedCatalog(), {
          items: [...catalog.data.items, ...page.items],
          hasMore: page.pagination.hasMore,
          nextOffset: page.pagination.offset + page.pagination.count,
        });
      } else {
        const key = openViewKeys.moduleWorkspace(ownerModule);
        const current = client.getQueryData(
          moduleWorkspaceOptions(ownerModule).queryKey,
        );
        if (!current) return;
        if (kind === "fields") {
          const page = await listOpenViewDataSourceFields(ownerModule, {
            limit: 100,
            offset: current.fieldsNextOffset,
          });
          client.setQueryData(key, {
            ...current,
            fields: [...current.fields, ...page.items],
            fieldsHasMore: page.pagination.hasMore,
            fieldsNextOffset: page.pagination.offset + page.pagination.count,
          });
        } else {
          const page = await listOpenViewSavedViews({
            moduleId: ownerModule,
            deleted: "include",
            limit: 100,
            offset: current.viewsNextOffset,
          });
          client.setQueryData(key, {
            ...current,
            views: [...current.views, ...page.items],
            viewsHasMore: page.pagination.hasMore,
            viewsNextOffset: page.pagination.offset + page.pagination.count,
          });
        }
      }
    } catch {
      setCollectionError("More options could not be loaded. Try again.");
    } finally {
      setLoadingMore(false);
    }
  }
  async function previewExport() {
    if (preparing || !exportModuleId || denied || !admin) return;
    const data = exportWorkspace.data;
    const view = views.find((view) => view.id === viewId);
    if (!data || exportWorkspace.isError || (viewId && !view)) return;
    if (!view && (data.fieldsHasMore || data.fields.length > 100)) {
      setExportError(
        "Choose a saved view with up to 100 columns, or finish loading the module fields.",
      );
      return;
    }
    const definition: OpenViewQueryDefinition = view?.definition ?? {
      version: 1,
      logic: "and",
      columns: data.fields.map((field) => ({
        fieldId: field.id,
        expectedType: field.type,
      })),
      filters: [],
      sort: [],
      search: null,
      searchFields: [],
      deleted: "exclude",
    };
    clearExport();
    const started = exportGeneration.current;
    const abort = new AbortController();
    exportController.current = abort;
    setPreparing(true);
    try {
      const csv = await prepareRecordCsv(
        exportModuleId,
        definition,
        abort.signal,
      );
      if (!abort.signal.aborted && started === exportGeneration.current)
        setExportRows(csv);
    } catch (error) {
      if (!abort.signal.aborted && started === exportGeneration.current) {
        if (
          error instanceof ApiError &&
          (error.code === "mfa_required" || error.code === "ip_not_allowed")
        )
          requestSessionRecheck();
        setExportError(
          error instanceof ApiError &&
            (error.code === "mfa_required" || error.code === "ip_not_allowed")
            ? "Session access needs to be checked before continuing."
            : error instanceof ApiError && error.status === 403
              ? "Administrator permission is required to export records."
              : error instanceof Error
                ? error.message
                : "The export could not be prepared. Try again.",
        );
      }
    } finally {
      if (started === exportGeneration.current) {
        setPreparing(false);
        exportController.current = null;
      }
    }
  }
  function download() {
    if (!exportRows || denied || !admin) return;
    const url = URL.createObjectURL(exportRows.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "records.csv";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  const sourceFailure =
    denied ||
    catalog.isError ||
    workspace.isError ||
    exportWorkspace.isError ||
    identity.isError;
  return (
    <div className="space-y-5">
      {identity.data && identity.data.role !== "admin" ? (
        <p role="alert" className="text-destructive text-sm">
          Administrator permission is required to import and export records.
        </p>
      ) : null}
      {sourceFailure ? (
        <div className="space-y-3">
          <p role="alert" className="text-destructive text-sm">
            Module options could not be loaded. Your draft has been kept.
          </p>
          <Action
            onClick={() => {
              void identity.refetch();
              void catalog.refetch();
              if (moduleId) void workspace.refetch();
              if (exportModuleId) void exportWorkspace.refetch();
            }}
            disabled={
              catalog.isFetching ||
              workspace.isFetching ||
              exportWorkspace.isFetching
            }
          >
            Retry
          </Action>
        </div>
      ) : null}
      {catalog.isPending && admin ? (
        <p role="status" className="text-muted-foreground text-sm">
          Loading modules…
        </p>
      ) : null}
      {collectionError ? (
        <p role="alert" className="text-destructive text-sm">
          {collectionError}
        </p>
      ) : null}
      {!denied && catalog.data?.hasMore ? (
        <Action
          disabled={loadingMore || busy}
          onClick={() => void loadMore("modules")}
        >
          Load more modules
        </Action>
      ) : null}
      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2">
        <Panel title="Import records">
          <p className="text-muted-foreground text-sm">
            Upload a UTF-8 CSV, map its columns and validate the rows before
            creating records. Up to 10,000 data rows and 8 MB.
          </p>
          <Choice
            label="Import module"
            value={moduleId}
            disabled={locked || denied || catalog.isPending}
            onChange={(event) => {
              setModuleId(event.target.value);
              importer.reset();
              setMapping({});
              setDefaultFields({});
              setDefaultValues({});
              setDefaultErrors({});
              setValidationPage(0);
            }}
          >
            <option value="">Choose a module</option>
            {sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name}
              </option>
            ))}
          </Choice>
          <Field>
            <FieldLabel htmlFor="platform-csv">CSV file</FieldLabel>
            <FilePickerButton
              key={moduleId}
              id="platform-csv"
              accept=".csv,text/csv"
              disabled={locked || !moduleId || denied}
              onFiles={(chosen) => {
                setMapping({});
                setDefaultFields({});
                setDefaultValues({});
                setDefaultErrors({});
                setValidationPage(0);
                void importer.readFile(chosen[0]);
              }}
            >
              Choose CSV file
            </FilePickerButton>
          </Field>
          {importer.csv ? (
            <div className="bg-muted/30 rounded-lg border p-4 text-sm">
              <strong>{importer.csv.name}</strong>
              <p className="text-muted-foreground mt-1">
                {importer.csv.rows.length} data rows ·{" "}
                {importer.csv.headers.length} columns
              </p>
            </div>
          ) : null}
          {moduleId && workspace.isPending ? (
            <p role="status" className="text-muted-foreground text-sm">
              Loading module fields…
            </p>
          ) : null}
          {importer.csv && !denied ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {importer.csv.headers.map((header, index) => (
                <Choice
                  key={index}
                  label={`Map column ${index + 1} · ${header || "Unnamed"}`}
                  value={mapping[index] ?? ""}
                  disabled={locked || workspace.isPending || workspace.isError}
                  onChange={(event) => {
                    setMapping((previous) => ({
                      ...previous,
                      [index]: event.target.value,
                    }));
                    importer.invalidatePreview();
                  }}
                >
                  <option value="">Unmapped</option>
                  {fields.map((field) => (
                    <option
                      key={field.id}
                      value={field.id}
                      disabled={Object.entries(mapping).some(
                        ([other, id]) =>
                          Number(other) !== index && id === field.id,
                      )}
                    >
                      {field.name} · {field.type}
                    </option>
                  ))}
                </Choice>
              ))}
            </div>
          ) : null}
          {!denied && workspace.data?.fieldsHasMore ? (
            <>
              <p className="text-muted-foreground text-sm">
                Load the remaining fields before validating this module.
              </p>
              <Action
                disabled={loadingMore || locked}
                onClick={() => void loadMore("fields")}
              >
                Load more fields
              </Action>
            </>
          ) : null}
          {importer.csv && !denied && unmapped.length ? (
            <div className="space-y-4">
              <h3 className="font-medium">Defaults for unmapped fields</h3>
              <p className="text-muted-foreground text-sm">
                Mapped blank cells keep their CSV meaning. Defaults here apply
                only to unmapped fields; other defaults come from the module.
              </p>
              {unmapped.map((field) => (
                <div key={field.id} className="space-y-3 rounded-lg border p-3">
                  <Toggle
                    label={`Use default for ${field.name}`}
                    checked={defaultFields[field.id] ?? false}
                    disabled={locked}
                    onCheckedChange={(checked) => {
                      setDefaultFields((previous) => ({
                        ...previous,
                        [field.id]: checked,
                      }));
                      importer.invalidatePreview();
                    }}
                  />
                  {defaultFields[field.id] ? (
                    <RecordFormFields
                      moduleId={moduleId}
                      fields={[field]}
                      values={{
                        [field.id]:
                          defaultValues[field.id] ??
                          toFormValue(field, field.config.defaultValue ?? null),
                      }}
                      errors={defaultErrors}
                      disabled={locked}
                      onChange={(id, value) => {
                        setDefaultValues((previous) => ({
                          ...previous,
                          [id]: value,
                        }));
                        importer.invalidatePreview();
                      }}
                    />
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          <Action
            disabled={
              locked ||
              !importer.csv ||
              !fields.length ||
              Boolean(workspace.data?.fieldsHasMore) ||
              workspace.isError ||
              denied
            }
            onClick={() => {
              const config = configuration();
              if (config) {
                setValidationPage(0);
                void importer.previewImport(config);
              }
            }}
          >
            {importer.operation === "preview"
              ? "Validating rows…"
              : "Preview import"}
          </Action>
          {importer.preview && !denied ? (
            <div className="space-y-4">
              <h3 className="font-medium">Import validation</h3>
              <p className="text-sm">
                {previewValid} valid rows · {invalid.length} invalid{" "}
                {invalid.length === 1 ? "row" : "rows"}
              </p>
              <p className="text-muted-foreground text-sm">
                Valid rows create live records. Invalid rows are excluded.
              </p>
              <p className="text-muted-foreground text-xs">
                Showing the first ten validated rows and their normalized
                values.
              </p>
              <div className="overflow-x-auto">
                <Table aria-label="Validated import rows">
                  <TableHeader>
                    <TableRow>
                      <TableHead>CSV row</TableHead>
                      {previewColumns.map((field) => (
                        <TableHead key={field.id}>{field.name}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {importer.preview.rows
                      .filter((row) => row.status !== "invalid")
                      .slice(0, 10)
                      .map((row) => (
                        <TableRow key={row.row_number}>
                          <TableCell>{row.row_number}</TableCell>
                          {previewColumns.map((field) => (
                            <TableCell key={field.id}>
                              {row.data[field.id] === null ||
                              row.data[field.id] === undefined
                                ? "—"
                                : String(row.data[field.id])}
                            </TableCell>
                          ))}
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </div>
              <div className="space-y-2">
                {invalid
                  .slice(validationPage * 25, (validationPage + 1) * 25)
                  .map((row) => (
                    <div
                      key={row.row_number}
                      className="text-destructive rounded-lg border p-3 text-sm"
                    >
                      {row.errors.map((error, index) => (
                        <p key={index}>
                          Row {row.row_number}: {error.message}
                        </p>
                      ))}
                    </div>
                  ))}
              </div>
              {invalid.length > 25 ? (
                <PaginationControls
                  ariaLabel="Import validation error pages"
                  pageCount={Math.ceil(invalid.length / 25)}
                  pageIndex={validationPage}
                  onPageIndexChange={setValidationPage}
                />
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Action
                  variant="default"
                  disabled={locked || !importer.validRemaining || denied}
                  onClick={() => {
                    const config = configuration();
                    if (config) void importer.importRecords(config);
                  }}
                >
                  {importer.operation === "import"
                    ? "Importing rows…"
                    : `Import ${importer.validRemaining} valid rows`}
                </Action>
                <Action disabled={importer.stopping} onClick={importer.cancel}>
                  Cancel import
                </Action>
              </div>
            </div>
          ) : null}
          {importer.operation === "preview" ? (
            <Action onClick={importer.cancel}>Cancel import</Action>
          ) : null}
          {importer.stopping ? (
            <p role="status" className="text-muted-foreground text-sm">
              Stopping after the current batch…
            </p>
          ) : null}
          {importer.error ? (
            <p role="alert" className="text-destructive text-sm">
              {importer.error}
            </p>
          ) : null}
          {importer.notice ? (
            <p role="status" className="bg-muted rounded-lg p-3 text-sm">
              {importer.notice}
            </p>
          ) : null}
          {importer.confirmed.size ? (
            <details>
              <summary className="min-h-11 cursor-pointer py-3 text-sm">
                Confirmed record IDs ({importer.confirmed.size})
              </summary>
              <ul className="text-muted-foreground max-h-48 overflow-y-auto text-xs">
                {[...importer.confirmed].map(([row, id]) => (
                  <li key={row}>
                    Row {row}: {id}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </Panel>
        <Panel title="Export records">
          <p className="text-muted-foreground text-sm">
            Export the complete module or saved-view query as CSV. The preview
            shows the first ten records; the download includes every exported
            record, up to 10,000 rows and 8 MB.
          </p>
          <Choice
            label="Export module"
            value={exportModuleId}
            disabled={preparing || !admin || denied || catalog.isPending}
            onChange={(event) => {
              clearExport();
              setExportModuleId(event.target.value);
              setViewId("");
            }}
          >
            <option value="">Choose a module</option>
            {sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name}
              </option>
            ))}
          </Choice>
          <Choice
            label="Saved view"
            value={viewId}
            disabled={
              preparing ||
              !exportModuleId ||
              exportWorkspace.isPending ||
              exportWorkspace.isError ||
              denied
            }
            onChange={(event) => {
              clearExport();
              setViewId(event.target.value);
            }}
          >
            <option value="">All records · all fields</option>
            {views.map((view) => (
              <option key={view.id} value={view.id}>
                {view.name}
              </option>
            ))}
          </Choice>
          {!denied && exportWorkspace.data?.viewsHasMore ? (
            <Action
              disabled={loadingMore || preparing}
              onClick={() => void loadMore("views", exportModuleId)}
            >
              Load more saved views
            </Action>
          ) : null}
          {!denied && exportWorkspace.data?.fieldsHasMore && !viewId ? (
            <Action
              disabled={loadingMore || preparing}
              onClick={() => void loadMore("fields", exportModuleId)}
            >
              Load more export fields
            </Action>
          ) : null}
          <Action
            disabled={
              preparing ||
              !exportModuleId ||
              exportWorkspace.isPending ||
              exportWorkspace.isError ||
              !admin ||
              denied
            }
            onClick={() => void previewExport()}
          >
            {preparing ? "Preparing export…" : "Preview export"}
          </Action>
          {preparing ? (
            <Action onClick={clearExport}>Cancel export</Action>
          ) : null}
          {exportError ? (
            <p role="alert" className="text-destructive text-sm">
              {exportError}
            </p>
          ) : null}
          {exportRows && !denied && admin ? (
            <div className="space-y-4">
              <p className="text-sm">
                {exportRows.count} records ready · showing the first{" "}
                {exportRows.rows.length}.
              </p>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {exportRows.headers.map((header, index) => (
                        <TableHead key={index}>{header}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {exportRows.rows.map((row) => (
                      <TableRow key={row[0]}>
                        {row.map((cell, index) => (
                          <TableCell key={index}>{cell}</TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="text-muted-foreground text-sm">
                CSV contains displayed values. Date formatting, labels and
                formula protection may differ from the values needed for import.
              </p>
              <div className="flex flex-wrap gap-2">
                <Action variant="default" onClick={download}>
                  Download CSV
                </Action>
                <Action onClick={clearExport}>Cancel export</Action>
              </div>
            </div>
          ) : null}
        </Panel>
      </div>
      <Dialog
        open={Boolean(importer.leave)}
        onOpenChange={(open) => {
          if (!open) importer.stay();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stop import and leave?</DialogTitle>
            <DialogDescription>
              The current batch must finish before leaving. Confirmed records
              remain; later batches will not be sent.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Action onClick={importer.stay}>Stay</Action>
            <Action
              onClick={importer.stopAndLeave}
              disabled={importer.stopping}
            >
              Stop and leave
            </Action>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
