"use client";
import {
  Clock3,
  Download,
  FileSearch,
  HardDrive,
  History,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { type MouseEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type useManageController,
  type ManageSettings,
  type ManageSnapshot,
} from "./state";
import {
  SettingSelect,
  SettingActions,
  SectionHeading,
  type ConfirmState,
  type PreviewState,
  type SettingsPanelForm,
} from "./panel-ui";
type BackupPanelProps = {
  form: SettingsPanelForm;
  panelClass: string;
  snapshotList: {
    backups: ManageSnapshot[];
    snapshotName: string;
    setSnapshotName: import("react").Dispatch<
      import("react").SetStateAction<string>
    >;
    visibleBackups: readonly ManageSnapshot[];
    setSnapshotPage: import("react").Dispatch<
      import("react").SetStateAction<number>
    >;
    firstVisibleSnapshot: number;
    lastVisibleSnapshot: number;
    snapshotPageCount: number;
    safeSnapshotPage: number;
  };
  actions: {
    addSnapshot: (name: string) => Promise<boolean>;
    requestRestore: (
      snapshot: ManageSnapshot,
      event: MouseEvent<HTMLElement>,
    ) => void;
    setCompareTarget: import("react").Dispatch<
      import("react").SetStateAction<ManageSnapshot | null>
    >;
    downloadSnapshot: (snapshot: ManageSnapshot) => void;
    renameOpener: import("react").RefObject<HTMLElement | null>;
    setRenameTarget: import("react").Dispatch<
      import("react").SetStateAction<ManageSnapshot | null>
    >;
    setRenameError: import("react").Dispatch<
      import("react").SetStateAction<string>
    >;
    setRenameValue: import("react").Dispatch<
      import("react").SetStateAction<string>
    >;
    requestConfirm: (
      next: ConfirmState,
      event?: MouseEvent<HTMLElement>,
    ) => void;
    manage: Pick<ReturnType<typeof useManageController>, "deleteSnapshot">;
    setError: import("react").Dispatch<import("react").SetStateAction<string>>;
    setNotice: import("react").Dispatch<import("react").SetStateAction<string>>;
    setPreview: import("react").Dispatch<
      import("react").SetStateAction<PreviewState | null>
    >;
  };
  settings: ManageSettings;
  retention: {
    days: number;
    candidates: ManageSnapshot[];
    count: number;
    schedule: string;
    timezone: string;
  };
};
export function BackupPanel({
  form,
  panelClass,
  snapshotList,
  actions,
  settings,
  retention,
}: BackupPanelProps) {
  const { dirty, saveSection, current, errors, changeSetting, clearDraft } =
    form;
  const {
    backups,
    snapshotName,
    setSnapshotName,
    visibleBackups,
    setSnapshotPage,
    firstVisibleSnapshot,
    lastVisibleSnapshot,
    snapshotPageCount,
    safeSnapshotPage,
  } = snapshotList;
  const {
    addSnapshot,
    requestRestore,
    setCompareTarget,
    downloadSnapshot,
    renameOpener,
    setRenameTarget,
    setRenameError,
    setRenameValue,
    requestConfirm,
    manage,
    setError,
    setNotice,
    setPreview,
  } = actions;
  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby="manage-backup-heading"
    >
      <SectionHeading
        title="Backup & recovery"
        description="Create and restore configuration snapshots. Application records, people, sessions and database files are outside this local settings boundary."
        dirty={dirty}
      />
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]">
        <Card className={panelClass}>
          <CardHeader className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle id="manage-backup-heading">
                Configuration snapshots
              </CardTitle>
              <CardDescription className="md:sr-only">
                Snapshots contain saved Manage settings only. Unsaved drafts are
                never included.
              </CardDescription>
            </div>
            <Badge variant="outline">{backups.length} saved</Badge>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Field>
              <FieldLabel htmlFor="snapshot-name">Snapshot name</FieldLabel>
              <Input
                id="snapshot-name"
                value={snapshotName}
                aria-describedby="snapshot-name-description"
                onChange={(event) => setSnapshotName(event.target.value)}
                className="min-h-11"
                placeholder="Manual snapshot"
              />
              <FieldDescription
                id="snapshot-name-description"
                className="md:sr-only"
              >
                Use a name that explains the configuration checkpoint.
              </FieldDescription>
            </Field>
            <Button
              type="button"
              className="min-h-11 self-start"
              onClick={async () => {
                if (await addSnapshot(snapshotName)) setSnapshotName("");
              }}
            >
              <HardDrive data-icon="inline-start" /> Create backup
            </Button>
            {backups.length ? (
              <>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Snapshot</TableHead>
                      <TableHead>Scope</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleBackups.map((backup) => {
                      const recovery = backup.name.startsWith("Before ");
                      return (
                        <TableRow key={backup.id}>
                          <TableCell className="whitespace-normal">
                            <div className="flex min-w-44 flex-col gap-1 md:min-w-36">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="font-medium">{backup.name}</p>
                                <Badge
                                  variant={recovery ? "warning" : "secondary"}
                                >
                                  {recovery ? "Recovery" : "Configuration"}
                                </Badge>
                              </div>
                              <p className="text-muted-foreground text-xs">
                                {backup.date}
                              </p>
                            </div>
                          </TableCell>
                          <TableCell className="text-sm whitespace-normal">
                            Saved Manage settings only
                          </TableCell>
                          <TableCell>
                            <Badge variant="success">Complete</Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex min-w-max flex-wrap justify-end gap-2">
                              <Button
                                type="button"
                                size="icon"
                                variant="outline"
                                className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                                aria-label={`Restore ${backup.name}`}
                                title={`Restore ${backup.name}`}
                                onClick={(event) =>
                                  requestRestore(backup, event)
                                }
                              >
                                <RotateCcw aria-hidden="true" />
                              </Button>
                              <Button
                                type="button"
                                size="icon"
                                variant="outline"
                                className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                                aria-label={`Compare ${backup.name}`}
                                title={`Compare ${backup.name}`}
                                onClick={() => setCompareTarget(backup)}
                              >
                                <FileSearch aria-hidden="true" />
                              </Button>
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                                aria-label={`Download ${backup.name}`}
                                title={`Download ${backup.name}`}
                                onClick={() => downloadSnapshot(backup)}
                              >
                                <Download aria-hidden="true" />
                              </Button>
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                                aria-label={`Rename ${backup.name}`}
                                title={`Rename ${backup.name}`}
                                onClick={(event) => {
                                  renameOpener.current = event.currentTarget;
                                  setRenameTarget(backup);
                                  setRenameError("");
                                  setRenameValue(backup.name);
                                }}
                              >
                                <History aria-hidden="true" />
                              </Button>
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                className="text-destructive min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                                aria-label={`Delete ${backup.name}`}
                                title={`Delete ${backup.name}`}
                                onClick={(event) =>
                                  requestConfirm(
                                    {
                                      title: "Delete snapshot",
                                      description: `Delete ${backup.name}? This removes only this local configuration snapshot.`,
                                      confirmLabel: `Delete ${backup.name}`,
                                      action: async () => {
                                        const result =
                                          await manage.deleteSnapshot(
                                            backup.id,
                                          );
                                        setError(
                                          result.ok ? "" : result.message,
                                        );
                                        setNotice(
                                          result.ok ? result.message : "",
                                        );
                                        if (result.ok)
                                          setSnapshotPage((currentPage) =>
                                            Math.min(
                                              currentPage,
                                              Math.max(
                                                1,
                                                Math.ceil(
                                                  (backups.length - 1) / 2,
                                                ),
                                              ),
                                            ),
                                          );

                                        return result.ok;
                                      },
                                    },
                                    event,
                                  )
                                }
                              >
                                <Trash2 aria-hidden="true" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
                <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
                  <p className="text-muted-foreground text-sm">
                    Showing {firstVisibleSnapshot}–{lastVisibleSnapshot} of{" "}
                    {backups.length} snapshots
                  </p>
                  {snapshotPageCount > 1 ? (
                    <Pagination
                      aria-label="Snapshot pages"
                      className="mx-0 w-auto justify-start sm:justify-end"
                    >
                      <PaginationContent>
                        <PaginationItem>
                          <PaginationPrevious
                            href="#configuration-snapshots"
                            aria-disabled={safeSnapshotPage === 1}
                            tabIndex={safeSnapshotPage === 1 ? -1 : undefined}
                            className={
                              safeSnapshotPage === 1
                                ? "pointer-events-none opacity-50"
                                : undefined
                            }
                            onClick={(event) => {
                              event.preventDefault();
                              if (safeSnapshotPage > 1)
                                setSnapshotPage(safeSnapshotPage - 1);
                            }}
                          />
                        </PaginationItem>
                        <PaginationItem>
                          <PaginationLink
                            href="#configuration-snapshots"
                            size="default"
                            isActive
                            aria-label={`Snapshot page ${safeSnapshotPage} of ${snapshotPageCount}`}
                            onClick={(event) => event.preventDefault()}
                          >
                            {safeSnapshotPage} / {snapshotPageCount}
                          </PaginationLink>
                        </PaginationItem>
                        <PaginationItem>
                          <PaginationNext
                            href="#configuration-snapshots"
                            aria-disabled={
                              safeSnapshotPage === snapshotPageCount
                            }
                            tabIndex={
                              safeSnapshotPage === snapshotPageCount
                                ? -1
                                : undefined
                            }
                            className={
                              safeSnapshotPage === snapshotPageCount
                                ? "pointer-events-none opacity-50"
                                : undefined
                            }
                            onClick={(event) => {
                              event.preventDefault();
                              if (safeSnapshotPage < snapshotPageCount)
                                setSnapshotPage(safeSnapshotPage + 1);
                            }}
                          />
                        </PaginationItem>
                      </PaginationContent>
                    </Pagination>
                  ) : null}
                </div>
              </>
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <HardDrive aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>No configuration snapshots yet</EmptyTitle>
                  <EmptyDescription>
                    Create a backup to keep a saved Manage configuration
                    checkpoint.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>
        <Card className={panelClass}>
          <CardHeader>
            <CardTitle>Automatic backups</CardTitle>
            <CardDescription>
              Schedule and retention settings are saved as local configuration.
              Nothing runs in the background.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                saveSection("backup");
              }}
            >
              <SettingSelect
                id="backup-schedule"
                label="Backup schedule"
                value={current.schedule}
                error={errors.schedule}
                options={[
                  "Disabled",
                  "Daily at 02:00",
                  "Weekly on Sunday at 02:00",
                ]}
                onChange={(value) => changeSetting("backup", "schedule", value)}
              />
              <SettingSelect
                id="retention-period"
                label="Retention period"
                value={current.retention}
                error={errors.retention}
                options={["7 days", "30 days", "90 days"]}
                onChange={(value) =>
                  changeSetting("backup", "retention", value)
                }
              />
              <SettingActions
                dirty={dirty}
                onDiscard={() => clearDraft("backup")}
                onSave={() => saveSection("backup")}
              />
            </form>
            <Separator className="my-3" />
            <div className="flex flex-col gap-3">
              <p className="text-sm font-medium">Maintenance preview</p>
              <p className="text-muted-foreground text-sm md:sr-only">
                {settings.schedule === "Disabled"
                  ? "The saved automatic-backup preference is disabled."
                  : `Saved schedule: ${settings.schedule} (${settings.timezone}). No background job runs.`}
              </p>
              <Button
                type="button"
                variant="outline"
                className="min-h-11 self-start"
                disabled={settings.schedule === "Disabled"}
                onClick={() =>
                  addSnapshot(
                    `Scheduled snapshot · ${new Date().toLocaleDateString()}`,
                  )
                }
              >
                <Clock3 data-icon="inline-start" /> Simulate scheduled backup
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="min-h-11 self-start"
                onClick={() =>
                  setPreview({
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
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
