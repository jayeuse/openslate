"use client";

import {
  useImperativeHandle,
  useId,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type MouseEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  Clock3,
  Download,
  FileSearch,
  HardDrive,
  MoreHorizontal,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { Separator } from "@/components/ui/separator";
import { AccessSearchToolbar } from "../../access/components/access-search-toolbar";
import type { CompleteCollection } from "../../shared/helpers/sample-collections";
import {
  manageSettingLabels,
  type ManageSettings,
  type ManageSnapshot,
} from "../state/state";
import { type useManageController } from "../state/state";
import {
  SettingActions,
  SettingSelect,
  type SettingsPanelForm,
} from "./panel-ui";
import type { ConfirmState, PreviewState } from "./manage-dialogs";

type SavedScheduleFilter = "all" | "enabled" | "disabled";
type SnapshotOrder = "newest" | "oldest" | "name";

const SNAPSHOT_PAGE_SIZES = [4, 10, 25] as const;
const SAVED_SCHEDULE_FILTERS: readonly {
  value: SavedScheduleFilter;
  label: string;
}[] = [
  { value: "all", label: "All schedules" },
  { value: "enabled", label: "Enabled schedules" },
  { value: "disabled", label: "Disabled schedules" },
];
const SNAPSHOT_SORT_OPTIONS: readonly {
  value: SnapshotOrder;
  label: string;
}[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "name", label: "Name" },
];
const MANAGE_SETTING_ORDER = [
  "name",
  "logo",
  "locale",
  "timezone",
  "currency",
  "week",
  "hours",
  "password",
  "timeout",
  "mfa",
  "ips",
  "schedule",
  "retention",
  "version",
  "previous",
  "tier",
  "expiry",
] as const satisfies readonly (keyof ManageSettings)[];
const SNAPSHOT_PRIMARY_SETTINGS: readonly (keyof ManageSettings)[] = [
  "password",
  "timeout",
  "mfa",
  "schedule",
  "retention",
];
const SNAPSHOT_ADDITIONAL_SETTINGS = MANAGE_SETTING_ORDER.filter(
  (key) => !SNAPSHOT_PRIMARY_SETTINGS.includes(key),
);

type BackupPanelActions = {
  addSnapshot: (name: string) => Promise<boolean>;
  requestRestore: (
    snapshot: ManageSnapshot,
    event: MouseEvent<HTMLElement>,
  ) => void;
  setCompareTarget: Dispatch<SetStateAction<ManageSnapshot | null>>;
  downloadSnapshot: (snapshot: ManageSnapshot) => void;
  renameOpener: RefObject<HTMLElement | null>;
  setRenameTarget: Dispatch<SetStateAction<ManageSnapshot | null>>;
  setRenameError: Dispatch<SetStateAction<string>>;
  setRenameValue: Dispatch<SetStateAction<string>>;
  requestConfirm: (next: ConfirmState, event?: MouseEvent<HTMLElement>) => void;
  manage: Pick<ReturnType<typeof useManageController>, "deleteSnapshot">;
  setError: Dispatch<SetStateAction<string>>;
  setNotice: Dispatch<SetStateAction<string>>;
};

type BackupPanelProps = {
  snapshots: CompleteCollection<ManageSnapshot>;
  actions: BackupPanelActions;
};

type SnapshotScheduleFormProps = {
  form: SettingsPanelForm;
  settings: ManageSettings;
  retention: {
    days: number;
    candidates: ManageSnapshot[];
    count: number;
    schedule: string;
    timezone: string;
  };
  actions: {
    addSnapshot: (name: string) => Promise<boolean>;
    setPreview: Dispatch<SetStateAction<PreviewState | null>>;
  };
};

function parseSnapshotDate(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function formatSnapshotDate(value: string): string {
  const parsed = parseSnapshotDate(value);
  return parsed
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(parsed)
    : value;
}

function snapshotSettingRows(
  snapshot: ManageSnapshot,
  keys: readonly (keyof ManageSettings)[],
) {
  return keys.map((key) => (
    <div
      key={key}
      className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-3 px-3 py-2.5 text-sm"
    >
      <dt className="text-muted-foreground min-w-0 break-words">
        {manageSettingLabels[key]}
      </dt>
      <dd className="min-w-0 text-right break-words">
        {snapshot.settings[key] || "Not set"}
      </dd>
    </div>
  ));
}

function sortSnapshots(
  source: readonly ManageSnapshot[],
  order: SnapshotOrder,
): ManageSnapshot[] {
  return [...source].sort((left, right) => {
    if (order === "name") {
      return (
        left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
      );
    }

    const leftDate = parseSnapshotDate(left.date)?.getTime() ?? null;
    const rightDate = parseSnapshotDate(right.date)?.getTime() ?? null;
    if (leftDate === null && rightDate !== null) return 1;
    if (rightDate === null && leftDate !== null) return -1;
    if (leftDate !== null && rightDate !== null && leftDate !== rightDate)
      return order === "newest" ? rightDate - leftDate : leftDate - rightDate;

    return (
      left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
    );
  });
}

export function BackupPanel({ snapshots, actions }: BackupPanelProps) {
  const id = useId();
  const snapshotActionsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<SnapshotOrder>("newest");
  const [scheduleFilter, setScheduleFilter] =
    useState<SavedScheduleFilter>("all");
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState<number>(SNAPSHOT_PAGE_SIZES[0]);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(
    () => sortSnapshots(snapshots.items, "newest")[0]?.id ?? null,
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("Manual snapshot");
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredSnapshots = snapshots.items.filter((snapshot) => {
    const matchesQuery = snapshot.name
      .toLocaleLowerCase()
      .includes(normalizedQuery);
    const matchesSchedule =
      scheduleFilter === "all" ||
      (scheduleFilter === "disabled") ===
        (snapshot.settings.schedule === "Disabled");
    return matchesQuery && matchesSchedule;
  });
  const orderedSnapshots = sortSnapshots(filteredSnapshots, order);
  const total = orderedSnapshots.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePageIndex = Math.min(pageIndex, pageCount - 1);
  const pageOffset = safePageIndex * pageSize;
  const visibleSnapshots = orderedSnapshots.slice(
    pageOffset,
    pageOffset + pageSize,
  );
  const selectedSnapshot =
    visibleSnapshots.find((snapshot) => snapshot.id === selectedSnapshotId) ??
    null;
  useImperativeHandle<HTMLElement | null, HTMLButtonElement | null>(
    actions.renameOpener,
    () => snapshotActionsTriggerRef.current,
    [actions.renameOpener, selectedSnapshot?.id],
  );
  const firstVisible = total === 0 ? 0 : pageOffset + 1;
  const lastVisible = Math.min(pageOffset + visibleSnapshots.length, total);

  function updateQuery(value: string) {
    setQuery(value);
    setPageIndex(0);
    setSelectedSnapshotId(null);
  }

  function updateScheduleFilter(value: SavedScheduleFilter) {
    setScheduleFilter(value);
    setPageIndex(0);
    setSelectedSnapshotId(null);
  }

  async function createSnapshot(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creatingRef.current) return;
    const name = createName.trim() || "Manual snapshot";

    creatingRef.current = true;
    setCreating(true);
    try {
      const created = await actions.addSnapshot(name);
      if (!created) return;
      setSelectedSnapshotId(null);
      setCreateName("Manual snapshot");
      setCreateOpen(false);
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }

  const columns: DataTableColumn<ManageSnapshot>[] = [
    {
      id: "snapshot",
      header: "Snapshot",
      cell: ({ row }) => (
        <div className="flex min-w-0 flex-col gap-1">
          <Button
            type="button"
            variant="ghost"
            aria-label={`Inspect ${row.original.name}`}
            aria-pressed={row.original.id === selectedSnapshot?.id}
            className="h-auto min-h-11 min-w-0 justify-start px-2 py-1 text-left font-medium whitespace-normal"
            onClick={() => setSelectedSnapshotId(row.original.id)}
          >
            <span className="break-words">{row.original.name}</span>
          </Button>
          <span className="text-muted-foreground px-2 text-xs">
            Manage settings only
          </span>
        </div>
      ),
    },
    {
      id: "created",
      header: "Created",
      cell: ({ row }) => {
        const parsed = parseSnapshotDate(row.original.date);
        return (
          <time
            className="text-muted-foreground tabular-nums"
            dateTime={parsed?.toISOString()}
          >
            {formatSnapshotDate(row.original.date)}
          </time>
        );
      },
    },
    {
      id: "saved-schedule",
      header: "Saved schedule",
      cell: ({ row }) => (
        <Badge
          variant={
            row.original.settings.schedule === "Disabled"
              ? "outline"
              : "secondary"
          }
        >
          {row.original.settings.schedule}
        </Badge>
      ),
    },
  ];

  return (
    <section
      aria-labelledby={`${id}-snapshots-heading`}
      className="flex min-w-0 flex-col gap-3"
    >
      <div
        className={`grid min-w-0 gap-3 ${
          selectedSnapshot
            ? "lg:grid-cols-[minmax(0,1fr)_minmax(18rem,25rem)]"
            : "grid-cols-1"
        }`}
      >
        <section
          aria-labelledby={`${id}-snapshots-heading`}
          className="bg-card min-w-0 overflow-hidden rounded-lg border"
        >
          <header className="flex flex-wrap items-start justify-between gap-3 border-b p-4">
            <div className="min-w-0">
              <h2
                id={`${id}-snapshots-heading`}
                className="text-lg font-semibold"
              >
                Configuration snapshots
              </h2>
              <p className="text-muted-foreground mt-1 text-sm">
                Select a snapshot to inspect its saved Manage settings.
              </p>
            </div>
            <Button
              type="button"
              className="min-h-11 shrink-0 gap-2"
              onClick={() => setCreateOpen(true)}
            >
              <HardDrive data-icon="inline-start" /> Create snapshot
            </Button>
          </header>

          <div className="flex min-w-0 flex-col gap-3 p-3">
            <AccessSearchToolbar
              searchLabel="Search snapshots"
              placeholder="Search by snapshot name..."
              query={query}
              onQueryChange={updateQuery}
              sortLabel="Sort snapshots"
              sort={order}
              sortOptions={SNAPSHOT_SORT_OPTIONS}
              onSortChange={(value) => {
                setOrder(value);
                setPageIndex(0);
                setSelectedSnapshotId(null);
              }}
              activeFilterCount={scheduleFilter === "all" ? 0 : 1}
            >
              <Field>
                <FieldLabel htmlFor={`${id}-snapshot-schedule`}>
                  Saved schedule
                </FieldLabel>
                <NativeSelect
                  id={`${id}-snapshot-schedule`}
                  className="w-full [&_select]:min-h-11"
                  value={scheduleFilter}
                  onChange={(event) => {
                    const option = SAVED_SCHEDULE_FILTERS.find(
                      (item) => item.value === event.currentTarget.value,
                    );
                    if (option) updateScheduleFilter(option.value);
                  }}
                >
                  {SAVED_SCHEDULE_FILTERS.map((option) => (
                    <NativeSelectOption key={option.value} value={option.value}>
                      {option.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
            </AccessSearchToolbar>

            {total === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    {snapshots.items.length === 0 ? (
                      <HardDrive aria-hidden="true" />
                    ) : (
                      <FileSearch aria-hidden="true" />
                    )}
                  </EmptyMedia>
                  <EmptyTitle>
                    {snapshots.items.length === 0
                      ? "No configuration snapshots yet"
                      : "No snapshots match these filters"}
                  </EmptyTitle>
                  <EmptyDescription>
                    {snapshots.items.length === 0
                      ? "Create a snapshot to keep a saved Manage configuration checkpoint."
                      : "Try another name or saved schedule to find a snapshot."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <>
                <div className="hidden min-w-0 lg:block">
                  <DataTable
                    ariaLabel="Configuration snapshots"
                    cellClassName="px-3 py-3 whitespace-normal"
                    columns={columns}
                    data={visibleSnapshots}
                    getRowId={(snapshot) => snapshot.id}
                    rowClassName={(snapshot) =>
                      snapshot.id === selectedSnapshot?.id
                        ? "bg-muted/70"
                        : undefined
                    }
                    rowState={(snapshot) =>
                      snapshot.id === selectedSnapshot?.id
                        ? "selected"
                        : undefined
                    }
                  />
                </div>

                <div className="divide-border divide-y rounded-lg border lg:hidden">
                  {visibleSnapshots.map((snapshot) => {
                    const parsed = parseSnapshotDate(snapshot.date);
                    const selected = snapshot.id === selectedSnapshot?.id;
                    return (
                      <article
                        key={snapshot.id}
                        className={`flex min-w-0 flex-col gap-3 p-3 ${
                          selected ? "bg-muted/70" : ""
                        }`}
                      >
                        <div className="flex min-w-0 items-start justify-between gap-3">
                          <div className="min-w-0">
                            <Button
                              type="button"
                              variant="ghost"
                              aria-label={`Inspect ${snapshot.name}`}
                              aria-pressed={selected}
                              className="h-auto min-h-11 min-w-0 justify-start px-2 py-1 text-left font-medium whitespace-normal"
                              onClick={() => setSelectedSnapshotId(snapshot.id)}
                            >
                              <span className="break-words">
                                {snapshot.name}
                              </span>
                            </Button>
                            <p className="text-muted-foreground px-2 text-xs">
                              Manage settings only
                            </p>
                          </div>
                          <Badge
                            className="shrink-0"
                            variant={
                              snapshot.settings.schedule === "Disabled"
                                ? "outline"
                                : "secondary"
                            }
                          >
                            {snapshot.settings.schedule}
                          </Badge>
                        </div>
                        <div className="text-muted-foreground flex min-w-0 flex-col gap-1 px-2 text-sm">
                          <span className="text-xs font-medium">Created</span>
                          <time
                            className="break-words tabular-nums"
                            dateTime={parsed?.toISOString()}
                          >
                            {formatSnapshotDate(snapshot.date)}
                          </time>
                        </div>
                      </article>
                    );
                  })}
                </div>

                <footer className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-t pt-3">
                  <p
                    className="text-muted-foreground text-sm tabular-nums"
                    role="status"
                  >
                    {`Showing ${firstVisible}–${lastVisible} of ${total}`}
                  </p>
                  <div className="flex min-w-0 flex-wrap items-center gap-3 sm:justify-end">
                    <div className="flex items-center gap-2">
                      <label
                        htmlFor={`${id}-snapshot-page-size`}
                        className="text-muted-foreground text-sm"
                      >
                        Rows per page
                      </label>
                      <NativeSelect
                        id={`${id}-snapshot-page-size`}
                        className="w-20 [&_select]:min-h-11"
                        value={String(pageSize)}
                        onChange={(event) => {
                          const nextSize = SNAPSHOT_PAGE_SIZES.find(
                            (size) =>
                              String(size) === event.currentTarget.value,
                          );
                          if (nextSize === undefined) return;
                          setPageSize(nextSize);
                          setPageIndex(0);
                          setSelectedSnapshotId(null);
                        }}
                      >
                        {SNAPSHOT_PAGE_SIZES.map((size) => (
                          <NativeSelectOption key={size} value={String(size)}>
                            {size}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </div>
                    {total > 0 ? (
                      <PaginationControls
                        ariaLabel="Snapshot pages"
                        className="w-auto sm:justify-end"
                        pageCount={pageCount}
                        pageIndex={safePageIndex}
                        onPageIndexChange={(nextIndex) => {
                          setPageIndex(nextIndex);
                          setSelectedSnapshotId(null);
                        }}
                      />
                    ) : null}
                  </div>
                </footer>
              </>
            )}
          </div>
        </section>

        {selectedSnapshot ? (
          <section
            aria-label="Selected snapshot"
            className="bg-card min-w-0 overflow-hidden rounded-lg border"
          >
            <header className="flex flex-col gap-3 border-b p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-muted-foreground text-sm">
                  Selected snapshot
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Close selected snapshot"
                  className="size-11 shrink-0"
                  onClick={() => setSelectedSnapshotId(null)}
                >
                  <X aria-hidden="true" />
                </Button>
              </div>
              <h2 className="min-w-0 text-lg font-semibold break-words">
                {selectedSnapshot.name}
              </h2>
              <time
                className="text-muted-foreground text-sm tabular-nums"
                dateTime={parseSnapshotDate(
                  selectedSnapshot.date,
                )?.toISOString()}
              >
                {formatSnapshotDate(selectedSnapshot.date)}
              </time>
              <p className="text-muted-foreground text-sm">
                Scope: Manage settings only
              </p>
            </header>

            <div className="flex min-w-0 flex-col gap-4 p-4">
              <div className="flex min-w-0 items-center justify-between gap-3">
                <h3 className="font-semibold">Saved configuration</h3>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        ref={snapshotActionsTriggerRef}
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label="Snapshot actions"
                        className="size-11 shrink-0"
                      />
                    }
                  >
                    <MoreHorizontal aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuItem
                      onClick={() => actions.downloadSnapshot(selectedSnapshot)}
                    >
                      <Download aria-hidden="true" /> Download JSON
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        actions.setRenameTarget(selectedSnapshot);
                        actions.setRenameError("");
                        actions.setRenameValue(selectedSnapshot.name);
                      }}
                    >
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={(event) =>
                        actions.requestConfirm(
                          {
                            title: "Delete snapshot",
                            description: `Delete ${selectedSnapshot.name}? This removes only this configuration snapshot.`,
                            confirmLabel: `Delete ${selectedSnapshot.name}`,
                            action: async () => {
                              const result =
                                await actions.manage.deleteSnapshot(
                                  selectedSnapshot.id,
                                );
                              actions.setError(result.ok ? "" : result.message);
                              actions.setNotice(
                                result.ok ? result.message : "",
                              );
                              if (result.ok) setSelectedSnapshotId(null);
                              return result.ok;
                            },
                          },
                          event,
                        )
                      }
                    >
                      <Trash2 aria-hidden="true" /> Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              <dl className="min-w-0 divide-y rounded-lg border">
                {snapshotSettingRows(
                  selectedSnapshot,
                  SNAPSHOT_PRIMARY_SETTINGS,
                )}
              </dl>
              <details className="min-w-0 rounded-lg border">
                <summary className="min-h-11 cursor-pointer px-3 py-2.5 font-medium">
                  More saved settings
                </summary>
                <dl className="min-w-0 divide-y border-t">
                  {snapshotSettingRows(
                    selectedSnapshot,
                    SNAPSHOT_ADDITIONAL_SETTINGS,
                  )}
                </dl>
              </details>

              <p className="text-muted-foreground text-sm">
                Compare the saved settings before restoring.
              </p>
              <div className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-1 2xl:grid-cols-2">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 min-w-0"
                  onClick={() => actions.setCompareTarget(selectedSnapshot)}
                >
                  <FileSearch data-icon="inline-start" /> Compare with current
                </Button>
                <Button
                  type="button"
                  className="min-h-11 min-w-0"
                  onClick={(event) =>
                    actions.requestRestore(selectedSnapshot, event)
                  }
                >
                  <RotateCcw data-icon="inline-start" /> Restore snapshot
                </Button>
              </div>
            </div>
          </section>
        ) : null}
      </div>

      <Dialog
        open={createOpen}
        dismissible={!creating}
        onOpenChange={(open) => {
          if (!creatingRef.current) setCreateOpen(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create snapshot</DialogTitle>
            <DialogDescription>
              Save the current Manage settings. Unsaved drafts are not included.
            </DialogDescription>
          </DialogHeader>
          <form className="mt-4 flex flex-col gap-4" onSubmit={createSnapshot}>
            <fieldset disabled={creating} className="min-w-0">
              <Field>
                <FieldLabel htmlFor={`${id}-create-snapshot-name`}>
                  Snapshot name
                </FieldLabel>
                <Input
                  id={`${id}-create-snapshot-name`}
                  value={createName}
                  aria-describedby={`${id}-create-snapshot-description`}
                  onChange={(event) => setCreateName(event.target.value)}
                  placeholder="Manual snapshot"
                  className="min-h-11"
                />
                <FieldDescription
                  id={`${id}-create-snapshot-description`}
                  className="sr-only"
                >
                  Give this saved Manage settings snapshot a name.
                </FieldDescription>
              </Field>
            </fieldset>
            <DialogFooter className="mt-0">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={creating}
                onClick={() => setCreateOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" className="min-h-11" disabled={creating}>
                {creating ? "Creating…" : "Create snapshot"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export function SnapshotScheduleForm({
  form,
  settings,
  retention,
  actions,
}: SnapshotScheduleFormProps) {
  const id = useId();
  const [simulating, setSimulating] = useState(false);
  const simulatingRef = useRef(false);
  const { dirty, saveSection, current, errors, changeSetting, clearDraft } =
    form;

  async function simulateScheduledBackup() {
    if (simulatingRef.current || settings.schedule === "Disabled") return;
    simulatingRef.current = true;
    setSimulating(true);
    try {
      await actions.addSnapshot(
        `Scheduled snapshot · ${new Date().toLocaleDateString()}`,
      );
    } finally {
      simulatingRef.current = false;
      setSimulating(false);
    }
  }

  return (
    <form
      className="flex min-w-0 flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void saveSection("backup");
      }}
    >
      <SettingSelect
        id={`${id}-backup-schedule`}
        label="Backup schedule"
        value={current.schedule}
        error={errors.schedule}
        options={["Disabled", "Daily at 02:00", "Weekly on Sunday at 02:00"]}
        onChange={(value) => changeSetting("backup", "schedule", value)}
      />
      <SettingSelect
        id={`${id}-retention-period`}
        label="Retention period"
        value={current.retention}
        error={errors.retention}
        options={["7 days", "30 days", "90 days"]}
        onChange={(value) => changeSetting("backup", "retention", value)}
      />
      <SettingActions
        dirty={dirty}
        onDiscard={() => clearDraft("backup")}
        onSave={() => {
          void saveSection("backup");
        }}
      />

      <Separator className="my-1" />
      <div className="flex min-w-0 flex-col items-start gap-3">
        <div>
          <p className="font-medium">Maintenance preview</p>
          <p className="text-muted-foreground mt-1 text-sm">
            {settings.schedule === "Disabled"
              ? "The saved automatic-backup preference is disabled. No background job runs."
              : `Saved schedule: ${settings.schedule} (${settings.timezone}). No background job runs.`}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={settings.schedule === "Disabled" || simulating}
          onClick={() => void simulateScheduledBackup()}
        >
          <Clock3 data-icon="inline-start" />
          {simulating
            ? "Creating scheduled snapshot…"
            : "Simulate scheduled backup"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 px-0"
          onClick={() =>
            actions.setPreview({
              title: "Retention preview",
              description:
                "This preview uses saved retention settings. It never deletes snapshots automatically.",
              body: (
                <div className="flex flex-col gap-3">
                  <p>
                    {retention.candidates.length
                      ? `${retention.candidates.length} snapshot(s) would be candidates after ${retention.days} days.`
                      : `No snapshots are currently older than ${retention.days} days.`}
                  </p>
                  {retention.candidates.map((candidate) => (
                    <Badge key={candidate.id} variant="outline">
                      {candidate.name} · review manually
                    </Badge>
                  ))}
                </div>
              ),
            })
          }
        >
          Preview retention candidates
        </Button>
      </div>
    </form>
  );
}
