"use client";
import { useDisplayRegion } from "@/components/use-display-region";

import { Suspense, useCallback, useEffect, useState } from "react";
import type { Route } from "next";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useWorkspaceNavigationGuard,
  useWorkspaceNavigationRequest,
  type WorkspaceNavigationGuard,
} from "@/components/workspace-navigation-guard";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LayoutDashboard, RefreshCw } from "lucide-react";
import { authMeOptions } from "@/components/systems/openview/adapters/openview-queries";
import { departmentNavigationOptions } from "@/components/department-navigation";
import { isRefusal } from "@/components/department-navigation-model";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingRegion } from "@/components/ui/loading-region";
import { workspaceCalendarQueryOptions } from "../../manage/adapters/workspace-api";
import {
  subscribeWorkspaceInvalidations,
  type WorkspaceInvalidation,
} from "../../shared/adapters/invalidation-events";
import { useInvalidationRefresh } from "../../shared/adapters/use-invalidation-refresh";
import { Skeleton } from "@/components/ui/skeleton";
import { linkTabsListClass } from "@/components/ui/link-tabs";
import { cn } from "@/lib/utils";
import type { BoardManagementBoard } from "../adapters/board-management-api";
import {
  ServerBackedBoardPosts,
  type PostParams,
} from "./server-backed-board-posts";
import {
  ServerBackedBoardCalendar,
  type BoardCalendarParams,
} from "./server-backed-board-calendar";
import { ServerBackedBoardSettings } from "./server-backed-board-management";
import { BoardNewProjectDialog } from "./board-new-project-dialog";
import {
  boardSettingsTab,
  type BoardSettingsTab,
} from "../domain/board-settings";
import { ServerBackedMyCalendar } from "./server-backed-my-calendar";
import {
  ServerBackedBoardKanban,
  type BoardKanbanParams,
} from "./server-backed-board-kanban";
import {
  ServerBackedBoardGantt,
  type BoardGanttParams,
} from "./server-backed-board-gantt";
import { BoardDirectory } from "./board-directory";
import { BoardPageHeader, boardPageTitle } from "./board-page-header";
import { BoardEmpty, ConfirmAction } from "./ui";
import {
  BOARD_UNAVAILABLE,
  canonicalBoardUrl,
  parseBoardRoute,
  resolveBoardSection,
  useServerBoardsResource,
  type BoardSection,
} from "../hooks/use-server-boards";

// From 1280px the page is still: the region fills the height under the
// header, and its content is the one panel that scrolls (BR8).
const boardsRegionClass =
  "flex min-w-0 flex-col xl:min-h-0 xl:flex-1 *:relative *:flex *:min-w-0 *:flex-col *:gap-5 xl:*:min-h-0 xl:*:flex-1 xl:*:overflow-y-auto xl:*:overscroll-contain";
const pageClass = "boards-ui flex min-w-0 flex-col xl:min-h-0 xl:flex-1";

/**
 * The page frame while a Board loads: its title, a meta line, and the tab
 * row, held at the loaded header's height so nothing shifts when it lands.
 * Without a Board to wait for (refused, missing, none), only the title stays.
 */
const BOARD_REFUSED_TITLE = "This board is not available.";
/** My calendar's draft owner in the unsaved-changes guard. */
const MY_CALENDAR_DRAFT = "my-calendar";

function BoardsLoadingHeader({
  placeholders = true,
}: {
  placeholders?: boolean;
}) {
  return (
    <div className="slim-ui shrink-0">
      <PageHeader
        className="mb-3"
        title="Boards"
        description={
          placeholders ? (
            <span
              aria-hidden="true"
              className="bg-foreground/10 inline-block h-4 w-48 animate-pulse rounded-[var(--radius)] align-middle motion-reduce:animate-none"
            />
          ) : undefined
        }
      />
      {placeholders ? (
        <div aria-hidden="true" className={cn(linkTabsListClass, "mb-3")}>
          <span className="min-h-11 w-40 xl:min-h-7" />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Matches the section a loaded Board opens on: the section in the link when
 * there is one, otherwise Posts.
 */
function BoardsSkeleton({ section }: { section: BoardSection | null }) {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Skeleton className="h-11 w-48" />
      {section === "calendar" || section === "kanban" || section === "gantt" ? (
        <Skeleton className="h-[28rem] rounded-xl" />
      ) : (
        <div className="flex min-w-0 flex-col gap-4">
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
        </div>
      )}
    </div>
  );
}

function ServerBackedBoardsLoading() {
  return (
    <div className={pageClass}>
      <BoardsLoadingHeader />
      <LoadingRegion
        loading
        label="Loading boards"
        skeleton={<BoardsSkeleton section={null} />}
        className={boardsRegionClass}
      />
    </div>
  );
}

function ServerBackedBoardsContent() {
  const router = useRouter();
  const requestNavigation = useWorkspaceNavigationRequest();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const route = parseBoardRoute(search);
  const [creating, setCreating] = useState(false);
  const [primarySlot, setPrimarySlot] = useState<HTMLElement | null>(null);
  const [draftState, setDraftState] = useState<{
    boardId: string;
    section: BoardSection;
    dirty: boolean;
    pending: boolean;
  } | null>(null);
  const [pendingNavigation, setPendingNavigation] = useState<
    (() => void) | null
  >(null);
  const resource = useServerBoardsResource(route);
  const identity = useQuery(authMeOptions());
  const isAdmin = identity.data?.role === "admin";
  const departments = useQuery({
    ...departmentNavigationOptions(),
    enabled: false,
  });
  const board = resource.selectedBoard;
  const boardId = board?.id ?? null;
  const departmentIndex =
    board?.departmentId && !isRefusal(departments.error)
      ? (departments.data?.items.findIndex(
          (entry) => entry.id === board.departmentId,
        ) ?? -1)
      : -1;
  const invalidatesPosts = useCallback(
    (event: WorkspaceInvalidation) =>
      event.type === "invalidate" &&
      event.boardId === boardId &&
      event.entity === "board_posts",
    [boardId],
  );
  const postsLiveKey = useInvalidationRefresh(boardId, invalidatesPosts);
  const [manualLiveKey, setManualLiveKey] = useState(0);
  const refreshBoard = useCallback(() => {
    resource.refresh();
    setManualLiveKey((value) => value + 1);
  }, [resource.refresh]);
  const invalidatesEvents = useCallback(
    (event: WorkspaceInvalidation) =>
      event.type === "invalidate" &&
      event.boardId === boardId &&
      (event.entity === "board_events" || event.entity === "boards"),
    [boardId],
  );
  const eventsLiveKey = useInvalidationRefresh(boardId, invalidatesEvents);
  const canManage = board?.level === "manage";
  // Board settings is open on the tab in the address, for managers only.
  const settingsTab = canManage ? boardSettingsTab(search) : null;
  const section = resolveBoardSection(route);
  const myCalendar = route.kind === "my-calendar";
  const regionActive = board !== null || myCalendar;
  const workspaceCalendar = useQuery({
    ...workspaceCalendarQueryOptions(),
    enabled: regionActive,
    // The server's current day rolls over without an ORM invalidation event.
    // Preserve Calendar's existing minute refresh only while it is visible.
    refetchInterval: regionActive && section === "calendar" ? 60_000 : false,
  });
  const queryClient = useQueryClient();
  const displayRegion = useDisplayRegion(workspaceCalendar.data);
  const refreshWorkspaceCalendar = useCallback(() => {
    const queryKey = workspaceCalendarQueryOptions().queryKey;
    const cold = queryClient
      .getQueryCache()
      .findAll({ queryKey, fetchStatus: "fetching" })
      .filter((query) => query.state.data === undefined);
    void Promise.all(cold.map((query) => query.cancel({ revert: true }))).then(
      () => queryClient.invalidateQueries({ queryKey }),
    );
  }, [queryClient]);
  useEffect(() => {
    if (!regionActive) return;
    const queryKey = workspaceCalendarQueryOptions().queryKey;
    const unsubscribe = subscribeWorkspaceInvalidations((event) => {
      if (event.type === "resync" || event.entity === "workspace_profiles")
        refreshWorkspaceCalendar();
    }, refreshWorkspaceCalendar);
    return () => {
      unsubscribe();
      void queryClient.invalidateQueries({ queryKey, refetchType: "none" });
    };
  }, [regionActive, queryClient, refreshWorkspaceCalendar]);

  // My calendar's event draft is the page's own, not one board's.
  const draftOwner = myCalendar ? MY_CALENDAR_DRAFT : (board?.id ?? null);
  const currentDraftState =
    draftState !== null &&
    draftOwner !== null &&
    draftState.boardId === draftOwner &&
    draftState.section === section
      ? draftState
      : null;
  const guardWorkspaceNavigation = useCallback<WorkspaceNavigationGuard>(
    (_href, resume) => {
      if (currentDraftState?.pending) return false;
      if (!currentDraftState?.dirty) return true;
      setPendingNavigation(() => resume);
      return false;
    },
    [currentDraftState, setPendingNavigation],
  );
  useWorkspaceNavigationGuard(guardWorkspaceNavigation);
  const updateBoardParams = useCallback(
    (
      changes: Record<string, string | null | undefined>,
      history: "push" | "replace" = "replace",
    ) => {
      const next = new URLSearchParams(search);
      for (const [name, value] of Object.entries(changes)) {
        if (value === undefined) continue;
        if (value === null) next.delete(name);
        else next.set(name, value);
      }
      const href = `/boards?${next.toString()}` as Route;
      if (href === `/boards?${search}`) return;
      const resume = () =>
        history === "push"
          ? router.push(href, { scroll: false })
          : router.replace(href, { scroll: false });
      if (requestNavigation(href, resume)) resume();
    },
    [requestNavigation, router, search],
  );
  // The calendar's view, Show filter, and event sheet keep any draft (the
  // editor is a modal dialog), so they skip the unsaved-changes guard.
  const updateCalendarParams = useCallback(
    (changes: BoardCalendarParams) => {
      const next = new URLSearchParams(search);
      for (const [name, value] of Object.entries(changes)) {
        if (value === undefined) continue;
        if (value === null) next.delete(name);
        else next.set(name, value);
      }
      const href = `/boards?${next.toString()}` as Route;
      if (href !== `/boards?${search}`) router.replace(href, { scroll: false });
    },
    [router, search],
  );
  // Kanban filters, Gantt zoom and grouping, and `card=` are the viewer's
  // own: no draft to guard, and staged Gantt changes stay.
  const updateKanbanParams = useCallback(
    (changes: BoardKanbanParams & BoardGanttParams) => {
      const next = new URLSearchParams(search);
      for (const [name, value] of Object.entries(changes)) {
        if (value === undefined) continue;
        next.delete(name);
        if (Array.isArray(value))
          for (const item of value) next.append(name, item);
        else if (value !== null) next.set(name, value);
      }
      const href = `/boards?${next.toString()}` as Route;
      if (href !== `/boards?${search}`) router.replace(href, { scroll: false });
    },
    [router, search],
  );
  const updatePostParams = useCallback(
    ({ history, ...params }: PostParams) => updateBoardParams(params, history),
    [updateBoardParams],
  );
  const updateDraftState = useCallback(
    (
      boardId: string,
      draftSection: BoardSection,
      dirty: boolean,
      pending: boolean,
    ) => {
      setDraftState((current) => {
        if (!dirty && !pending)
          return current?.boardId === boardId &&
            current.section === draftSection
            ? null
            : current;
        if (
          current?.boardId === boardId &&
          current.section === draftSection &&
          current.dirty === dirty &&
          current.pending === pending
        )
          return current;
        return { boardId, section: draftSection, dirty, pending };
      });
    },
    [setDraftState],
  );
  const onCalendarDraftStateChange = useCallback(
    (boardId: string, dirty: boolean, pending: boolean) =>
      updateDraftState(boardId, "calendar", dirty, pending),
    [updateDraftState],
  );
  const onMyCalendarDraftStateChange = useCallback(
    (dirty: boolean, pending: boolean) =>
      updateDraftState(MY_CALENDAR_DRAFT, "calendar", dirty, pending),
    [updateDraftState],
  );
  const departmentIndexOf = useCallback(
    (departmentId: string) => {
      if (isRefusal(departments.error)) return null;
      const index =
        departments.data?.items.findIndex(
          (entry) => entry.id === departmentId,
        ) ?? -1;
      return index >= 0 ? index : null;
    },
    [departments.data, departments.error],
  );
  const onGanttDraftStateChange = useCallback(
    (dirty: boolean, pending: boolean) => {
      if (boardId) updateDraftState(boardId, "gantt", dirty, pending);
    },
    [boardId, updateDraftState],
  );
  const onPostDraftStateChange = useCallback(
    (boardId: string, dirty: boolean, pending: boolean) =>
      updateDraftState(boardId, "posts", dirty, pending),
    [updateDraftState],
  );

  useEffect(() => {
    if (!currentDraftState?.dirty && !currentDraftState?.pending) return;
    const preventUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [currentDraftState]);

  // Each Board has one address (BR41): once it is read, an address that
  // names it another way (a department's or Company's Board id, no section)
  // is replaced in place, keeping the post, the event and the rest.
  useEffect(() => {
    if (
      !board ||
      route.kind === "invalid-board" ||
      route.kind === "all" ||
      route.kind === "my-calendar"
    )
      return;
    const target = canonicalBoardUrl(board, section, search);
    if (target !== `/boards?${search}`)
      router.replace(target, { scroll: false });
  }, [board, route.kind, router, section, search]);

  // Opening, switching and closing Board settings keep any draft on the page
  // under it, so they skip the unsaved-changes guard.
  const setSettingsTab = useCallback(
    (tab: BoardSettingsTab | null) => {
      const next = new URLSearchParams(search);
      if (tab) next.set("settings", tab);
      else next.delete("settings");
      const href = `/boards?${next.toString()}` as Route;
      if (href !== `/boards?${search}`) router.replace(href, { scroll: false });
    },
    [router, search],
  );

  const listPending =
    resource.list.data === null &&
    (resource.list.status === "idle" || resource.list.status === "loading");
  const awaitingList =
    (route.kind === "none" || route.kind === "department") &&
    resource.candidate === null &&
    !resource.departmentMissing &&
    (listPending || route.kind === "department");
  const awaitingDetail =
    resource.candidate !== null &&
    board === null &&
    (resource.detail.status === "idle" || resource.detail.status === "loading");
  const loading =
    route.kind !== "all" &&
    route.kind !== "my-calendar" &&
    !(route.kind === "department" && resource.list.status === "error") &&
    (awaitingList || awaitingDetail);

  const detailFailed =
    resource.candidate !== null &&
    board === null &&
    resource.detail.status === "error";
  const refused =
    route.kind === "invalid-board" ||
    resource.departmentMissing ||
    (detailFailed && resource.detailDenied);
  const unavailable = refused || detailFailed;
  const noBoards =
    !resource.list.error &&
    resource.list.data !== null &&
    resource.list.data.pagination.total === 0;

  // A new project board opens with Board settings on Access, where its
  // groups are added next (BR30).
  function openCreatedBoard(target: BoardManagementBoard) {
    const href = canonicalBoardUrl(target, "posts", "settings=access");
    const resume = () => router.push(href, { scroll: false });
    if (requestNavigation(href, resume)) resume();
  }

  // A refresh in progress, or one that failed while the last Board stays on
  // screen, shows in the meta line (BR7).
  const refreshError = board
    ? (resource.detail.error ?? resource.list.error)
    : null;
  // Both live regions stay mounted, so a screen reader hears each change.
  const refreshStatus = (
    <>
      <span role="status">
        {board && !refreshError && resource.detail.status === "loading"
          ? "Refreshing…"
          : ""}
      </span>
      <span role="alert" className="inline-flex items-center gap-2">
        {refreshError ? (
          <>
            <span className="text-danger-text">{refreshError}</span>
            <Button
              type="button"
              variant="ghost"
              className="min-h-11 px-2 xl:min-h-8"
              onClick={refreshBoard}
            >
              Retry
            </Button>
          </>
        ) : null}
      </span>
    </>
  );

  const createDialog = (
    <BoardNewProjectDialog
      open={creating}
      onOpenChange={(next) => setCreating(next)}
      onCreated={(created) => {
        refreshBoard();
        openCreatedBoard(created);
      }}
    />
  );

  if (myCalendar)
    return (
      <div className={pageClass}>
        <ServerBackedMyCalendar
          listed={resource.listItems}
          departmentIndexOf={departmentIndexOf}
          workspaceCalendar={workspaceCalendar.data}
          workspaceDateError={workspaceCalendar.isError}
          onRetryWorkspaceDate={() => void workspaceCalendar.refetch()}
          selectedEventId={searchParams.get("event")}
          view={searchParams.get("view")}
          show={searchParams.get("show")}
          onParams={updateCalendarParams}
          onDraftStateChange={onMyCalendarDraftStateChange}
          regionClassName={boardsRegionClass}
        />
        <ConfirmAction
          open={pendingNavigation !== null}
          title="Discard unsaved board changes?"
          description="Your unsaved event or post changes will be lost."
          action="Discard changes"
          disabled={currentDraftState?.pending ?? false}
          onCancel={() => setPendingNavigation(null)}
          onConfirm={() => {
            const resume = pendingNavigation;
            setPendingNavigation(null);
            resume?.();
          }}
        />
      </div>
    );

  if (route.kind === "all")
    return (
      <div className={pageClass}>
        <BoardDirectory isAdmin={isAdmin} onCreate={() => setCreating(true)} />
        {createDialog}
      </div>
    );

  return (
    <div className={pageClass}>
      {board && !loading ? (
        <BoardPageHeader
          board={board}
          departmentIndex={departmentIndex >= 0 ? departmentIndex : null}
          section={section}
          status={refreshStatus}
          guest={identity.data?.role === "guest"}
          onOpenSettings={canManage ? () => setSettingsTab("details") : null}
          primary={<div ref={setPrimarySlot} className="contents" />}
        />
      ) : (
        <BoardsLoadingHeader placeholders={loading} />
      )}
      {createDialog}
      {board && canManage && (
        <ServerBackedBoardSettings
          board={board}
          isAdmin={isAdmin}
          tab={settingsTab}
          onTabChange={setSettingsTab}
          onClose={() => setSettingsTab(null)}
          refreshKey={resource.detail.sequence}
          region={displayRegion}
          onUpdated={(updated) => {
            resource.applyBoardMutation(updated);
            refreshBoard();
          }}
          onAccessDenied={() => {
            setSettingsTab(null);
            resource.revokeAccess();
          }}
          onPurged={() => {
            const href: Route = "/boards";
            const resume = () => {
              router.push(href, { scroll: false });
              refreshBoard();
            };
            if (requestNavigation(href, resume)) resume();
          }}
        />
      )}

      <LoadingRegion
        loading={loading}
        label="Loading boards"
        skeleton={
          <BoardsSkeleton
            section={route.kind === "invalid-board" ? null : route.section}
          />
        }
        className={boardsRegionClass}
      >
        {!board ? (
          <BoardEmpty
            title={
              refused
                ? BOARD_REFUSED_TITLE
                : unavailable
                  ? "This board could not be loaded"
                  : resource.list.error
                    ? "Boards could not be loaded"
                    : noBoards
                      ? "No active boards"
                      : BOARD_REFUSED_TITLE
            }
            description={
              refused
                ? BOARD_UNAVAILABLE
                : unavailable
                  ? resource.detail.error || "Could not load this board."
                  : resource.list.error
                    ? "The board list could not be loaded. Try again."
                    : noBoards
                      ? "You cannot open any active board. Ask an administrator for access."
                      : BOARD_UNAVAILABLE
            }
            icon={<LayoutDashboard aria-hidden="true" />}
          >
            {refused ? (
              <Button asChild variant="outline" className="min-h-11 xl:min-h-8">
                <Link href="/boards">Go to Company board</Link>
              </Button>
            ) : unavailable || resource.list.error ? (
              <Button
                variant="outline"
                className="min-h-11 xl:min-h-8"
                onClick={refreshBoard}
              >
                <RefreshCw data-icon="inline-start" /> Retry
              </Button>
            ) : null}
            {/* An empty workspace has its first step in view. The server
                still decides who may create. */}
            {!unavailable && !resource.list.error && noBoards && isAdmin && (
              <Button className="min-h-11" onClick={() => setCreating(true)}>
                New project board
              </Button>
            )}
          </BoardEmpty>
        ) : (
          <>
            {board.status === "archived" && (
              <Alert>This board is archived and read-only.</Alert>
            )}
            {section !== "calendar" && workspaceCalendar.isError && (
              <Alert variant="destructive">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {workspaceCalendar.data
                      ? "Regional settings could not be refreshed. The last loaded settings are still in use."
                      : "Could not load regional settings. Dates are unavailable."}
                  </span>
                  <Button
                    variant="outline"
                    className="min-h-11"
                    onClick={() => void workspaceCalendar.refetch()}
                  >
                    Retry regional settings
                  </Button>
                </div>
              </Alert>
            )}

            {section === "gantt" ? (
              <ServerBackedBoardGantt
                key={board.id}
                board={board}
                search={search}
                region={displayRegion ?? { timezone: "UTC", locale: "en-US" }}
                today={workspaceCalendar.data?.today ?? ""}
                weekStart={workspaceCalendar.data?.week_start ?? "monday"}
                kanbanHref={canonicalBoardUrl(board, "kanban")}
                onParams={updateKanbanParams}
                onDraftStateChange={onGanttDraftStateChange}
              />
            ) : section === "kanban" ? (
              <ServerBackedBoardKanban
                key={board.id}
                board={board}
                search={search}
                region={displayRegion ?? { timezone: "UTC", locale: "en-US" }}
                today={workspaceCalendar.data?.today ?? ""}
                weekStart={workspaceCalendar.data?.week_start ?? "monday"}
                onParams={updateKanbanParams}
              />
            ) : section === "calendar" ? (
              <ServerBackedBoardCalendar
                key={board.id}
                primarySlot={primarySlot}
                workspaceCalendar={workspaceCalendar.data}
                workspaceDateError={workspaceCalendar.isError}
                onRetryWorkspaceDate={() => void workspaceCalendar.refetch()}
                boardId={board.id}
                boardActive={board.status === "active"}
                liveKey={eventsLiveKey + manualLiveKey}
                refreshKey={resource.detail.sequence}
                onDraftStateChange={onCalendarDraftStateChange}
                selectedEventId={searchParams.get("event")}
                view={searchParams.get("view")}
                show={searchParams.get("show")}
                onParams={updateCalendarParams}
                calendarName={boardPageTitle(board)}
                departmentIndex={departmentIndex >= 0 ? departmentIndex : null}
                departmentIndexOf={departmentIndexOf}
              />
            ) : (
              <ServerBackedBoardPosts
                board={board}
                region={displayRegion}
                refreshKey={postsLiveKey + manualLiveKey}
                selectedPostId={searchParams.get("post")}
                show={searchParams.get("show")}
                onParams={updatePostParams}
                primarySlot={primarySlot}
                guest={identity.data?.role === "guest"}
                onChanged={refreshBoard}
                onAccessDenied={(deniedId) => {
                  if (board.id !== deniedId) return;
                  resource.revokeAccess();
                }}
                onDraftStateChange={onPostDraftStateChange}
              />
            )}
          </>
        )}
      </LoadingRegion>
      <ConfirmAction
        open={pendingNavigation !== null}
        title="Discard unsaved board changes?"
        description={
          currentDraftState?.section === "gantt"
            ? "Your staged date changes on the Gantt will be lost."
            : "Your unsaved event or post changes will be lost."
        }
        action="Discard changes"
        disabled={currentDraftState?.pending ?? false}
        onCancel={() => setPendingNavigation(null)}
        onConfirm={() => {
          const resume = pendingNavigation;
          setPendingNavigation(null);
          resume?.();
        }}
      />
    </div>
  );
}

export default function ServerBackedBoards() {
  return (
    <Suspense fallback={<ServerBackedBoardsLoading />}>
      <ServerBackedBoardsContent />
    </Suspense>
  );
}
