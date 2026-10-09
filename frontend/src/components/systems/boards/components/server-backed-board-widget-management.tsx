"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  canMutateBoardWidgets,
  useBoardWidgetManagement,
  widgetQueryUnchanged,
} from "../hooks/use-board-widget-management";
import { useQuery } from "@tanstack/react-query";
import { ChartSourceEditor } from "../../openview/components/chart-editor/chart-source-editor";
import {
  changeChartEditorWidgetType,
  newChartEditorDraft,
} from "../../openview/domain/chart-query";
import {
  compileBoardWidgetDraft,
  createWidgetInput,
} from "../domain/widget-editor";
import { useOpenViewAccessDenied } from "../../openview/adapters/openview-access";
import {
  fieldsFirstPageOptions,
  extendsRead,
  readStamp,
} from "../../openview/adapters/openview-queries";
import {
  listOpenViewDataSourceFields,
  type OpenViewDataSourceField,
} from "../../openview/adapters/views-api";
import { ConfirmAction } from "./ui";

export function ServerBoardWidgetManagement({
  boardId,
  boardActive,
  refreshKey,
  onChanged,
  onBoardRefresh,
  onAccessDenied,
}: {
  boardId: string;
  boardActive: boolean;
  refreshKey: number;
  onChanged?: () => void;
  onBoardRefresh: () => void | Promise<void>;
  onAccessDenied: (boardId: string) => void;
}) {
  const manager = useBoardWidgetManagement({
    boardId,
    boardActive,
    refreshKey,
    onChanged,
    onBoardRefresh,
    onAccessDenied,
  });
  const [removing, setRemoving] = useState<{
    boardId: string;
    widgetId: string;
  } | null>(null);
  const nameId = useId();
  const widgetTypeId = useId();
  const sourceId = useId();
  const settingsNameId = useId();
  const sizeId = useId();
  const pinnedId = useId();
  const { state, sources } = manager;
  const queryReadDenied = useOpenViewAccessDenied();
  const visibleSources = queryReadDenied ? [] : sources.items;
  const snapshot = state.status === "ready" ? state.snapshot : null;
  const canEdit = boardActive && !!snapshot?.access.manage;
  const busy = state.pending || state.status === "loading";
  const canMutate = canMutateBoardWidgets(state, boardActive);
  const mutationBlocked = busy || !canMutate;
  const editor = state.draft?.query ?? state.creation.query;
  const queryModule = editor.chartId === null ? editor.inline.moduleId : "";
  const fieldsQuery = useQuery(fieldsFirstPageOptions(queryModule));
  const [moreFields, setMoreFields] = useState<{
    moduleId: string;
    readAt: number;
    items: OpenViewDataSourceField[];
    hasMore: boolean;
  } | null>(null);
  const [fieldsError, setFieldsError] = useState("");
  const [fieldsPending, setFieldsPending] = useState(false);
  const [refusedChartId, setRefusedChartId] = useState<string | null>(null);
  const extension =
    moreFields?.moduleId === queryModule &&
    extendsRead(moreFields.readAt, fieldsQuery)
      ? moreFields
      : null;
  const queryFields =
    queryReadDenied || fieldsQuery.error
      ? []
      : [...(fieldsQuery.data?.items ?? []), ...(extension?.items ?? [])];
  async function loadMoreFields() {
    if (fieldsPending || !queryModule) return;
    setFieldsPending(true);
    setFieldsError("");
    try {
      const page = await listOpenViewDataSourceFields(queryModule, {
        limit: 100,
        offset: queryFields.length,
      });
      setMoreFields({
        moduleId: queryModule,
        readAt: readStamp(fieldsQuery),
        items: [...(extension?.items ?? []), ...page.items],
        hasMore: page.pagination.hasMore,
      });
    } catch {
      setFieldsError("More fields could not be loaded. Retry fields.");
    } finally {
      setFieldsPending(false);
    }
  }

  useEffect(() => {
    setRemoving(null);
  }, [boardId, state.status, state.conflict, state.archiveLocked]);

  function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (queryReadDenied) return;
    manager.createWidget(queryFields, () => setRefusedChartId(editor.chartId));
  }

  function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.draft?.query && queryReadDenied) return;
    manager.saveSettings(queryFields, () =>
      setRefusedChartId(state.draft?.query?.chartId ?? null),
    );
  }

  return (
    <section aria-label="Manage Board widgets" className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 data-slot="section-title" className="text-lg font-semibold">
            Manage widgets
          </h2>
          <p className="text-muted-foreground text-sm">
            Everyone who can read this Board sees these widgets.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={busy}
          onClick={manager.reload}
        >
          Reload widgets
        </Button>
      </div>

      {state.status === "loading" && (
        <p role="status" className="text-muted-foreground text-sm">
          Loading widget controls…
        </p>
      )}
      {state.error && (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      )}
      {state.notice && (
        <p role="status" className="text-sm">
          {state.notice}
        </p>
      )}
      {state.status === "denied" && (
        <p className="text-muted-foreground text-sm">
          Widget details were cleared. Check your access or retry.
        </p>
      )}
      {state.status === "error" && (
        <p className="text-muted-foreground text-sm">
          Widget controls are unavailable until the latest list loads.
        </p>
      )}
      {state.archiveLocked && (
        <p role="alert" className="text-muted-foreground text-sm">
          The Board was archived. Widget changes are locked; restore the Board
          before editing. The Board status is being refreshed.
        </p>
      )}
      {state.conflict && (
        <p role="alert" className="text-muted-foreground text-sm">
          Widget actions are paused after a conflict.{" "}
          {state.draft
            ? "Your settings draft is retained. Cancel it and reopen settings before retrying."
            : "Reload the widgets before retrying."}
        </p>
      )}
      {snapshot && !boardActive && (
        <p className="text-muted-foreground text-sm">
          Restore this Board before changing widgets.
        </p>
      )}
      {snapshot && !snapshot.access.manage && (
        <p className="text-muted-foreground text-sm">
          You can view these widgets. Only Board managers change them.
        </p>
      )}

      {snapshot && (
        <ol className="space-y-3">
          {snapshot.page.items.map((widget, index) => (
            <li
              key={widget.id}
              className="border-border bg-card rounded-xl border p-4"
            >
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-medium break-words">{widget.name}</h3>
                  <p className="text-muted-foreground text-sm">
                    {widget.widgetType}
                    {widget.pinned ? " · Pinned" : ""}
                  </p>
                </div>
                {canEdit && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={mutationBlocked}
                      onClick={() => manager.edit(widget.id)}
                      aria-label={`Edit ${widget.name} settings`}
                    >
                      Settings
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={mutationBlocked || index === 0}
                      onClick={() => manager.move(widget.id, -1)}
                      aria-label={`Move ${widget.name} earlier`}
                    >
                      Earlier
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={
                        mutationBlocked ||
                        index === snapshot.page.items.length - 1
                      }
                      onClick={() => manager.move(widget.id, 1)}
                      aria-label={`Move ${widget.name} later`}
                    >
                      Later
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={
                        mutationBlocked || snapshot.page.items.length >= 12
                      }
                      onClick={() => manager.duplicate(widget.id)}
                      aria-label={`Duplicate ${widget.name}`}
                    >
                      Duplicate
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={mutationBlocked}
                      onClick={() =>
                        setRemoving({ boardId, widgetId: widget.id })
                      }
                      aria-label={`Remove ${widget.name}`}
                    >
                      Remove
                    </Button>
                  </div>
                )}
              </div>
            </li>
          ))}
          {snapshot.page.items.length === 0 && (
            <li className="text-muted-foreground rounded-xl border border-dashed p-4 text-sm">
              This Board has no widgets.
            </li>
          )}
        </ol>
      )}

      {canEdit ? (
        <form
          data-slot="card"
          key={state.draft?.source.id ?? "create"}
          onSubmit={state.draft ? onSave : onCreate}
          className="min-w-0 space-y-4 border-t pt-5"
        >
          <h3 data-slot="section-title" className="font-medium">
            {state.draft ? "Widget settings" : "Add widget"}
          </h3>
          <div className="space-y-1">
            <label
              htmlFor={state.draft ? settingsNameId : nameId}
              className="text-sm font-medium"
            >
              Widget name
            </label>
            <Input
              id={state.draft ? settingsNameId : nameId}
              value={state.draft?.name ?? state.creation.name}
              className="min-h-11"
              maxLength={80}
              required
              disabled={mutationBlocked}
              onChange={(event) =>
                state.draft
                  ? manager.changeDraft({ name: event.target.value })
                  : manager.changeCreation({ name: event.target.value })
              }
            />
          </div>
          <div className="space-y-1">
            <label htmlFor={widgetTypeId} className="text-sm font-medium">
              Widget type
            </label>
            <select
              id={widgetTypeId}
              data-slot="select"
              value={state.draft?.source.widgetType ?? editor.inline.widgetType}
              disabled={mutationBlocked || !!state.draft}
              className="border-input bg-card text-foreground focus-visible:outline-ring min-h-11 w-full rounded-md border px-3 text-sm focus-visible:outline-2"
              onChange={(event) =>
                manager.changeCreation({
                  query: {
                    ...editor,
                    chartId: null,
                    inline: changeChartEditorWidgetType(
                      editor.inline,
                      event.target.value as typeof editor.inline.widgetType,
                      queryFields,
                    ),
                  },
                })
              }
            >
              <option value="summary">Summary</option>
              <option value="workload">Workload</option>
              <option value="records">Records</option>
              <option value="chart">Chart</option>
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor={sizeId} className="text-sm font-medium">
              Size
            </label>
            <select
              data-slot="select"
              id={sizeId}
              value={state.draft?.size ?? state.creation.size}
              disabled={mutationBlocked}
              onChange={(event) =>
                (state.draft ? manager.changeDraft : manager.changeCreation)({
                  size: event.target.value as "S" | "M" | "L",
                })
              }
              className="border-input bg-card text-foreground focus-visible:outline-ring min-h-11 w-full rounded-md border px-3 text-sm focus-visible:outline-2"
            >
              <option value="S">Small</option>
              <option value="M">Medium</option>
              <option value="L">Large</option>
            </select>
            <p className="text-muted-foreground text-xs">
              Cards adapt to the available space.
            </p>
          </div>
          <label
            htmlFor={pinnedId}
            className="flex min-h-11 items-center gap-3 text-sm"
          >
            <input
              id={pinnedId}
              type="checkbox"
              checked={state.draft?.pinned ?? state.creation.pinned}
              disabled={mutationBlocked}
              onChange={(event) =>
                (state.draft ? manager.changeDraft : manager.changeCreation)({
                  pinned: event.target.checked,
                })
              }
            />
            Pin this widget
          </label>
          {state.draft?.source.widgetType === "summary" &&
          state.draft.source.config &&
          "fields" in state.draft.source.config ? (
            <p className="text-muted-foreground text-sm">
              This legacy Summary counts all matching records. Editing filters
              keeps that count; choosing a Group by field explicitly replaces it
              with a grouped query.
            </p>
          ) : null}
          {!state.draft && editor.chartId !== null ? (
            <div className="space-y-2">
              <label htmlFor={sourceId} className="text-sm font-medium">
                Data source
              </label>
              <select
                id={sourceId}
                data-slot="select"
                value={editor.inline.moduleId}
                className="border-input bg-card text-foreground focus-visible:outline-ring min-h-11 w-full rounded-md border px-3 text-sm focus-visible:outline-2"
                disabled={
                  mutationBlocked ||
                  queryReadDenied ||
                  sources.status !== "ready"
                }
                onChange={(event) => {
                  setRefusedChartId(null);
                  manager.changeCreation({
                    query: {
                      chartId: "",
                      inline: changeChartEditorWidgetType(
                        newChartEditorDraft(event.target.value, []),
                        editor.inline.widgetType,
                        [],
                      ),
                    },
                  });
                }}
              >
                <option value="">Choose a data source</option>
                {visibleSources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                  </option>
                ))}
              </select>
              {sources.status === "loading" ? (
                <p role="status" className="text-muted-foreground text-sm">
                  Loading record sources…
                </p>
              ) : null}
              {sources.error ? (
                <p role="alert" className="text-destructive text-sm">
                  {sources.error}
                </p>
              ) : null}
              {sources.error || sources.hasMore ? (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={mutationBlocked || sources.status === "loading"}
                  onClick={
                    sources.error ? manager.reload : manager.loadMoreSources
                  }
                >
                  {sources.error ? "Retry sources" : "Load more sources"}
                </Button>
              ) : null}
            </div>
          ) : null}
          <ChartSourceEditor
            refusedChartId={refusedChartId}
            onRetrySource={() => setRefusedChartId(null)}
            value={editor}
            onChange={(query) => {
              setRefusedChartId(null);
              if (state.draft) manager.changeDraft({ query });
              else manager.changeCreation({ query });
            }}
            disabled={mutationBlocked}
            restrictModule
            catalog={{
              sources: state.draft
                ? visibleSources.filter(
                    (source) => source.id === state.draft?.source.moduleId,
                  )
                : visibleSources,
              sourcesLoading: sources.status === "loading",
              sourcesError: queryReadDenied
                ? "The source catalog is unavailable. Retry fields or catalog."
                : (sources.error ?? ""),
              sourcesHasMore:
                !state.draft && sources.hasMore && !queryReadDenied,
              fields: queryFields,
              fieldsLoading: fieldsQuery.isPending && !!queryModule,
              fieldsError:
                queryReadDenied || fieldsQuery.error
                  ? "The field catalog is unavailable. Retry fields."
                  : fieldsError,
              fieldsHasMore:
                !queryReadDenied &&
                (extension?.hasMore ??
                  fieldsQuery.data?.pagination.hasMore ??
                  false),
              metadataError: "",
              metadataRetryTarget: null,
              metadataLoading: fieldsPending,
              sourceName:
                visibleSources.find(
                  (source) => source.id === editor.inline.moduleId,
                )?.name ?? "Record source",
            }}
            actions={{
              retryCatalog: manager.reload,
              retryFields: () => {
                setFieldsError("");
                void fieldsQuery.refetch();
              },
              loadMoreSources: manager.loadMoreSources,
              loadMoreFields,
            }}
          >
            {(input) => (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  className="min-h-11"
                  disabled={
                    mutationBlocked ||
                    queryReadDenied ||
                    !(state.draft?.name ?? state.creation.name).trim() ||
                    (editor.chartId !== null
                      ? (!input &&
                          (!state.draft ||
                            !widgetQueryUnchanged(state.draft))) ||
                        refusedChartId === editor.chartId
                      : state.draft
                        ? !widgetQueryUnchanged(state.draft) &&
                          !compileBoardWidgetDraft(
                            state.draft.source,
                            editor.inline,
                            queryFields,
                          )
                        : !input ||
                          !createWidgetInput(state.creation, queryFields))
                  }
                >
                  {state.draft ? "Save settings" : "Add widget"}
                </Button>
                {state.draft ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={busy}
                    onClick={manager.cancelEdit}
                  >
                    Cancel
                  </Button>
                ) : null}
              </div>
            )}
          </ChartSourceEditor>
          {state.error ? (
            <p role="alert" className="text-destructive text-sm">
              {state.error}
            </p>
          ) : null}
          {state.conflict && (
            <p role="alert" className="text-destructive text-sm">
              This widget changed after you opened settings. Your draft is
              retained; cancel and reopen settings before saving.
            </p>
          )}
        </form>
      ) : null}

      <ConfirmAction
        open={
          !!removing &&
          removing.boardId === boardId &&
          canMutate &&
          !!snapshot?.page.items.some(
            (widget) => widget.id === removing.widgetId,
          )
        }
        title="Remove widget?"
        description="This removes the widget from the Board. Its source records are not deleted."
        action="Remove widget"
        disabled={!canMutate}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing?.boardId === boardId) manager.remove(removing.widgetId);
          setRemoving(null);
        }}
      />
    </section>
  );
}
