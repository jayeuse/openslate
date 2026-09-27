"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { BoardWidget } from "../adapters/board-widgets-api";
import {
  canMutateBoardWidgets,
  useBoardWidgetManagement,
} from "../hooks/use-board-widget-management";
import { ConfirmAction } from "./ui";

function audienceLabel(widget: BoardWidget): string {
  switch (widget.audience.kind) {
    case "private":
      return "Private to its creator";
    case "everyone":
      return "Everyone with Board access";
    case "role":
    case "user":
      return "Targeted audience";
  }
}

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
  const moduleId = useId();
  const audienceId = useId();
  const settingsNameId = useId();
  const sizeId = useId();
  const pinnedId = useId();
  const { state, sources } = manager;
  const snapshot = state.status === "ready" ? state.snapshot : null;
  const canEdit = boardActive && !!snapshot?.access.edit;
  const busy = state.pending || state.status === "loading";
  const canMutate = canMutateBoardWidgets(state, boardActive);
  const mutationBlocked = busy || !canMutate;

  useEffect(() => {
    setRemoving(null);
  }, [boardId, state.status, state.conflict, state.archiveLocked]);

  function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    manager.createSummary();
  }

  function onSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    manager.saveSettings();
  }

  return (
    <section aria-label="Manage Board widgets" className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 data-slot="section-title" className="text-lg font-semibold">
            Manage widgets
          </h2>
          <p className="text-muted-foreground text-sm">
            Only widgets visible to you can be edited or reordered.
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
      {snapshot && !snapshot.access.edit && (
        <p className="text-muted-foreground text-sm">
          You can view these widgets, but you cannot change them.
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
                    {widget.widgetType} · {audienceLabel(widget)}
                    {widget.config.pinned ? " · Pinned" : ""}
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
                      aria-label={`Duplicate ${widget.name} with the same audience`}
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
              No widgets are visible to you on this Board.
            </li>
          )}
        </ol>
      )}

      {canEdit && state.draft && (
        <form
          data-slot="card"
          onSubmit={onSave}
          className="border-card-edge bg-card shadow-card space-y-4 rounded-xl border p-4"
        >
          <h3 data-slot="section-title" className="font-medium">
            Widget settings
          </h3>
          <p className="text-muted-foreground text-sm">
            Audience: {audienceLabel(state.draft.source)}. These settings keep
            the widget’s existing audience.
          </p>
          <div className="space-y-1">
            <label htmlFor={settingsNameId} className="text-sm font-medium">
              Widget name
            </label>
            <Input
              id={settingsNameId}
              value={state.draft.name}
              maxLength={80}
              required
              disabled={mutationBlocked}
              onChange={(event) =>
                manager.changeDraft({ name: event.target.value })
              }
            />
          </div>
          <div className="space-y-1">
            <label htmlFor={sizeId} className="text-sm font-medium">
              Size
            </label>
            <select
              data-slot="select"
              id={sizeId}
              value={state.draft.size}
              disabled={mutationBlocked}
              onChange={(event) =>
                manager.changeDraft({
                  size: event.target.value as "half" | "full",
                })
              }
              className="border-input bg-card text-foreground focus-visible:outline-ring min-h-11 w-full rounded-md border px-3 text-sm focus-visible:outline-2"
            >
              <option value="half">Standard</option>
              <option value="full">Full width</option>
            </select>
            <p className="text-muted-foreground text-xs">
              Standard cards adapt to the available space.
            </p>
          </div>
          <label
            htmlFor={pinnedId}
            className="flex min-h-11 items-center gap-3 text-sm"
          >
            <input
              id={pinnedId}
              type="checkbox"
              checked={state.draft.pinned}
              disabled={mutationBlocked}
              onChange={(event) =>
                manager.changeDraft({ pinned: event.target.checked })
              }
            />
            Pin this widget
          </label>
          {state.conflict && (
            <p role="alert" className="text-destructive text-sm">
              This widget changed after you opened settings. Your draft is
              retained; cancel and reopen settings before saving.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              className="min-h-11"
              disabled={mutationBlocked || !state.draft.name.trim()}
            >
              Save settings
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={busy}
              onClick={manager.cancelEdit}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}

      {canEdit && (
        <form
          data-slot="card"
          onSubmit={onCreate}
          className="border-card-edge bg-card shadow-card space-y-4 rounded-xl border p-4"
        >
          <div>
            <h3 data-slot="section-title" className="font-medium">
              Add summary widget
            </h3>
            <p className="text-muted-foreground text-sm">
              New widgets start private. Share with everyone on this Board only
              if you choose it below.
            </p>
          </div>
          <div className="space-y-1">
            <label htmlFor={nameId} className="text-sm font-medium">
              Widget name
            </label>
            <Input
              id={nameId}
              value={state.summary.name}
              maxLength={80}
              required
              disabled={mutationBlocked}
              onChange={(event) =>
                manager.changeSummary({ name: event.target.value })
              }
            />
          </div>
          <div className="space-y-1">
            <label htmlFor={moduleId} className="text-sm font-medium">
              Active record source
            </label>
            <select
              data-slot="select"
              id={moduleId}
              value={
                sources.items.some((item) => item.id === state.summary.moduleId)
                  ? state.summary.moduleId
                  : ""
              }
              disabled={mutationBlocked || sources.status !== "ready"}
              required
              onChange={(event) =>
                manager.changeSummary({ moduleId: event.target.value })
              }
              className="border-input bg-card text-foreground focus-visible:outline-ring min-h-11 w-full rounded-md border px-3 text-sm focus-visible:outline-2"
            >
              <option value="">Choose an active source</option>
              {sources.items.map((source) => (
                <option value={source.id} key={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
            {sources.status === "loading" && (
              <p role="status" className="text-muted-foreground text-sm">
                Loading active sources…
              </p>
            )}
            {sources.error && (
              <p role="alert" className="text-destructive text-sm">
                {sources.error}
              </p>
            )}
            {sources.status === "ready" && sources.items.length === 0 && (
              <p className="text-muted-foreground text-sm">
                No active record sources are available.
              </p>
            )}
            {sources.hasMore && (
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={mutationBlocked || sources.status !== "ready"}
                onClick={() => void manager.loadMoreSources()}
              >
                Load more sources
              </Button>
            )}
          </div>
          <label
            htmlFor={audienceId}
            className="flex min-h-11 items-center gap-3 text-sm"
          >
            <input
              id={audienceId}
              type="checkbox"
              checked={state.summary.everyone}
              disabled={mutationBlocked}
              onChange={(event) =>
                manager.changeSummary({ everyone: event.target.checked })
              }
            />
            Everyone with Board access can see this widget
          </label>
          <Button
            type="submit"
            className="min-h-11"
            disabled={
              mutationBlocked ||
              sources.status !== "ready" ||
              !state.summary.name.trim() ||
              !sources.items.some(
                (source) => source.id === state.summary.moduleId,
              )
            }
          >
            Add summary widget
          </Button>
        </form>
      )}

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
