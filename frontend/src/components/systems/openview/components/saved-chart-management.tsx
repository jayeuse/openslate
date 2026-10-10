"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, ApiContractError } from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { LoadingRegion } from "@/components/ui/loading-region";
import { useOpenViewAccessDenied } from "../adapters/openview-access";
import {
  authMeOptions,
  chartListOptions,
  extendsRead,
  openViewKeys,
  readStamp,
} from "../adapters/openview-queries";
import {
  archiveOpenViewChart,
  chartArchiveUsage,
  createOpenViewChart,
  getOpenViewChartUsage,
  listOpenViewCharts,
  restoreOpenViewChart,
  updateOpenViewChart,
  type ChartUsage,
  type SavedChart,
} from "../adapters/charts-api";
import type { InlineChartEditorValue } from "../domain/chart-query";
import { canManageOpenView } from "../domain/manage-access";
import { subscribeWorkspaceInvalidations } from "../../shared/adapters/invalidation-events";

type SavedChartManagementProps = {
  opened: SavedChart | null;
  selectedId: string | null;
  input: InlineChartEditorValue | null;
  sourceId: string | null;
  departmentId: string | undefined;
  scope: string;
  blocked: boolean;
  loading: boolean;
  error: string;
  onOpen: (id: string, preserveDraft?: boolean) => Promise<boolean>;
  onSaved: (chart: SavedChart) => void;
  onArchived: (id: string) => void;
  onBusy: (busy: boolean) => void;
};
type SaveForm = { mode: "save" | "copy"; name: string };
type UsageDialog = {
  mode: "usage" | "archive";
  chart: SavedChart;
  page: ChartUsage | null;
};

/** Owns the named-object commands and on-intent lists, not the query editor. */
export function SavedChartManagement(props: SavedChartManagementProps) {
  const client = useQueryClient();
  const accessDenied = useOpenViewAccessDenied();
  const me = useQuery(authMeOptions());
  const [listOpen, setListOpen] = useState(false);
  const [search, setSearch] = useState("");
  const list = useQuery({
    ...chartListOptions(search, undefined, "include"),
    enabled: listOpen,
  });
  const [extra, setExtra] = useState<{
    search: string;
    readAt: number;
    items: SavedChart[];
    hasMore: boolean;
  } | null>(null);
  const [pageBusy, setPageBusy] = useState(false);
  const [pageError, setPageError] = useState("");
  const [saveForm, setSaveForm] = useState<SaveForm | null>(null);
  const [usage, setUsage] = useState<UsageDialog | null>(null);
  const [usageBusy, setUsageBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [recovery, setRecovery] = useState<"conflict" | "unknown" | null>(null);
  const [nameError, setNameError] = useState(false);
  const operation = useRef(0);
  const usageOperation = useRef(0);
  const currentScope = useRef(props.scope);
  const refused =
    props.blocked || accessDenied || Boolean(listOpen && list.error);
  const refusal = useRef(refused);
  const refusalEpoch = useRef(0);
  useEffect(() => {
    currentScope.current = props.scope;
    refusal.current = refused;
  }, [props.scope, refused]);
  useEffect(
    () => () => {
      operation.current += 1;
      usageOperation.current += 1;
    },
    [],
  );
  useEffect(() => {
    if (!refused) return;
    refusalEpoch.current += 1;
    usageOperation.current += 1;
    setUsage(null);
  }, [refused]);
  useEffect(
    () =>
      subscribeWorkspaceInvalidations((event) => {
        if (
          event.type === "resync" ||
          [
            "charts",
            "boards",
            "dashboards",
            "board_widgets",
            "dashboard_widgets",
            "group_access",
            "group_members",
            "groups",
            "users",
          ].includes(event.entity)
        ) {
          usageOperation.current += 1;
          setUsage((current) => (current ? { ...current, page: null } : null));
          setUsageBusy(false);
        }
      }),
    [],
  );

  const managed =
    !me.error &&
    canManageOpenView(
      me.data,
      props.opened?.departmentId ?? props.departmentId,
    );
  const ready =
    managed &&
    !refused &&
    !props.loading &&
    !props.error &&
    (!props.selectedId || Boolean(props.opened)) &&
    !busy &&
    Boolean(props.input) &&
    !props.sourceId &&
    !props.opened?.isDeleted;
  const extension =
    extra?.search === search && extendsRead(extra.readAt, list) ? extra : null;
  const items = refused
    ? []
    : [...(list.data?.items ?? []), ...(extension?.items ?? [])];
  const hasMore =
    !refused && (extension?.hasMore ?? list.data?.pagination.hasMore ?? false);
  const refreshList = () => {
    setExtra(null);
    setPageError("");
    void client.invalidateQueries({ queryKey: openViewKeys.chartLists });
  };
  const refreshOnIntent = () => {
    setListOpen(true);
    refreshList();
  };
  async function loadMore() {
    if (pageBusy || !hasMore) return;
    const stamp = readStamp(list);
    setPageBusy(true);
    setPageError("");
    try {
      const page = await listOpenViewCharts({
        search,
        deleted: "include",
        offset: items.length,
      });
      if (page.items.some((item) => items.some((old) => old.id === item.id)))
        throw new ApiContractError();
      setExtra({
        search,
        readAt: stamp,
        items: [...(extension?.items ?? []), ...page.items],
        hasMore: page.pagination.hasMore,
      });
    } catch {
      setPageError("More saved charts could not be loaded. Refresh the list.");
    } finally {
      setPageBusy(false);
    }
  }
  async function readUsage(target: UsageDialog, more = false) {
    const sequence = ++usageOperation.current;
    setUsageBusy(true);
    setError("");
    try {
      const page = await getOpenViewChartUsage(
        target.chart.id,
        more ? (target.page?.items.length ?? 0) : 0,
      );
      if (sequence !== usageOperation.current || refusal.current) return;
      if (
        more &&
        target.page?.items.some((old) =>
          page.items.some(
            (item) => item.kind === old.kind && item.id === old.id,
          ),
        )
      )
        throw new ApiContractError();
      setUsage({
        ...target,
        page:
          more && target.page
            ? { ...page, items: [...target.page.items, ...page.items] }
            : page,
      });
    } catch {
      if (sequence === usageOperation.current) {
        setUsage((current) => (current ? { ...current, page: null } : null));
        setError("Chart usage is unavailable. Retry to check current access.");
      }
    } finally {
      if (sequence === usageOperation.current) setUsageBusy(false);
    }
  }
  function beginSave(mode: SaveForm["mode"]) {
    setError("");
    setRecovery(null);
    setNameError(false);
    setSaveForm({
      mode,
      name:
        mode === "copy" && props.opened
          ? `${props.opened.name} copy`
          : (props.opened?.name ?? ""),
    });
  }
  async function save() {
    if (!saveForm || !ready || recovery === "conflict" || !props.input) return;
    if (!saveForm.name.trim() || saveForm.name.trim().length > 120) {
      setNameError(true);
      return;
    }
    const sequence = ++operation.current;
    const scope = props.scope;
    const readEpoch = refusalEpoch.current;
    setBusy(true);
    props.onBusy(true);
    setError("");
    setNameError(false);
    try {
      const chart =
        saveForm.mode === "save" && props.opened
          ? await updateOpenViewChart(
              props.opened.id,
              props.opened.revision,
              saveForm.name,
              props.input,
            )
          : await createOpenViewChart(saveForm.name, props.input);
      refreshList();
      if (sequence !== operation.current || currentScope.current !== scope)
        return;
      if (readEpoch !== refusalEpoch.current) {
        setError(
          "The save outcome needs a fresh check after access changed. Your draft and name are retained; no write was retried.",
        );
        setRecovery("unknown");
        return;
      }
      if (refusal.current) return;
      props.onSaved(chart);
      setSaveForm(null);
      setRecovery(null);
    } catch (failure) {
      if (sequence !== operation.current || currentScope.current !== scope)
        return;
      if (failure instanceof ApiError && failure.code === "stale_revision") {
        setError(
          "This chart changed. Refresh the current chart before saving again; your draft and name are retained.",
        );
        setRecovery("conflict");
      } else if (
        failure instanceof ApiError &&
        [401, 403, 404].includes(failure.status)
      ) {
        setError(
          "You no longer have access to save this chart. Your draft and name are retained.",
        );
      } else if (failure instanceof ApiError && failure.status < 500) {
        setError(
          "The chart could not be saved. Check the name, query and current source, then try again.",
        );
      } else {
        setError(
          "The save outcome is unknown. Refresh saved charts before deciding whether to save again. No write was retried.",
        );
        setRecovery("unknown");
      }
    } finally {
      if (sequence === operation.current) {
        setBusy(false);
        props.onBusy(false);
      }
    }
  }
  async function lifecycle(chart: SavedChart, restore: boolean) {
    if (
      busy ||
      refused ||
      me.error ||
      !canManageOpenView(me.data, chart.departmentId)
    )
      return;
    const sequence = ++operation.current;
    const scope = props.scope;
    const readEpoch = refusalEpoch.current;
    setBusy(true);
    props.onBusy(true);
    setError("");
    try {
      const restored = restore
        ? await restoreOpenViewChart(chart.id, chart.revision)
        : null;
      if (!restore) await archiveOpenViewChart(chart.id, chart.revision);
      refreshList();
      if (
        sequence !== operation.current ||
        currentScope.current !== scope ||
        readEpoch !== refusalEpoch.current ||
        refusal.current
      )
        return;
      if (!restore) props.onArchived(chart.id);
      else if (restored && props.selectedId === restored.id)
        props.onSaved(restored);
      setUsage(null);
    } catch (failure) {
      if (
        sequence !== operation.current ||
        currentScope.current !== scope ||
        readEpoch !== refusalEpoch.current ||
        refusal.current
      )
        return;
      const page = chartArchiveUsage(failure);
      if (page) {
        setUsage({ mode: "archive", chart, page });
        setError(
          "This chart is used in other locations and cannot be archived. Remove every use first.",
        );
      } else {
        setError(
          failure instanceof ApiError && failure.code === "stale_revision"
            ? "This chart changed. Refresh saved charts before trying again."
            : "The chart could not be changed. Refresh saved charts to check its current state and access. No write was retried.",
        );
      }
    } finally {
      if (sequence === operation.current) {
        setBusy(false);
        props.onBusy(false);
      }
    }
  }

  return (
    <section
      aria-label="Saved chart management"
      className="space-y-4 print:hidden"
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto min-w-0">
          <p className="font-medium break-words">
            {refused ? "Chart draft" : (props.opened?.name ?? "Unsaved chart")}
          </p>
          <p className="text-muted-foreground text-sm">
            {props.opened?.isDeleted
              ? "Archived · restore before editing"
              : "Save the query; display options stay in this preview."}
          </p>
        </div>
        <Button
          variant="outline"
          className="min-h-11"
          aria-expanded={listOpen}
          aria-controls="saved-chart-list"
          onClick={() => setListOpen((open) => !open)}
        >
          Saved charts
        </Button>
        {props.sourceId ? (
          <Button
            variant="outline"
            className="min-h-11"
            disabled={refused || props.loading || busy}
            onClick={() => void props.onOpen(props.sourceId!)}
          >
            Open for editing
          </Button>
        ) : managed ? (
          <>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={!ready}
              onClick={() => beginSave("copy")}
            >
              Save as
            </Button>
            <Button
              className="min-h-11"
              disabled={!ready}
              onClick={() => beginSave("save")}
            >
              Save chart
            </Button>
          </>
        ) : null}
      </div>
      {props.loading ? (
        <p role="status" className="text-muted-foreground text-sm">
          Opening saved chart…
        </p>
      ) : null}
      {me.error ? (
        <Alert role="alert" variant="destructive">
          Chart management access could not be checked. You can still read
          authorized charts.
          <Button
            variant="outline"
            className="mt-2 min-h-11"
            onClick={() => void me.refetch()}
          >
            Retry chart management access
          </Button>
        </Alert>
      ) : null}
      {props.error ? (
        <Alert role="alert" variant="destructive">
          {props.error}
          <Button
            variant="outline"
            className="mt-2 min-h-11"
            disabled={props.loading || busy}
            onClick={() =>
              props.selectedId && void props.onOpen(props.selectedId, true)
            }
          >
            Retry open chart
          </Button>
        </Alert>
      ) : null}
      {listOpen ? (
        <div id="saved-chart-list" className="space-y-3 border-t pt-4">
          <Field>
            <FieldLabel htmlFor="saved-chart-search">
              Search saved charts
            </FieldLabel>
            <Input
              id="saved-chart-search"
              className="min-h-11"
              value={search}
              maxLength={100}
              onChange={(event) => {
                setSearch(event.target.value);
                setPageError("");
              }}
            />
          </Field>
          {list.error || refused || pageError ? (
            <Alert role="alert" variant="destructive">
              {pageError ||
                "Saved charts are unavailable. Refresh to check current access."}
              <Button
                variant="outline"
                className="mt-2 min-h-11"
                onClick={refreshList}
              >
                Refresh saved charts
              </Button>
            </Alert>
          ) : null}
          <LoadingRegion
            loading={list.isPending && list.isFetching}
            label="Loading saved charts…"
            skeleton={
              <p className="text-muted-foreground text-sm">
                Loading saved charts…
              </p>
            }
          >
            {items.length ? (
              <ul className="divide-y">
                {items.map((chart) => (
                  <li
                    key={chart.id}
                    className="flex flex-wrap items-center gap-2 py-3"
                  >
                    <div className="mr-auto min-w-0 basis-full sm:basis-auto">
                      <p className="font-medium break-words">{chart.name}</p>
                      <span className="text-muted-foreground text-sm capitalize">
                        {chart.chartType}
                      </span>
                      {chart.isDeleted ? (
                        <Badge variant="secondary" className="ml-2">
                          Archived
                        </Badge>
                      ) : null}
                    </div>
                    {!chart.isDeleted &&
                    ["bar", "line", "pie"].includes(chart.chartType) ? (
                      <Button
                        variant="outline"
                        className="min-h-11"
                        aria-label={`Open ${chart.name}`}
                        disabled={busy || props.loading}
                        onClick={() => void props.onOpen(chart.id)}
                      >
                        Open
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      className="min-h-11"
                      aria-label={`Usage of ${chart.name}`}
                      disabled={busy}
                      onClick={() => {
                        const target: UsageDialog = {
                          mode: "usage",
                          chart,
                          page: null,
                        };
                        setUsage(target);
                        void readUsage(target);
                      }}
                    >
                      Usage
                    </Button>
                    {!me.error &&
                    canManageOpenView(me.data, chart.departmentId) ? (
                      <Button
                        variant="outline"
                        className="min-h-11"
                        aria-label={`${chart.isDeleted ? "Restore" : "Archive"} ${chart.name}`}
                        disabled={busy}
                        onClick={() => {
                          setError("");
                          if (chart.isDeleted) void lifecycle(chart, true);
                          else setUsage({ mode: "archive", chart, page: null });
                        }}
                      >
                        {chart.isDeleted ? "Restore" : "Archive"}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : !list.isPending && !refused ? (
              <p className="text-muted-foreground text-sm">
                No saved charts match this search.
              </p>
            ) : null}
            {hasMore ? (
              <Button
                variant="outline"
                className="min-h-11"
                disabled={pageBusy}
                onClick={() => void loadMore()}
              >
                {pageBusy ? "Loading saved charts…" : "Load more saved charts"}
              </Button>
            ) : null}
          </LoadingRegion>
        </div>
      ) : null}
      <Dialog
        open={Boolean(saveForm)}
        dismissible={!busy}
        onOpenChange={(open) => {
          if (!open) {
            setSaveForm(null);
            setError("");
          }
        }}
      >
        <DialogContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
            noValidate
          >
            <DialogHeader>
              <DialogTitle>
                {saveForm?.mode === "copy" ? "Save as" : "Save chart"}
              </DialogTitle>
              <DialogDescription>
                A named chart lives in its data source’s department. Readers of
                that module can use it.
              </DialogDescription>
            </DialogHeader>
            <Field className="mt-4">
              <FieldLabel htmlFor="saved-chart-name">Chart name</FieldLabel>
              <Input
                id="saved-chart-name"
                className="min-h-11"
                value={saveForm?.name ?? ""}
                disabled={busy}
                maxLength={120}
                aria-invalid={nameError}
                aria-describedby="saved-chart-name-help"
                onChange={(event) => {
                  setSaveForm((current) =>
                    current ? { ...current, name: event.target.value } : null,
                  );
                  setNameError(false);
                }}
              />
              <FieldDescription id="saved-chart-name-help">
                {nameError
                  ? "Enter a chart name (1–120 characters)."
                  : "1–120 characters. Save as creates a separate chart."}
              </FieldDescription>
            </Field>
            {error ? (
              <Alert role="alert" variant="destructive" className="mt-3">
                {error}
                {recovery === "conflict" ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-2 min-h-11"
                    disabled={props.loading || busy}
                    onClick={() => {
                      if (props.selectedId)
                        void props
                          .onOpen(props.selectedId, true)
                          .then((loaded) => {
                            if (loaded) {
                              setRecovery(null);
                              setError("");
                            }
                          });
                    }}
                  >
                    Refresh current chart
                  </Button>
                ) : recovery === "unknown" ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-2 min-h-11"
                    onClick={refreshOnIntent}
                  >
                    Refresh saved charts
                  </Button>
                ) : null}
              </Alert>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={busy}
                onClick={() => setSaveForm(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="min-h-11"
                disabled={!ready || recovery === "conflict"}
              >
                {busy
                  ? "Saving…"
                  : saveForm?.mode === "copy"
                    ? "Save as"
                    : "Save chart"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(usage) && !refused}
        dismissible={!busy}
        onOpenChange={(open) => {
          if (!open) {
            usageOperation.current += 1;
            setUsage(null);
            setUsageBusy(false);
            setError("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {usage?.mode === "archive" ? "Archive chart" : "Chart usage"}
            </DialogTitle>
            <DialogDescription>
              {usage?.chart.name}. Every use, including restricted locations,
              blocks archive.
            </DialogDescription>
          </DialogHeader>
          {usageBusy ? (
            <p role="status" className="mt-3 text-sm">
              Checking chart usage…
            </p>
          ) : null}
          {error ? (
            <Alert role="alert" variant="destructive" className="mt-3">
              {error}
            </Alert>
          ) : null}
          {usage?.page ? (
            <div className="mt-3 space-y-3">
              <ul className="divide-y">
                {usage.page.items.map((item) => (
                  <li className="py-2" key={`${item.kind}:${item.id}`}>
                    <p className="font-medium break-words">{item.name}</p>
                    <p className="text-muted-foreground text-sm break-all">
                      {item.kind === "board" ? "Board" : "Dashboard"} ·{" "}
                      {item.id}
                    </p>
                  </li>
                ))}
              </ul>
              {usage.page.hasRestrictedUsage ? (
                <p className="text-muted-foreground text-sm">
                  Also used in locations you cannot access.
                </p>
              ) : null}
              {!usage.page.items.length && !usage.page.hasRestrictedUsage ? (
                <p className="text-muted-foreground text-sm">
                  No locations currently use this chart.
                </p>
              ) : null}
              {usage.page.pagination.hasMore ? (
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={usageBusy}
                  onClick={() => void readUsage(usage, true)}
                >
                  Load more chart usage
                </Button>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={busy}
              onClick={() => {
                usageOperation.current += 1;
                setUsage(null);
              }}
            >
              Close
            </Button>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={busy || usageBusy}
              onClick={() => usage && void readUsage(usage)}
            >
              Retry chart usage
            </Button>
            {usage?.mode === "archive" ? (
              <Button
                variant="destructive"
                className="min-h-11"
                disabled={
                  busy ||
                  Boolean(
                    usage.page &&
                    (usage.page.items.length || usage.page.hasRestrictedUsage),
                  )
                }
                onClick={() => void lifecycle(usage.chart, false)}
              >
                {busy ? "Archiving…" : "Archive chart"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {error && !saveForm && !usage ? (
        <Alert role="alert" variant="destructive">
          {error}
          <Button
            variant="outline"
            className="mt-2 min-h-11"
            onClick={refreshList}
          >
            Refresh saved charts
          </Button>
        </Alert>
      ) : null}
    </section>
  );
}
