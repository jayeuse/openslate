"use client";

import {
  BarChart3,
  Copy,
  Plus,
  FileBarChart,
  FileText,
  PieChart as PieChartIcon,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
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
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { sampleOperationMessage } from "../../shared/runtime/sample-async";
import { WidgetSurface } from "./widgets";
import {
  audienceLabel,
  isUnresolvedAudience,
  getOpenViewRows,
  type AudienceLookup,
  type OpenViewModuleId,
  type OpenViewWidget,
  type Dashboard as OpenViewDashboard,
} from "../domain/model";
import {
  clone,
  defaultDashboard,
  defaultWidget,
  makeId,
  normalizeDashboards,
  refreshLabel,
} from "./analytics-data";
import { EmptyState } from "./analytics-shared";
import { Choice, AudienceField, RefreshField } from "./analytics-shared";
import type {
  OpenViewCommandController,
  OpenViewReadSnapshot,
} from "../adapters/controller";

export function Dashboards({
  moduleId = "service-requests",
  dashboardUrlId,
  commands,
  snapshot,
  audienceLookup,
  onDashboardUrlChange,
  onDashboardDirtyChange,
}: {
  moduleId?: OpenViewModuleId;
  dashboardUrlId?: string;
  commands: OpenViewCommandController;
  snapshot: OpenViewReadSnapshot;
  audienceLookup: AudienceLookup;
  onDashboardUrlChange?: (id: string | undefined) => void;
  onDashboardDirtyChange?: (dirty: boolean) => void;
}) {
  const lookup = audienceLookup;
  const commandPending = commands.isPending();
  const records = snapshot.records;
  const rawDashboards = snapshot.dashboards;
  const storedSelectedId = snapshot.dashboardSelected;
  const storedDefaultId = snapshot.dashboardDefault;
  const [selectedId, setSelectedId] = useState(
    typeof storedSelectedId === "string" ? storedSelectedId : "",
  );
  const [defaultId, setDefaultId] = useState(
    typeof storedDefaultId === "string" ? storedDefaultId : "",
  );
  const dashboards = useMemo(
    () => normalizeDashboards(rawDashboards, audienceLookup),
    [rawDashboards, audienceLookup.roles, audienceLookup.identities],
  );
  const urlDashboard = dashboardUrlId
    ? dashboards.find((dashboard) => dashboard.id === dashboardUrlId)
    : undefined;
  const storedDashboard = dashboards.find(
    (dashboard) => dashboard.id === selectedId,
  );
  const defaultDashboardRecord = dashboards.find(
    (dashboard) => dashboard.id === defaultId,
  );
  const selected =
    urlDashboard ?? storedDashboard ?? defaultDashboardRecord ?? dashboards[0];
  const unknownUrlDashboard = Boolean(dashboardUrlId && !urlDashboard);
  const fallback = useMemo(
    () => clone(defaultDashboard("Operations pulse")),
    [],
  );
  const [draft, setDraft] = useState<OpenViewDashboard>(() =>
    clone(selected ?? fallback),
  );
  const deletePending = commands.isPending(
    `openview.dashboard.delete:${draft.id}`,
  );
  const draftRevision = useRef(0);
  const updateDraft = (
    action:
      OpenViewDashboard | ((current: OpenViewDashboard) => OpenViewDashboard),
  ) => {
    draftRevision.current += 1;
    setDraft(action);
  };
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [pendingSelection, setPendingSelection] = useState<string | null>(null);
  const [pendingTransition, setPendingTransition] = useState<
    { kind: "create"; name: string } | { kind: "duplicate" } | null
  >(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [message, setMessage] = useState("");
  const dirty = selected
    ? JSON.stringify(draft) !== JSON.stringify(selected)
    : dashboards.length > 0 &&
      (draft.widgets.length > 0 || draft.name !== "New dashboard");

  useEffect(() => {
    onDashboardDirtyChange?.(dirty);
    return () => onDashboardDirtyChange?.(false);
  }, [dirty, onDashboardDirtyChange]);

  useEffect(() => {
    if (selected && selected.id !== draft.id) {
      draftRevision.current = 0;
      setDraft(clone(selected));
    }
  }, [selected?.id, draft.id]);

  function chooseDashboard(id: string) {
    if (commandPending) return;
    if (id === draft.id || !dirty) {
      setSelectedId(id);
      const next = dashboards.find((dashboard) => dashboard.id === id);
      if (next) {
        draftRevision.current = 0;
        setDraft(clone(next));
      }
      onDashboardUrlChange?.(id);
      return;
    }
    setPendingSelection(id);
  }

  async function saveDashboard() {
    if (commandPending) return;
    const name = draft.name.trim();
    if (!name) {
      setMessage("Give this dashboard a name before saving.");
      return;
    }
    const nextDashboard = { ...draft, name };
    const submittedRevision = draftRevision.current;
    setMessage("");
    try {
      const expected = selected?.id === nextDashboard.id ? selected : undefined;
      const result = await commands.saveDashboard({
        dashboard: nextDashboard,
        expectedId: expected?.id,
        expected,
      });
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      if (submittedRevision !== draftRevision.current) {
        setMessage(
          "Dashboard saved. Your newer edits remain open as an unsaved draft.",
        );
        return;
      }
      draftRevision.current = 0;
      setDraft(result.value);
      setSelectedId(result.value.id);
      onDashboardUrlChange?.(result.value.id);
      setMessage(
        "Dashboard saved in this browser tab. Audience settings do not grant access, and refresh is not scheduled.",
      );
    } catch (error) {
      setMessage(
        sampleOperationMessage(
          error,
          "The dashboard could not be saved. Keep the editor open and try again.",
        ),
      );
    }
  }

  async function commitCreateDashboard(name: string) {
    if (commandPending) return;
    const dashboard = defaultDashboard(name || "New dashboard");
    const submittedRevision = draftRevision.current;
    setMessage("");
    try {
      const result = await commands.createDashboard(dashboard);
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      if (submittedRevision !== draftRevision.current) {
        setMessage(
          "Dashboard created. Your newer edits remain open as an unsaved draft.",
        );
        return;
      }
      draftRevision.current = 0;
      setSelectedId(result.value.id);
      onDashboardUrlChange?.(result.value.id);
      setDraft(result.value);
      setCreateName("");
      setCreateOpen(false);
      setMessage("Dashboard created in this tab.");
    } catch (error) {
      setMessage(
        sampleOperationMessage(
          error,
          "The dashboard could not be created. Try again.",
        ),
      );
    }
  }

  function requestCreateDashboard(name: string) {
    if (commandPending) return;
    if (dirty) {
      setPendingTransition({ kind: "create", name });
      return;
    }
    commitCreateDashboard(name);
  }

  function createDashboard(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    requestCreateDashboard(createName.trim() || "New dashboard");
  }

  async function commitDuplicateDashboard() {
    if (commandPending) return;
    const dashboard = {
      ...clone(draft),
      id: makeId("sample-dashboard"),
      name: `${draft.name || "Dashboard"} copy`,
      widgets: draft.widgets.map((widget) => ({
        ...clone(widget),
        id: makeId("sample-widget"),
      })),
    };
    const submittedRevision = draftRevision.current;
    setMessage("");
    try {
      const result = await commands.duplicateDashboard({
        sourceId: draft.id,
        dashboard,
        expectedSource: selected?.id === draft.id ? selected : undefined,
      });
      if (!result.ok) {
        setMessage(result.error);
        return;
      }
      if (submittedRevision !== draftRevision.current) {
        setMessage(
          "Dashboard duplicated. Your newer edits remain open as an unsaved draft.",
        );
        return;
      }
      draftRevision.current = 0;
      setSelectedId(result.value.id);
      onDashboardUrlChange?.(result.value.id);
      setDraft(result.value);
      setMessage("Dashboard duplicated.");
    } catch (error) {
      setMessage(
        sampleOperationMessage(
          error,
          "The dashboard could not be duplicated. Try again.",
        ),
      );
    }
  }

  function duplicateDashboard() {
    if (commandPending) return;
    if (dirty) {
      setPendingTransition({ kind: "duplicate" });
      return;
    }
    commitDuplicateDashboard();
  }

  function handleSurfaceChange(next: OpenViewWidget[]) {
    updateDraft((current) => ({ ...current, widgets: next }));
  }

  if (!selected && dashboards.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Dashboards</CardTitle>
          <CardDescription>
            Build a reusable operational surface from workspace records.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {unknownUrlDashboard ? (
            <div className="mb-5">
              <DashboardLinkWarning
                hasFallback={false}
                disabled={commandPending}
                onClear={() => onDashboardUrlChange?.(undefined)}
              />
            </div>
          ) : null}
          <EmptyState
            icon={<BarChart3 />}
            title="No dashboards yet"
            description="Create a dashboard to start arranging summaries, workloads, records, and charts."
            action={
              <Button
                className="min-h-11"
                disabled={commandPending}
                onClick={() => requestCreateDashboard("New dashboard")}
              >
                <Plus data-icon="inline-start" />
                Create dashboard
              </Button>
            }
          />
        </CardContent>
      </Card>
    );
  }

  const activeDashboard = selected ?? draft;
  const rowsByModule = {
    "service-requests": getOpenViewRows("service-requests", records),
    equipment: getOpenViewRows("equipment"),
    customers: getOpenViewRows("customers"),
  };
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <Choice
          id="openview-dashboard"
          label="Dashboard"
          value={activeDashboard.id}
          disabled={commandPending}
          values={dashboards.map((dashboard) => ({
            value: dashboard.id,
            label: dashboard.name,
          }))}
          onChange={chooseDashboard}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            className="min-h-11"
            disabled={commandPending}
            onClick={() => setCreateOpen((open) => !open)}
          >
            <Plus data-icon="inline-start" />
            Create dashboard
          </Button>
          <Button
            variant="ghost"
            className="min-h-11"
            disabled={commandPending}
            onClick={duplicateDashboard}
          >
            <Copy data-icon="inline-start" />
            Duplicate
          </Button>
        </div>
      </div>
      {createOpen ? (
        <Card>
          <CardHeader>
            <CardTitle>Create dashboard</CardTitle>
            <CardDescription>
              Name the dashboard; you can configure and save it after creation.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-col gap-4 sm:flex-row sm:items-end"
              onSubmit={createDashboard}
            >
              <Field className="min-w-0 flex-1">
                <FieldLabel htmlFor="new-dashboard-name">
                  Dashboard name
                </FieldLabel>
                <Input
                  id="new-dashboard-name"
                  className="min-h-11"
                  value={createName}
                  maxLength={80}
                  autoFocus
                  disabled={commandPending}
                  onChange={(event) => setCreateName(event.target.value)}
                />
              </Field>
              <Button className="min-h-11" disabled={commandPending}>
                Create dashboard
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={commandPending}
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : null}
      {unknownUrlDashboard ? (
        <DashboardLinkWarning
          disabled={commandPending}
          onClear={() => onDashboardUrlChange?.(undefined)}
        />
      ) : null}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <Field>
                <FieldLabel htmlFor="dashboard-name">Dashboard name</FieldLabel>
                <Input
                  id="dashboard-name"
                  className="min-h-11"
                  value={draft.name}
                  maxLength={80}
                  onChange={(event) =>
                    updateDraft((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                />
              </Field>
              <p className="text-muted-foreground mt-3 text-sm">
                Arrange widgets around one operating question. Saving writes to
                this browser tab only.
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
              <Badge variant="outline">{refreshLabel(draft.refresh)}</Badge>
              {defaultId === draft.id ? (
                <Badge variant="success">Default</Badge>
              ) : null}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            <AudienceField
              id="dashboard-audience"
              audience={draft.audience}
              audienceLookup={lookup}
              onChange={(audience) =>
                updateDraft((current) => ({ ...current, audience }))
              }
            />
            <RefreshField
              id="dashboard-refresh"
              value={draft.refresh}
              onChange={(refresh) =>
                updateDraft((current) => ({ ...current, refresh }))
              }
            />
          </div>
          <Separator className="my-6" />
          <section
            className="border-border mb-5 border-y py-4"
            aria-labelledby="dashboard-attention-question"
          >
            <h3
              data-slot="section-title"
              id="dashboard-attention-question"
              className="font-semibold"
            >
              What needs attention now?
            </h3>
            <p className="text-muted-foreground mt-1 max-w-3xl text-sm">
              Summary and record widgets surface deadlines, blocked work,
              priority, ownership, and progress. Use charts for the broader
              pattern behind the work.
            </p>
          </section>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 data-slot="section-title" className="font-semibold">
                Widgets
              </h3>
              <p className="text-muted-foreground text-sm">
                Add a catalog item, then tune its source, fields, filters, and
                display. {draft.widgets.length} of 12 widgets used.
              </p>
            </div>
            <WidgetCatalog
              disabled={draft.widgets.length >= 12 || commandPending}
              onAdd={(type) =>
                updateDraft((current) =>
                  current.widgets.length >= 12
                    ? current
                    : {
                        ...current,
                        widgets: [
                          ...current.widgets,
                          defaultWidget(type, moduleId),
                        ],
                      },
                )
              }
            />
          </div>
          <div className="mt-5">
            <WidgetSurface
              widgets={draft.widgets}
              onChange={handleSurfaceChange}
              maxWidgets={12}
              records={records}
              rowsByModule={rowsByModule}
              audienceLookup={lookup}
            />
          </div>
          {draft.widgets.length === 0 ? (
            <EmptyState
              className="mt-5"
              icon={<Plus />}
              title="No widgets on this dashboard"
              description="Use Add widget to choose a summary, workload, record list, or chart."
            />
          ) : null}
        </CardContent>
        <CardFooter className="flex-wrap justify-between">
          <div className="flex flex-wrap gap-2">
            <Button
              className="min-h-11"
              disabled={commandPending}
              onClick={() => void saveDashboard()}
            >
              <Save data-icon="inline-start" />
              {commands.isPending(`openview.dashboard.save:${draft.id}`)
                ? "Saving…"
                : dirty
                  ? "Save changes"
                  : "Saved"}
            </Button>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={!dirty || commandPending}
              onClick={() => {
                if (!selected) return;
                draftRevision.current = 0;
                setDraft(clone(selected));
              }}
            >
              <RotateCcw data-icon="inline-start" />
              Reset draft
            </Button>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={commandPending}
              onClick={async () => {
                const nextId = defaultId === draft.id ? null : draft.id;
                setMessage("");
                try {
                  const result = await commands.setDashboardDefault(nextId);
                  if (!result.ok) {
                    setMessage(result.error);
                    return;
                  }
                  setDefaultId(result.value ?? "");
                } catch (error) {
                  setMessage(
                    sampleOperationMessage(
                      error,
                      "The dashboard default could not be changed. Try again.",
                    ),
                  );
                }
              }}
            >
              {defaultId === draft.id ? "Unset default" : "Set as default"}
            </Button>
          </div>
          <Button
            variant="destructive"
            className="min-h-11"
            disabled={commandPending}
            onClick={() => {
              setDeleteError("");
              setConfirmDelete(true);
            }}
          >
            <Trash2 data-icon="inline-start" />
            Delete dashboard
          </Button>
        </CardFooter>
      </Card>
      {message ? (
        <Alert
          variant={
            message.includes("before") ||
            message.includes("could not") ||
            message.includes("changed")
              ? "warning"
              : "success"
          }
        >
          {message}
        </Alert>
      ) : null}
      <AlertDialog
        open={pendingTransition !== null}
        onOpenChange={(open) => {
          if (!open && !commandPending) setPendingTransition(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingTransition?.kind === "create"
                ? "Create dashboard and discard changes?"
                : "Duplicate dashboard and replace draft?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Your current dashboard draft has unsaved changes. This action will
              replace the draft in the editor without saving those changes
              first.
            </AlertDialogDescription>
            {commandPending ? (
              <p role="status" className="text-muted-foreground text-sm">
                A dashboard change is still being saved. Keep editing until it
                finishes.
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={commandPending}
              onClick={() => setPendingTransition(null)}
            >
              Keep editing
            </Button>
            <Button
              className="min-h-11"
              disabled={commandPending}
              onClick={() => {
                const transition = pendingTransition;
                if (!transition) return;
                setPendingTransition(null);
                if (transition.kind === "create")
                  commitCreateDashboard(transition.name);
                else commitDuplicateDashboard();
              }}
            >
              {pendingTransition?.kind === "create"
                ? "Discard and create"
                : "Discard and duplicate"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={pendingSelection !== null}
        onOpenChange={(open) => {
          if (!open && !commandPending) setPendingSelection(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard dashboard changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your current dashboard draft has unsaved changes. Switching
              dashboards will discard them.
            </AlertDialogDescription>
            {commandPending ? (
              <p role="status" className="text-muted-foreground text-sm">
                A dashboard change is still being saved. Keep editing until it
                finishes.
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={commandPending}
              onClick={() => setPendingSelection(null)}
            >
              Keep editing
            </Button>
            <Button
              className="min-h-11"
              disabled={commandPending}
              onClick={() => {
                if (pendingSelection) {
                  setSelectedId(pendingSelection);
                  const next = dashboards.find(
                    (item) => item.id === pendingSelection,
                  );
                  if (next) {
                    draftRevision.current = 0;
                    setDraft(clone(next));
                    onDashboardUrlChange?.(next.id);
                  }
                }
                setPendingSelection(null);
              }}
            >
              Discard and switch
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
            <AlertDialogTitle>Delete “{draft.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the dashboard from this tab. Its source records are
              unchanged.
            </AlertDialogDescription>
            {commandPending ? (
              <p role="status" className="text-muted-foreground text-sm">
                A dashboard change is still being saved. Keep this confirmation
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
              disabled={commandPending}
              onClick={async () => {
                setMessage("");
                setDeleteError("");
                try {
                  const result = await commands.deleteDashboard(
                    draft.id,
                    selected?.id === draft.id ? selected : undefined,
                  );
                  if (!result.ok) {
                    setDeleteError(result.error);
                    return;
                  }
                  setDefaultId(defaultId === draft.id ? "" : defaultId);
                  const next = result.value.remaining[0];
                  if (next) {
                    draftRevision.current = 0;
                    setSelectedId(next.id);
                    setDraft(clone(next));
                    onDashboardUrlChange?.(next.id);
                  } else {
                    draftRevision.current = 0;
                    setSelectedId("");
                    setDraft(defaultDashboard());
                    onDashboardUrlChange?.(undefined);
                  }
                  setConfirmDelete(false);
                  setDeleteError("");
                  setMessage("Dashboard deleted from this tab.");
                } catch (error) {
                  setDeleteError(
                    sampleOperationMessage(
                      error,
                      "The dashboard could not be deleted. Try again.",
                    ),
                  );
                }
              }}
            >
              {deletePending ? "Deleting…" : "Delete dashboard"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function WidgetCatalog({
  onAdd,
  disabled = false,
}: {
  onAdd: (type: OpenViewWidget["type"]) => void;
  disabled?: boolean;
}) {
  const items: {
    type: OpenViewWidget["type"];
    label: string;
    description: string;
    icon: ReactNode;
  }[] = [
    {
      type: "summary",
      label: "Summary",
      description: "Count records and show a compact status breakdown.",
      icon: <FileBarChart data-icon="inline-start" />,
    },
    {
      type: "workload",
      label: "Workload",
      description: "Compare records by the selected people or category.",
      icon: <BarChart3 data-icon="inline-start" />,
    },
    {
      type: "records",
      label: "Record list",
      description: "Keep a short, linked list of matching records in view.",
      icon: <FileText data-icon="inline-start" />,
    },
    {
      type: "chart",
      label: "Chart",
      description: "Add a configurable bar, line, or pie summary.",
      icon: <PieChartIcon data-icon="inline-start" />,
    },
  ];
  return (
    <div className="flex flex-wrap gap-2" aria-label="Widget catalog">
      {items.map((item) => (
        <Button
          key={item.type}
          type="button"
          variant="outline"
          className="min-h-11"
          title={item.description}
          disabled={disabled}
          onClick={() => onAdd(item.type)}
        >
          {item.icon}
          {item.label}
        </Button>
      ))}
    </div>
  );
}

function DashboardLinkWarning({
  onClear,
  hasFallback = true,
  disabled = false,
}: {
  onClear?: () => void;
  hasFallback?: boolean;
  disabled?: boolean;
}) {
  return (
    <Alert variant="warning">
      {hasFallback
        ? "This dashboard link is unavailable. The selected dashboard is a recovery view; choose another dashboard to update the link."
        : "This dashboard link is unavailable. Choose a dashboard to recover the workspace."}
      {onClear ? (
        <Button
          variant="outline"
          className="mt-3 min-h-11"
          disabled={disabled}
          onClick={onClear}
        >
          Clear unavailable link
        </Button>
      ) : null}
    </Alert>
  );
}
