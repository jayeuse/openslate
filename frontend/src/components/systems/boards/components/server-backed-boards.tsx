"use client";
import { useDisplayRegion } from "@/components/use-display-region";

import {
  Suspense,
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useWorkspaceNavigationGuard,
  useWorkspaceNavigationRequest,
  type WorkspaceNavigationGuard,
} from "@/components/workspace-navigation-guard";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  Eye,
  History,
  LayoutDashboard,
  RefreshCw,
  Settings2,
  X,
} from "lucide-react";
import { authMeOptions } from "@/components/systems/openview/adapters/openview-queries";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { LoadingRegion } from "@/components/ui/loading-region";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SearchSelect } from "@/components/ui/search-select";
import { workspaceCalendarQueryOptions } from "../../manage/adapters/workspace-api";
import {
  subscribeWorkspaceInvalidations,
  type WorkspaceInvalidation,
} from "../../shared/adapters/invalidation-events";
import { useInvalidationRefresh } from "../../shared/adapters/use-invalidation-refresh";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  BoardManagementBoard,
  BoardScope,
} from "../adapters/board-management-api";
import { ServerBackedBoardActivity } from "./server-backed-board-activity";
import { ServerBackedBoardAccessPreview } from "./server-backed-board-access-preview";
import { ServerBackedBoardPostEditor } from "./server-backed-board-post-editor";
import { ServerBackedBoardPostLifecycle } from "./server-backed-board-post-lifecycle";
import { ServerBackedBoardPosts } from "./server-backed-board-posts";
import { ServerBackedBoardCalendar } from "./server-backed-board-calendar";
import { ServerBackedBoardManagement } from "./server-backed-board-management";
import { BoardEmpty, ConfirmAction } from "./ui";
import {
  boardListKey,
  boardUrl,
  parseBoardRoute,
  resolveBoardSection,
  useServerBoardsResource,
  type BoardListStatus,
  type BoardSection,
} from "../hooks/use-server-boards";

const PAGE_SIZE = 25;

const SCOPE_LABELS: Record<BoardScope, string> = {
  company: "Company",
  department: "Department",
  project: "Project",
};

/** The subtitle of a Board that has no description of its own. */
export function boardScopeDescription(board: {
  scope: BoardScope;
  name: string;
}): string {
  if (board.scope === "company") return "Updates for everyone in the company.";
  if (board.scope === "department")
    return `Updates for the ${board.name} department.`;
  return "Updates for the groups on this project.";
}

type BoardActivitySelection = {
  boardId: string;
  detailSequence: number;
};

export function isSelectedBoardActivityOpen(
  selection: BoardActivitySelection | null,
  boardId: string | null,
  detailSequence: number,
): boolean {
  return (
    selection !== null &&
    boardId !== null &&
    selection.boardId === boardId &&
    selection.detailSequence === detailSequence
  );
}

export function isSelectedBoardPostManagerOpen(
  selectedBoardId: string | null,
  currentBoardId: string | null,
  section: BoardSection,
): boolean {
  return (
    section === "posts" &&
    selectedBoardId !== null &&
    selectedBoardId === currentBoardId
  );
}

export function boardSearchEmptyCopy(
  search: string | null,
  pageCount: number,
  totalCount: number,
): { title: string; description: string } {
  if (pageCount === 0 && totalCount > 0)
    return {
      title: "No Boards on this page",
      description: search
        ? "Matching Boards remain on earlier pages. Use Previous in the switcher."
        : "Boards remain on earlier pages. Use Previous in the switcher.",
    };
  if (search && pageCount > 0)
    return {
      title: "Choose a matching Board",
      description:
        "Matching Boards are available in the switcher. Choose one to open it.",
    };
  return search
    ? {
        title: "No Boards match your search",
        description:
          "Try another search, clear the search, or choose an archived Board from the switcher.",
      }
    : {
        title: "No active Boards",
        description:
          "Your account cannot open any active Board. Ask an administrator for access.",
      };
}

const boardsTitleButtonClass =
  "-ml-3 min-h-11 max-w-full justify-start text-xl font-semibold";
const boardsRegionClass = "min-w-0 *:flex *:min-w-0 *:flex-col *:gap-5";

function BoardsHeader({
  heading,
  switcher,
  archived = false,
  description,
  actions,
}: {
  heading: string;
  switcher: ReactNode;
  archived?: boolean;
  description: string;
  actions: ReactNode;
}) {
  return (
    <header
      className="border-border flex min-w-0 flex-wrap items-center justify-between gap-3 border-b pb-4"
      aria-label="Current board"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="bg-muted border-border hidden size-11 shrink-0 items-center justify-center rounded-lg border sm:flex">
          <LayoutDashboard className="size-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1
              data-slot="page-title"
              className="min-w-0 flex-1"
              aria-label={heading}
            >
              {" "}
              {switcher}
            </h1>
            {archived && <Badge variant="outline">Archived</Badge>}
          </div>
          {/* min-h-5 holds the line while the description is still unknown. */}
          <p className="text-muted-foreground min-h-5 text-sm break-words">
            {description}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">{actions}</div>
    </header>
  );
}

/** The switcher and actions while Boards load: in place, but inert. */
function BoardsLoadingHeader() {
  return (
    <BoardsHeader
      heading="Boards"
      switcher={
        <Button
          variant="ghost"
          className={boardsTitleButtonClass}
          aria-label="Switch board"
          disabled
        >
          <span className="truncate">Boards</span>
          <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
        </Button>
      }
      description=""
      actions={
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11"
            aria-label="Refresh"
            title="Refresh board"
            disabled
          >
            <RefreshCw aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 min-w-11"
            aria-label="Board menu"
            disabled
          >
            <Settings2 className="sm:hidden" aria-hidden="true" />
            <span className="hidden sm:inline">Board menu</span>
            <ChevronDown
              className="hidden sm:inline"
              data-icon="inline-end"
              aria-hidden="true"
            />
          </Button>
        </>
      }
    />
  );
}

/**
 * Matches the section a loaded Board opens on: the section in the link when
 * there is one, otherwise Posts.
 */
function BoardsSkeleton({ section }: { section: BoardSection | null }) {
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="mt-1 h-5 w-72 max-w-full" />
        </div>
        <Skeleton className="h-11 w-36" />
      </div>
      {section === "calendar" ? (
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
    <div className="flex min-w-0 flex-col gap-5">
      <BoardsLoadingHeader />
      <LoadingRegion
        loading
        label="Loading Boards"
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
  const route = parseBoardRoute(searchParams.toString());
  const [statusFilter, setStatusFilter] = useState<BoardListStatus>("active");
  const [scopeFilter, setScopeFilter] = useState<BoardScope | null>(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [appliedSearch, setAppliedSearch] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [browsing, setBrowsing] = useState(false);
  const [managementMode, setManagementMode] = useState<
    "create" | "manage" | null
  >(null);
  const [activitySelection, setActivitySelection] =
    useState<BoardActivitySelection | null>(null);
  const [previewSelection, setPreviewSelection] =
    useState<BoardActivitySelection | null>(null);
  const [postManagerSelection, setPostManagerSelection] = useState<
    string | null
  >(null);
  const [draftState, setDraftState] = useState<{
    boardId: string;
    section: BoardSection;
    dirty: boolean;
    pending: boolean;
  } | null>(null);
  const [pendingNavigation, setPendingNavigation] = useState<
    (() => void) | null
  >(null);
  const resource = useServerBoardsResource(
    route,
    statusFilter,
    offset,
    appliedSearch,
    scopeFilter,
  );
  const identity = useQuery(authMeOptions());
  const isAdmin = identity.data?.role === "admin";
  const board = resource.selectedBoard;
  const boardId = board?.id ?? null;
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
  const activityOpen = isSelectedBoardActivityOpen(
    activitySelection,
    board?.id ?? null,
    resource.detail.sequence,
  );
  const previewOpen = isSelectedBoardActivityOpen(
    previewSelection,
    board?.id ?? null,
    resource.detail.sequence,
  );
  const postManagerOpen = isSelectedBoardPostManagerOpen(
    postManagerSelection,
    board?.id ?? null,
    resolveBoardSection(route),
  );
  const closeActivity = useCallback(() => setActivitySelection(null), []);
  const closePreview = useCallback(() => setPreviewSelection(null), []);
  const closePostManager = useCallback(() => setPostManagerSelection(null), []);
  const section = resolveBoardSection(route);
  const regionActive = board !== null;
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

  const currentDraftState =
    draftState !== null &&
    board !== null &&
    draftState.boardId === board.id &&
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
    [currentDraftState],
  );
  useWorkspaceNavigationGuard(guardWorkspaceNavigation);
  function selectBoardContent(
    kind: "post" | "event",
    contentId: string | null,
  ) {
    const next = new URLSearchParams(searchParams.toString());
    if (contentId === null) next.delete(kind);
    else next.set(kind, contentId);
    const href = `/boards?${next.toString()}` as Route;
    const resume = () => router.replace(href, { scroll: false });
    if (requestNavigation(href, resume)) resume();
  }
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
    [],
  );
  const onCalendarDraftStateChange = useCallback(
    (boardId: string, dirty: boolean, pending: boolean) =>
      updateDraftState(boardId, "calendar", dirty, pending),
    [updateDraftState],
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
  const currentListPage =
    resource.list.key ===
    boardListKey(statusFilter, offset, appliedSearch, scopeFilter)
      ? resource.list.data
      : null;

  useEffect(() => {
    if (!board || route.kind === "invalid-board") return;
    if (route.kind === "none" || route.section === null)
      router.replace(boardUrl(board.id, section), { scroll: false });
  }, [board, route.kind, route.section, router, section]);

  useEffect(() => {
    if (activitySelection && !activityOpen) closeActivity();
  }, [activitySelection, activityOpen, closeActivity]);

  useEffect(() => {
    if (previewSelection && !previewOpen) closePreview();
  }, [previewSelection, previewOpen, closePreview]);

  useEffect(() => {
    if (postManagerSelection && !postManagerOpen) closePostManager();
  }, [postManagerSelection, postManagerOpen, closePostManager]);

  const awaitingList =
    route.kind === "none" &&
    currentListPage === null &&
    (resource.list.status === "idle" || resource.list.status === "loading");
  const awaitingDetail =
    resource.candidate !== null &&
    board === null &&
    (resource.detail.status === "idle" || resource.detail.status === "loading");
  const loading = awaitingList || awaitingDetail;

  const choices = currentListPage?.items ?? [];
  const selectedOutsidePage =
    board !== null && !choices.some((choice) => choice.id === board.id);
  const options = [
    ...choices,
    ...(selectedOutsidePage && board ? [board] : []),
  ].map((choice) => ({
    value: choice.id,
    label: choice.name,
    description: `${SCOPE_LABELS[choice.scope]}${choice.status === "archived" ? " · Archived" : ""}`,
  }));
  const unavailable =
    route.kind === "invalid-board" ||
    (resource.candidate !== null &&
      board === null &&
      resource.detail.status === "error");
  const noBoards =
    !appliedSearch &&
    !resource.list.error &&
    currentListPage !== null &&
    currentListPage !== undefined &&
    currentListPage.pagination.total === 0;
  const emptyCopy = boardSearchEmptyCopy(
    appliedSearch,
    currentListPage?.pagination.count ?? 0,
    currentListPage?.pagination.total ?? 0,
  );

  function navigateToBoard(target: BoardManagementBoard) {
    const href = boardUrl(target.id, "posts");
    const resume = () => {
      closeActivity();
      closePreview();
      closePostManager();
      setManagementMode(null);
      setBrowsing(false);
      router.push(href, { scroll: false });
    };
    if (requestNavigation(href, resume)) resume();
  }

  function changeStatus(value: string) {
    if (value !== "active" && value !== "archived" && value !== "all") return;
    setStatusFilter(value);
    setOffset(0);
  }

  function resetBoardFilters() {
    setStatusFilter("active");
    setScopeFilter(null);
    setSearchDraft("");
    setAppliedSearch(null);
    setOffset(0);
  }

  const hasBoardFilters =
    statusFilter !== "active" || scopeFilter !== null || appliedSearch !== null;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {loading ? (
        <BoardsLoadingHeader />
      ) : (
        <BoardsHeader
          heading={board?.name ?? "Boards"}
          switcher={
            <Popover open={browsing} onOpenChange={setBrowsing}>
              <PopoverTrigger
                render={
                  <Button
                    variant="ghost"
                    className={boardsTitleButtonClass}
                    aria-label="Switch board"
                  />
                }
              >
                <span className="truncate">
                  {board?.name ?? (noBoards ? "Boards" : "Choose a board")}
                </span>
                <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="w-[min(26rem,calc(100vw-2rem))] gap-4 p-4"
              >
                <PopoverHeader>
                  <PopoverTitle>Find a board</PopoverTitle>
                  <PopoverDescription>
                    Only Boards available to your account appear here.
                  </PopoverDescription>
                </PopoverHeader>
                <form
                  className="space-y-2"
                  onSubmit={(event: FormEvent<HTMLFormElement>) => {
                    event.preventDefault();
                    setAppliedSearch(searchDraft.trim() || null);
                    setOffset(0);
                  }}
                >
                  <label
                    htmlFor="board-switch-search"
                    className="text-sm font-medium"
                  >
                    Search accessible Boards
                  </label>
                  <Input
                    id="board-switch-search"
                    type="search"
                    maxLength={100}
                    value={searchDraft}
                    onChange={(event) =>
                      setSearchDraft(event.currentTarget.value)
                    }
                    className="bg-background text-foreground min-h-11 rounded-md focus-visible:outline-offset-2"
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="submit"
                      variant="outline"
                      className="min-h-11"
                    >
                      Search boards
                    </Button>
                    {appliedSearch && (
                      <Button
                        type="button"
                        variant="ghost"
                        className="min-h-11"
                        onClick={() => {
                          setSearchDraft("");
                          setAppliedSearch(null);
                          setOffset(0);
                        }}
                      >
                        Clear search
                      </Button>
                    )}
                  </div>
                </form>
                <SearchSelect
                  label="Board"
                  value={board?.id ?? ""}
                  placeholder="Choose a board"
                  options={options}
                  onValueChange={(id) => {
                    const target = [...choices, ...(board ? [board] : [])].find(
                      (choice) => choice.id === id,
                    );
                    if (target) navigateToBoard(target);
                  }}
                />
                <SearchSelect
                  label="Board status"
                  value={statusFilter}
                  options={[
                    { value: "active", label: "Active" },
                    { value: "archived", label: "Archived" },
                    { value: "all", label: "All Boards" },
                  ]}
                  onValueChange={changeStatus}
                />
                <SearchSelect
                  label="Board type"
                  value={scopeFilter ?? ""}
                  placeholder="All Board types"
                  options={[
                    { value: "", label: "All Board types" },
                    { value: "company", label: "Company" },
                    { value: "department", label: "Departments" },
                    { value: "project", label: "Projects" },
                  ]}
                  onValueChange={(value) => {
                    setScopeFilter(
                      value === "company" ||
                        value === "department" ||
                        value === "project"
                        ? value
                        : null,
                    );
                    setOffset(0);
                  }}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-11"
                    disabled={!hasBoardFilters}
                    onClick={resetBoardFilters}
                  >
                    Reset filters
                  </Button>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-muted-foreground text-sm">
                    {currentListPage
                      ? `${currentListPage.items.length} on this page · ${currentListPage.pagination.total} accessible${appliedSearch ? " matching search" : ""}`
                      : "Board list unavailable"}
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={
                        offset === 0 || resource.list.status === "loading"
                      }
                      onClick={() =>
                        setOffset((value) => Math.max(0, value - PAGE_SIZE))
                      }
                    >
                      Previous
                    </Button>
                    <span className="text-muted-foreground text-sm">
                      Page {Math.floor(offset / PAGE_SIZE) + 1}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={
                        !currentListPage?.pagination.hasMore ||
                        resource.list.status === "loading"
                      }
                      onClick={() => setOffset((value) => value + PAGE_SIZE)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          }
          archived={board?.status === "archived"}
          description={
            board?.description ||
            (board
              ? boardScopeDescription(board)
              : noBoards
                ? "No Board is open to your account yet."
                : "Choose a Board to get started.")
          }
          actions={
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-11"
                aria-label="Refresh"
                title="Refresh board"
                onClick={() => {
                  refreshBoard();
                  if (regionActive) refreshWorkspaceCalendar();
                }}
              >
                <RefreshCw aria-hidden="true" />
              </Button>
              {((board && canManage) || isAdmin) && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="outline"
                        className="min-h-11 min-w-11"
                        aria-label="Board menu"
                      />
                    }
                  >
                    <Settings2 className="sm:hidden" aria-hidden="true" />
                    <span className="hidden sm:inline">Board menu</span>
                    <ChevronDown
                      className="hidden sm:inline"
                      data-icon="inline-end"
                      aria-hidden="true"
                    />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-56">
                    {board && canManage && (
                      <>
                        <DropdownMenuItem
                          className="min-h-11"
                          onClick={() => setManagementMode("manage")}
                        >
                          <Settings2 />
                          {board.scope === "project"
                            ? "Manage Board and groups"
                            : "Manage Board"}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="min-h-11"
                          onClick={() =>
                            setPreviewSelection({
                              boardId: board.id,
                              detailSequence: resource.detail.sequence,
                            })
                          }
                        >
                          <Eye /> Preview access
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="min-h-11"
                          onClick={() =>
                            setActivitySelection({
                              boardId: board.id,
                              detailSequence: resource.detail.sequence,
                            })
                          }
                        >
                          <History /> View activity
                        </DropdownMenuItem>
                      </>
                    )}
                    {board && canManage && isAdmin && <DropdownMenuSeparator />}
                    {isAdmin && (
                      <DropdownMenuGroup>
                        <DropdownMenuItem
                          className="min-h-11"
                          onClick={() => setManagementMode("create")}
                        >
                          New project Board
                        </DropdownMenuItem>
                      </DropdownMenuGroup>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </>
          }
        />
      )}
      <ServerBackedBoardManagement
        mode="create"
        open={managementMode === "create"}
        onOpenChange={(open) => setManagementMode(open ? "create" : null)}
        onCreated={(created) => {
          refreshBoard();
          navigateToBoard(created);
        }}
      />
      {board && (
        <ServerBackedBoardManagement
          mode="manage"
          isAdmin={isAdmin}
          open={managementMode === "manage"}
          onOpenChange={(open) => setManagementMode(open ? "manage" : null)}
          board={board}
          onUpdated={(updated) => {
            resource.applyBoardMutation(updated);
            refreshBoard();
          }}
          onAccessDenied={() => {
            closeActivity();
            closePreview();
            closePostManager();
            resource.revokeAccess();
          }}
          onPurged={() => {
            const href: Route = "/boards";
            const resume = () => {
              closeActivity();
              closePreview();
              closePostManager();
              setBrowsing(false);
              router.push(href, { scroll: false });
              refreshBoard();
            };
            if (requestNavigation(href, resume)) resume();
          }}
        />
      )}

      <LoadingRegion
        loading={loading}
        label="Loading Boards"
        skeleton={<BoardsSkeleton section={route.section} />}
        className={boardsRegionClass}
      >
        {resource.list.error && (
          <Alert variant="destructive">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>
                {currentListPage ? "Showing the last loaded Board list. " : ""}
                {resource.list.error}
              </span>
              <Button
                variant="outline"
                className="min-h-11"
                onClick={refreshBoard}
              >
                Retry
              </Button>
            </div>
          </Alert>
        )}
        {board && resource.detail.error && (
          <Alert variant="destructive">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>
                Showing the last loaded Board. {resource.detail.error}
              </span>
              <Button
                variant="outline"
                className="min-h-11"
                onClick={refreshBoard}
              >
                Retry
              </Button>
            </div>
          </Alert>
        )}

        {!board ? (
          <BoardEmpty
            title={
              unavailable
                ? "Board unavailable"
                : resource.list.error
                  ? "Boards could not be loaded"
                  : emptyCopy.title
            }
            description={
              unavailable
                ? resource.detail.error ||
                  "This Board may have been removed or your account may not have access. Choose another Board above or retry."
                : resource.list.error
                  ? "The Board list could not be loaded. Retry to see your Boards."
                  : emptyCopy.description
            }
            icon={<LayoutDashboard aria-hidden="true" />}
          >
            {unavailable && (
              <Button
                variant="outline"
                className="min-h-11"
                onClick={refreshBoard}
              >
                <RefreshCw data-icon="inline-start" /> Retry Board
              </Button>
            )}
            {/* The same action as the Board menu, so an empty workspace has a
                first step in view. The server still decides who may create. */}
            {!unavailable &&
              !resource.list.error &&
              !appliedSearch &&
              noBoards &&
              isAdmin && (
                <Button
                  className="min-h-11"
                  onClick={() => setManagementMode("create")}
                >
                  New project Board
                </Button>
              )}
          </BoardEmpty>
        ) : (
          <>
            {board.status === "archived" && (
              <Alert>This Board is archived and read-only.</Alert>
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

            {section === "calendar" ? (
              <ServerBackedBoardCalendar
                key={board.id}
                workspaceCalendar={workspaceCalendar.data}
                workspaceDateError={workspaceCalendar.isError}
                onRetryWorkspaceDate={() => void workspaceCalendar.refetch()}
                boardId={board.id}
                boardActive={board.status === "active"}
                liveKey={eventsLiveKey + manualLiveKey}
                refreshKey={resource.detail.sequence}
                onDraftStateChange={onCalendarDraftStateChange}
                selectedEventId={searchParams.get("event")}
                onCloseSelectedEvent={() => selectBoardContent("event", null)}
              />
            ) : (
              <div className="flex min-w-0 flex-col gap-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2
                      data-slot="section-title"
                      className="text-2xl font-semibold tracking-tight"
                    >
                      Posts
                    </h2>
                    <p className="text-muted-foreground mt-1 text-sm">
                      Everyone who can open this Board reads its posts.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {board.status === "active" && canManage && (
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11"
                        onClick={() => setPostManagerSelection(board.id)}
                      >
                        Manage posts
                      </Button>
                    )}
                    <ServerBackedBoardPostEditor
                      key={`editor:${board.id}`}
                      boardId={board.id}
                      boardRevision={board.revision}
                      boardStatus={board.status}
                      refreshKey={postsLiveKey + manualLiveKey}
                      onPublished={() => refreshBoard()}
                      onDraftStateChange={onPostDraftStateChange}
                    />
                  </div>
                </div>
                <ServerBackedBoardPosts
                  key={board.id}
                  region={displayRegion}
                  boardId={board.id}
                  refreshKey={postsLiveKey + manualLiveKey}
                  selectedPostId={searchParams.get("post")}
                  onSelectPost={(postId) => selectBoardContent("post", postId)}
                />

                <Sheet
                  open={postManagerOpen}
                  onOpenChange={(open) => {
                    if (!open) closePostManager();
                  }}
                >
                  <SheetContent
                    side="right"
                    className="w-full overflow-y-auto sm:max-w-2xl"
                  >
                    <SheetHeader>
                      <SheetTitle>Manage posts</SheetTitle>
                      <SheetDescription>
                        Archive and restore posts, or delete drafts that were
                        never published.
                      </SheetDescription>
                    </SheetHeader>
                    {postManagerOpen && (
                      <ServerBackedBoardPostLifecycle
                        key={`lifecycle:${board.id}`}
                        boardId={board.id}
                        boardStatus={board.status}
                        refreshKey={postsLiveKey + manualLiveKey}
                        onChanged={() => refreshBoard()}
                        onAccessDenied={(boardId) => {
                          if (board.id !== boardId) return;
                          closePostManager();
                          resource.revokeAccess();
                        }}
                      />
                    )}
                  </SheetContent>
                </Sheet>
              </div>
            )}
            <Sheet
              open={activityOpen}
              onOpenChange={(open) => {
                if (!open) closeActivity();
              }}
            >
              <SheetContent className="w-full gap-6 sm:w-[min(92vw,40rem)]">
                <SheetHeader className="pr-10">
                  <SheetTitle>Board activity</SheetTitle>
                  <SheetDescription>
                    Changes to this Board and its groups.
                  </SheetDescription>
                </SheetHeader>
                <Button
                  variant="ghost"
                  size="icon"
                  type="button"
                  aria-label="Close Board activity"
                  className="absolute top-3 right-3 size-11"
                  onClick={closeActivity}
                >
                  <X />
                </Button>
                {activityOpen && (
                  <ServerBackedBoardActivity
                    key={board.id}
                    region={displayRegion}
                    boardId={board.id}
                    refreshKey={resource.detail.sequence}
                    onAccessDenied={closeActivity}
                  />
                )}
              </SheetContent>
            </Sheet>
            <Sheet
              open={previewOpen}
              onOpenChange={(open) => {
                if (!open) closePreview();
              }}
            >
              <SheetContent className="w-full gap-6 sm:w-[min(92vw,40rem)]">
                <SheetHeader className="pr-10">
                  <SheetTitle>Preview Board access</SheetTitle>
                  <SheetDescription>
                    Check the level an active person has on this Board without
                    changing any access.
                  </SheetDescription>
                </SheetHeader>
                <Button
                  variant="ghost"
                  size="icon"
                  type="button"
                  aria-label="Close Board access preview"
                  className="absolute top-3 right-3 size-11"
                  onClick={closePreview}
                >
                  <X />
                </Button>
                {previewOpen && (
                  <ServerBackedBoardAccessPreview
                    key={board.id}
                    boardId={board.id}
                    refreshKey={resource.detail.sequence}
                  />
                )}
              </SheetContent>
            </Sheet>
          </>
        )}
      </LoadingRegion>
      <ConfirmAction
        open={pendingNavigation !== null}
        title="Discard unsaved Board changes?"
        description="Your unsaved Event or post changes will be lost."
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
