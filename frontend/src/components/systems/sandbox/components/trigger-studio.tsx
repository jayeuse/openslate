"use client";

import { useEffect, useRef, useState } from "react";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ChevronDown, ChevronLeft, MoreHorizontal, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import type { SandboxTrigger, SandboxDocumentDesign } from "../domain/document";
import type { SandboxTriggerRun } from "../state/api";
import type { TriggerDraft } from "./use-trigger-draft";
import {
  defaultTrigger,
  replaceAt,
  triggerStepErrors,
} from "../domain/trigger-rules";
import {
  filterTriggers,
  TriggerList,
  triggerDisplayName,
  type TriggerStatusFilter,
} from "./trigger-list";
import { TriggerRail } from "./trigger-rail";

// Triggers (docs/specs/sandbox-relayout.md S5): two panes, the list and the
// detail of one trigger. The detail is Name, Status, and the When/If/Then
// rail, then Recent activity, closed and last; the Save bar (October D1)
// sits under it while changes exist.

export type TriggerStudioProps = {
  design: SandboxDocumentDesign;
  /** The unsaved edits; the page owns them (see `useTriggerDraft`). */
  triggerDraft: TriggerDraft;
  runs: readonly SandboxTriggerRun[];
  activity: { loading: boolean; error: string };
  initialSelectedId?: string;
  /** The list's first quick filter, from a link ("Show" on Build's triggers that are off). */
  initialStatus?: TriggerStatusFilter;
  onRefreshActivity: () => Promise<void>;
};

/** The flow steps of a trigger, keyed as `triggerStepErrors` keys them. */
function stepKeys(recordTrigger: SandboxTrigger): string[] {
  return [
    "trigger",
    ...recordTrigger.conditionGroup.conditions.map(
      (condition) => `condition:${condition.id}`,
    ),
    ...recordTrigger.actions.map((action) => `action:${action.id}`),
  ];
}

export function triggerRunStatus(run: SandboxTriggerRun): string {
  if (run.details.budgetExhausted === true)
    return "Incomplete — action limit reached";
  if (run.state === "succeeded" && run.details.actionsApplied === 0)
    return "No change needed";
  if (run.state === "succeeded") return "Completed";
  if (run.state === "skipped") return "No change needed";
  if (run.state === "suspended") return "Paused";
  return "Could not complete";
}

function runDetail(run: SandboxTriggerRun): string {
  const actions = run.details.actionsApplied;
  const records = run.details.recordsMatched;
  if (typeof actions === "number" && typeof records === "number")
    return `${actions} change${actions === 1 ? "" : "s"} across ${records} matching item${records === 1 ? "" : "s"}`;
  if (run.state === "failed")
    return `Stopped after ${run.attempts} attempt${run.attempts === 1 ? "" : "s"}`;
  return "The run finished without exposing record data.";
}

export function TriggerStudio({
  design,
  triggerDraft,
  runs,
  activity,
  initialSelectedId,
  initialStatus = "all",
  onRefreshActivity,
}: TriggerStudioProps) {
  const { draft, dirty, pending, error } = triggerDraft;
  const studioRef = useRef<HTMLElement>(null);
  const [wide, setWide] = useState(false);
  // Phones show the list or one trigger's detail, with Back (TRG-5).
  const [phone, setPhone] = useState(false);
  const [phoneView, setPhoneView] = useState<"list" | "detail">(
    initialSelectedId ? "detail" : "list",
  );
  useEffect(() => {
    const element = studioRef.current;
    if (!element) return;
    let measured = false;
    let wasPhone = false;
    const observer = new ResizeObserver(([entry]) => {
      const nextPhone = entry.contentRect.width < 640;
      // A window that narrows mid-edit keeps the trigger in view; only a
      // page that opens narrow starts on the list.
      if (measured && nextPhone && !wasPhone) setPhoneView("detail");
      measured = true;
      wasPhone = nextPhone;
      setWide(entry.contentRect.width >= 900);
      setPhone(nextPhone);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const detailBodyRef = useRef<HTMLDivElement>(null);
  // A link that asks for a filter opens on the first trigger it shows.
  const [selectedId, setSelectedId] = useState(
    initialSelectedId && draft.some((item) => item.id === initialSelectedId)
      ? initialSelectedId
      : (filterTriggers(draft, { query: "", status: initialStatus })[0]?.id ??
          draft[0]?.id ??
          ""),
  );
  // The list's quick filter. It never hides the trigger a link opens: such
  // a link starts it, or sets it back, on All.
  const hides = (status: TriggerStatusFilter, id: string | undefined) =>
    Boolean(id) &&
    !filterTriggers(draft, { query: "", status }).some(
      (item) => item.id === id,
    );
  const [listStatus, setListStatus] = useState<TriggerStatusFilter>(() =>
    hides(initialStatus, selectedId) ? "all" : initialStatus,
  );
  const requestedSelection = useRef(initialSelectedId);
  useEffect(() => {
    if (selectedId && draft.some((item) => item.id === selectedId)) return;
    setSelectedId(draft[0]?.id ?? "");
  }, [draft, selectedId]);
  useEffect(() => {
    if (requestedSelection.current === initialSelectedId) return;
    requestedSelection.current = initialSelectedId;
    if (
      initialSelectedId &&
      draft.some((item) => item.id === initialSelectedId)
    ) {
      setSelectedId(initialSelectedId);
      setListStatus((status) =>
        hides(status, initialSelectedId) ? "all" : status,
      );
    }
  }, [draft, initialSelectedId]);
  // Another trigger opens at its top, not at the last one's scroll (F10).
  useEffect(() => {
    detailBodyRef.current?.scrollTo({ top: 0 });
  }, [selectedId]);
  const selected = draft.find((item) => item.id === selectedId);
  const updateDraft = triggerDraft.update;
  // New steps keep a required-value note quiet until they are changed or
  // left, or Save is tried (S25), keyed "<trigger id>/<step key>".
  const [quietSteps, setQuietSteps] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const quiet = (keys: readonly string[]) =>
    setQuietSteps((current) => new Set([...current, ...keys]));
  function touchStep(target: EventTarget) {
    const step = (target as HTMLElement).closest<HTMLElement>("[data-step-key]")
      ?.dataset.stepKey;
    const key = selected && step ? `${selected.id}/${step}` : "";
    if (!quietSteps.has(key)) return;
    setQuietSteps((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }
  const shownStepErrors = selected
    ? new Map(
        [...triggerStepErrors(selected, design)].filter(
          ([step]) => !quietSteps.has(`${selected.id}/${step}`),
        ),
      )
    : new Map<string, string>();
  function discard() {
    const snapshot = { edits: triggerDraft.discard(), selectedId };
    // Ends at the next edit or save: newer work is never replaced (S25).
    if (snapshot.edits)
      triggerDraft.offerUndo("Changes discarded", () => {
        if (snapshot.edits) triggerDraft.restore(snapshot.edits);
        setSelectedId(snapshot.selectedId);
      });
  }
  async function save() {
    setQuietSteps(new Set());
    await triggerDraft.save();
  }
  // A failed save brings its reason into view and to the screen reader.
  useEffect(() => {
    if (!error) return;
    requestAnimationFrame(() => {
      const alert =
        detailBodyRef.current?.querySelector<HTMLElement>("[role=alert]");
      alert?.scrollIntoView({ block: "nearest" });
      alert?.focus({ preventScroll: true });
    });
  }, [error]);
  // Ctrl+S (Cmd+S on a Mac) saves triggers while this section is open.
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s")
        return;
      event.preventDefault();
      void saveRef.current();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const listRef = useRef<HTMLElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  /**
   * On phones, opening a trigger shows the page from its top: the title and
   * the detail heading both whole, never cut by the app bar (S25).
   */
  function openDetail() {
    setPhoneView("detail");
    if (!phone) return;
    requestAnimationFrame(() => {
      studioRef.current
        ?.closest("[data-sandbox-page]")
        ?.scrollIntoView({ block: "start" });
      detailHeadingRef.current?.focus({ preventScroll: true });
    });
  }
  /**
   * Focuses the selected row; when a filter hides it, the first visible row;
   * New trigger only when no row shows.
   */
  function focusCurrentRow() {
    requestAnimationFrame(() =>
      (
        listRef.current?.querySelector<HTMLElement>("[aria-current=true]") ??
        listRef.current?.querySelector<HTMLElement>("[data-trigger-row]") ??
        listRef.current?.querySelector<HTMLElement>("button")
      )?.focus(),
    );
  }
  function deleteTrigger(recordTrigger: SandboxTrigger) {
    const index = draft.findIndex((item) => item.id === recordTrigger.id);
    const remaining = draft.filter((item) => item.id !== recordTrigger.id);
    updateDraft(remaining);
    // The menu that had focus is gone with the trigger; land on its
    // neighbor in the list.
    setSelectedId((remaining[index] ?? remaining[index - 1])?.id ?? "");
    setPhoneView("list");
    focusCurrentRow();
    // Ends at the next edit or save: a saved deletion stays deleted (S26).
    triggerDraft.offerUndo("Trigger deleted", () => {
      updateDraft((current) =>
        current.some((item) => item.id === recordTrigger.id)
          ? current
          : [
              ...current.slice(0, index),
              recordTrigger,
              ...current.slice(index),
            ],
      );
      setSelectedId(recordTrigger.id);
      focusCurrentRow();
    });
  }
  function update(next: SandboxTrigger) {
    const index = draft.findIndex((item) => item.id === next.id);
    if (index < 0) return;
    const before = new Set(stepKeys(draft[index]!));
    quiet(
      stepKeys(next)
        .filter((step) => !before.has(step))
        .map((step) => `${next.id}/${step}`),
    );
    updateDraft(replaceAt(draft, index, next));
  }
  // Recent activity is occasional: closed, last in the detail (the
  // Advanced Last Rule).
  const recentActivity = (
    <Collapsible className="border-border border-t pt-1">
      <h3>
        <CollapsibleTrigger className="focus-visible:outline-ring flex min-h-11 w-full cursor-pointer items-center justify-between text-sm font-medium focus-visible:outline-2">
          Recent activity
          <ChevronDown className="size-4" aria-hidden="true" />
        </CollapsibleTrigger>
      </h3>
      <CollapsibleContent keepMounted>
        <section
          aria-label="Recent activity details"
          className="mt-4 grid gap-3"
        >
          <div>
            <p className="text-muted-foreground mt-1 text-sm">
              See what published triggers did in the live workspace.
            </p>
            <Button
              variant="outline"
              className="mt-2 min-h-11"
              disabled={activity.loading}
              onClick={() => void onRefreshActivity()}
            >
              {activity.loading ? "Refreshing…" : "Refresh activity"}
            </Button>
          </div>
          {activity.error ? (
            <Alert variant="destructive">
              {activity.error}{" "}
              <Button
                variant="outline"
                size="sm"
                className="min-h-11"
                onClick={() => void onRefreshActivity()}
              >
                Retry
              </Button>
            </Alert>
          ) : null}
          {runs.length ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {runs.map((run) => (
                <Card key={run.id}>
                  <CardHeader className="gap-1">
                    <CardTitle className="text-base">
                      {run.triggerName}
                    </CardTitle>
                    <p className="text-muted-foreground text-xs">
                      <time dateTime={run.createdAt}>
                        {new Date(run.createdAt).toLocaleString()}
                      </time>
                    </p>
                  </CardHeader>
                  <CardContent className="grid gap-1 text-sm">
                    <p className="font-medium">{triggerRunStatus(run)}</p>
                    <p className="text-muted-foreground">{runDetail(run)}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : activity.loading ? (
            <p className="text-muted-foreground text-sm" role="status">
              Loading recent activity…
            </p>
          ) : activity.error ? null : (
            <p className="text-muted-foreground text-sm">
              No published trigger activity yet.
            </p>
          )}
        </section>
      </CollapsibleContent>
    </Collapsible>
  );
  // While edits kept from before a reload wait for Restore or Discard, the
  // studio is read-only, so nothing new can be typed over them.
  // Newer unsaved edits stay editable, so they can be saved or discarded
  // first (the prompt's Restore waits for that).
  const locked = triggerDraft.kept !== null && !dirty;
  const changes = triggerDraft.changes;
  return (
    <section
      ref={studioRef}
      aria-labelledby="trigger-studio-title"
      className="@container/studio flex h-full min-w-0 flex-col"
    >
      {locked ? (
        <p role="status" className="text-warn-text mb-3 text-sm">
          Restore or discard the kept trigger changes above to edit.
        </p>
      ) : null}
      <fieldset disabled={locked} className="contents">
        <div className="min-w-0 shrink-0 @min-[900px]/studio:h-[calc(100dvh-15rem)] xl:@min-[900px]/studio:h-auto xl:@min-[900px]/studio:min-h-0 xl:@min-[900px]/studio:flex-1 xl:@min-[900px]/studio:shrink">
          <ResizablePanelGroup
            orientation="horizontal"
            disabled={!wide}
            className="block! h-auto! overflow-visible! @min-[900px]/studio:flex! @min-[900px]/studio:h-full! @min-[900px]/studio:overflow-hidden!"
          >
            <ResizablePanel
              id="trigger-list"
              defaultSize="24rem"
              minSize={wide ? "20rem" : 0}
              groupResizeBehavior="preserve-pixel-size"
              className={cn(
                "min-w-0 overflow-visible! @min-[900px]/studio:h-full @min-[900px]/studio:overflow-hidden!",
                phone && phoneView === "detail" && "hidden",
              )}
            >
              <TriggerList
                listRef={listRef}
                status={listStatus}
                onStatusChange={setListStatus}
                triggers={draft}
                selectedId={selectedId}
                unsaved={triggerDraft.unsaved}
                phone={phone}
                canCreate={!pending && draft.length < 500}
                onOpen={(id) => {
                  setSelectedId(id);
                  openDetail();
                }}
                onCreate={() => {
                  const next = defaultTrigger(design);
                  quiet(stepKeys(next).map((step) => `${next.id}/${step}`));
                  setSelectedId(next.id);
                  updateDraft([...draft, next]);
                  openDetail();
                }}
              />
            </ResizablePanel>
            {wide && (
              // The gutter between the two panes is the handle.
              <ResizableHandle
                withHandle
                aria-label="Resize trigger list"
                className="w-4 bg-transparent"
              />
            )}
            <ResizablePanel
              id="trigger-detail"
              minSize={wide ? "28rem" : 0}
              className={cn(
                "min-w-0 overflow-visible! @min-[900px]/studio:h-full @min-[900px]/studio:overflow-hidden!",
                !phone && "mt-4 @min-[900px]/studio:mt-0",
                phone && phoneView === "list" && "hidden",
              )}
            >
              <section
                aria-label="Trigger details"
                className="bg-card border-border @container/detail flex min-w-0 flex-col rounded-xl border @min-[900px]/studio:h-full @min-[900px]/studio:overflow-clip"
              >
                <div className="border-border flex min-h-14 flex-wrap items-center gap-x-2.5 gap-y-1 border-b px-5 py-2">
                  {phone ? (
                    <Button
                      variant="ghost"
                      className="-ml-2 min-h-11"
                      onClick={() => {
                        setPhoneView("list");
                        focusCurrentRow();
                      }}
                    >
                      <ChevronLeft aria-hidden="true" />
                      <span className="sr-only">Back to </span>
                      Triggers
                    </Button>
                  ) : null}
                  {selected ? (
                    <>
                      <h2
                        ref={detailHeadingRef}
                        tabIndex={-1}
                        data-slot="section-title"
                        title={triggerDisplayName(selected)}
                        className={cn(
                          "min-w-0 text-lg font-semibold outline-none",
                          phone
                            ? "order-last basis-full [overflow-wrap:anywhere] break-words"
                            : "flex-1 truncate",
                        )}
                      >
                        {triggerDisplayName(selected)}
                      </h2>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon"
                              className="ml-auto size-11 shrink-0"
                              aria-label="Trigger options"
                              disabled={pending}
                            />
                          }
                        >
                          <MoreHorizontal aria-hidden="true" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="slim-ui">
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={pending}
                            onClick={() => deleteTrigger(selected)}
                          >
                            <Trash2 aria-hidden="true" />
                            Delete trigger
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </>
                  ) : null}
                </div>
                <div
                  ref={detailBodyRef}
                  className="grid min-h-0 min-w-0 flex-1 content-start gap-6 p-5 @min-[900px]/studio:overflow-y-auto"
                >
                  {error && (
                    <Alert variant="destructive" role="alert" tabIndex={-1}>
                      {error}
                    </Alert>
                  )}
                  {selected ? (
                    // A change or a focus leaving a step shows its note.
                    <div
                      className="contents"
                      onChange={(event) => touchStep(event.target)}
                      onBlur={(event) => touchStep(event.target)}
                    >
                      <TriggerRail
                        // Another trigger is a new detail: its switch and
                        // fields appear in their state, never animate to it.
                        key={selected.id}
                        design={design}
                        trigger={selected}
                        stepErrors={shownStepErrors}
                        pending={pending}
                        locked={locked}
                        onChange={update}
                      />
                    </div>
                  ) : (
                    <p className="text-muted-foreground text-sm">
                      Create a trigger to edit its settings.
                    </p>
                  )}
                  {recentActivity}
                </div>
                {dirty || pending ? (
                  // The D1 Save bar: what Save writes, then Discard and Save.
                  <div className="border-border sticky bottom-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-b-xl border-t bg-[var(--surface-raised)] px-5 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
                    {changes > 0 ? (
                      <p className="text-sm font-semibold">
                        {changes} unsaved {changes === 1 ? "change" : "changes"}
                      </p>
                    ) : null}
                    {triggerDraft.baseChanged ? (
                      <p
                        role="status"
                        className="text-warn-text order-first basis-full text-sm"
                      >
                        The saved triggers changed while you edited. Saving
                        replaces them with yours.
                      </p>
                    ) : null}
                    <div className="ml-auto flex items-center gap-1.5">
                      <Button
                        variant="ghost"
                        className="min-h-11"
                        onClick={() => discard()}
                        disabled={pending}
                      >
                        Discard<span className="sr-only"> changes</span>
                      </Button>
                      <Button
                        className="min-h-11"
                        onClick={() => void save()}
                        pending={pending}
                        pendingLabel="Saving…"
                      >
                        Save triggers
                      </Button>
                    </div>
                  </div>
                ) : null}
              </section>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </fieldset>
    </section>
  );
}
