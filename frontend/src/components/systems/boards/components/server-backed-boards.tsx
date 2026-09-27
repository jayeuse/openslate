"use client";

import {
  Suspense,
  createElement,
  useCallback,
  useEffect,
  useState,
  type FormEvent,
} from "react";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useWorkspaceNavigationGuard,
  useWorkspaceNavigationRequest,
  type WorkspaceNavigationGuard,
} from "@/components/workspace-navigation-guard";
import {
  ChevronDown,
  Eye,
  History,
  Home,
  LayoutDashboard,
  RefreshCw,
  Settings2,
  Star,
  X,
} from "lucide-react";
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
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SearchSelect } from "@/components/ui/search-select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { BoardManagementBoard } from "../adapters/board-management-api";
import {
  listBoardDepartments,
  type BoardDepartmentChoice,
} from "../adapters/board-departments-api";
import { ServerBackedBoardActivity } from "./server-backed-board-activity";
import { ServerBackedBoardAccessPreview } from "./server-backed-board-access-preview";
import { ServerBackedBoardAnnouncementEditor } from "./server-backed-board-announcement-editor";
import { ServerBackedBoardAnnouncementLifecycle } from "./server-backed-board-announcement-lifecycle";
import { ServerBackedBoardAnnouncements } from "./server-backed-board-announcements";
import { ServerBackedBoardCalendar } from "./server-backed-board-calendar";
import { ServerBackedBoardGrants } from "./server-backed-board-grants";
import { ServerBackedBoardManagement } from "./server-backed-board-management";
import { ServerBackedBoardPlacements } from "./server-backed-board-placements";
import { ServerBackedBoardPortability } from "./server-backed-board-portability";
import { ServerBackedBoardTemplates } from "./server-backed-board-templates";
import { ServerBackedBoardWidgets } from "./server-backed-board-widgets";
import { ServerBoardWidgetManagement } from "./server-backed-board-widget-management";
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

export function isSelectedBoardWidgetManagerOpen(
  selectedBoardId: string | null,
  currentBoardId: string | null,
): boolean {
  return selectedBoardId !== null && selectedBoardId === currentBoardId;
}

export function isSelectedBoardAnnouncementManagerOpen(
  selectedBoardId: string | null,
  currentBoardId: string | null,
  section: BoardSection,
): boolean {
  return (
    section === "announcements" &&
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
        title: "No active Boards yet",
        description:
          "Create a Board to share updates, announcements, and dates with your team.",
      };
}

export function ServerBackedBoardsLoading() {
  return createElement(
    "div",
    {
      className: "flex flex-col gap-3 p-6",
      role: "status",
      "aria-live": "polite",
    },
    createElement("div", {
      className:
        "bg-muted h-8 w-48 animate-pulse rounded-lg motion-reduce:animate-none",
    }),
    createElement("div", {
      className:
        "bg-muted h-24 w-full animate-pulse rounded-xl motion-reduce:animate-none",
    }),
    createElement(
      "p",
      { className: "text-muted-foreground text-sm" },
      "Loading Boards…",
    ),
  );
}

function ServerBackedBoardsContent() {
  const router = useRouter();
  const requestNavigation = useWorkspaceNavigationRequest();
  const searchParams = useSearchParams();
  const route = parseBoardRoute(searchParams.toString());
  const [statusFilter, setStatusFilter] = useState<BoardListStatus>("active");
  const [departmentFilter, setDepartmentFilter] = useState<string | null>(null);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [searchDraft, setSearchDraft] = useState("");
  const [appliedSearch, setAppliedSearch] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [browsing, setBrowsing] = useState(false);
  const [departmentChoices, setDepartmentChoices] = useState<
    BoardDepartmentChoice[]
  >([]);
  const [departmentChoicesStatus, setDepartmentChoicesStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [departmentChoicesRetry, setDepartmentChoicesRetry] = useState(0);
  const [managementMode, setManagementMode] = useState<
    "create" | "manage" | null
  >(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [portabilityOpen, setPortabilityOpen] = useState(false);
  const [activitySelection, setActivitySelection] =
    useState<BoardActivitySelection | null>(null);
  const [previewSelection, setPreviewSelection] =
    useState<BoardActivitySelection | null>(null);
  const [grantsSelection, setGrantsSelection] =
    useState<BoardActivitySelection | null>(null);
  const [widgetSelection, setWidgetSelection] = useState<string | null>(null);
  const [announcementManagerSelection, setAnnouncementManagerSelection] =
    useState<string | null>(null);
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
    departmentFilter,
    favoritesOnly,
  );
  const board = resource.selectedBoard;
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
  const grantsOpen = isSelectedBoardActivityOpen(
    grantsSelection,
    board?.id ?? null,
    resource.detail.sequence,
  );
  const widgetsOpen = isSelectedBoardWidgetManagerOpen(
    widgetSelection,
    board?.id ?? null,
  );
  const announcementManagerOpen = isSelectedBoardAnnouncementManagerOpen(
    announcementManagerSelection,
    board?.id ?? null,
    resolveBoardSection(route, board),
  );
  const closeActivity = useCallback(() => setActivitySelection(null), []);
  const closePreview = useCallback(() => setPreviewSelection(null), []);
  const closeGrants = useCallback(() => setGrantsSelection(null), []);
  const closeWidgets = useCallback(() => setWidgetSelection(null), []);
  const closeAnnouncementManager = useCallback(
    () => setAnnouncementManagerSelection(null),
    [],
  );
  const section = resolveBoardSection(route, board);

  useEffect(() => {
    if (!browsing) return;
    const controller = new AbortController();
    setDepartmentChoicesStatus("loading");
    void listBoardDepartments(controller.signal).then(
      (departments) => {
        if (controller.signal.aborted) return;
        setDepartmentChoices(departments);
        setDepartmentChoicesStatus("ready");
      },
      () => {
        if (controller.signal.aborted) return;
        setDepartmentChoices([]);
        setDepartmentChoicesStatus("error");
      },
    );
    return () => controller.abort();
  }, [browsing, departmentChoicesRetry]);
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
  const onAnnouncementDraftStateChange = useCallback(
    (boardId: string, dirty: boolean, pending: boolean) =>
      updateDraftState(boardId, "announcements", dirty, pending),
    [updateDraftState],
  );

  useEffect(() => {
    if (!currentDraftState?.dirty && !currentDraftState?.pending) return;
    const preventUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [currentDraftState]);
  const isFavorite =
    board !== null &&
    (resource.personal.data?.favoriteBoardIds.includes(board.id) ?? false);
  const isHome =
    board !== null && resource.personal.data?.homeBoardId === board.id;
  const currentListPage =
    resource.list.key ===
    boardListKey(
      statusFilter,
      offset,
      appliedSearch,
      departmentFilter,
      favoritesOnly,
    )
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
    if (grantsSelection && !grantsOpen) closeGrants();
  }, [grantsSelection, grantsOpen, closeGrants]);

  useEffect(() => {
    if (widgetSelection && !widgetsOpen) closeWidgets();
  }, [widgetSelection, widgetsOpen, closeWidgets]);

  useEffect(() => {
    if (announcementManagerSelection && !announcementManagerOpen)
      closeAnnouncementManager();
  }, [
    announcementManagerSelection,
    announcementManagerOpen,
    closeAnnouncementManager,
  ]);

  const awaitingPersonal =
    route.kind === "none" &&
    resource.personal.data === null &&
    (resource.personal.status === "idle" ||
      resource.personal.status === "loading");
  const awaitingList =
    route.kind === "none" &&
    currentListPage === null &&
    (resource.list.status === "idle" || resource.list.status === "loading");
  const awaitingDetail =
    resource.candidate !== null &&
    board === null &&
    (resource.detail.status === "idle" || resource.detail.status === "loading");
  if (awaitingPersonal || awaitingList || awaitingDetail)
    return <ServerBackedBoardsLoading />;

  const choices = currentListPage?.items ?? [];
  const selectedOutsidePage =
    board !== null && !choices.some((choice) => choice.id === board.id);
  const options = [
    ...choices,
    ...(selectedOutsidePage && board ? [board] : []),
  ].map((choice) => ({
    value: choice.id,
    label: choice.name,
    description: `${choice.status === "archived" ? "Archived" : "Active"}${resource.personal.data?.favoriteBoardIds.includes(choice.id) ? " · Favorite" : ""}`,
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
    const href = boardUrl(target.id, target.defaultSection);
    const resume = () => {
      closeActivity();
      closePreview();
      closeGrants();
      closeWidgets();
      closeAnnouncementManager();
      setManagementMode(null);
      setTemplatesOpen(false);
      setPortabilityOpen(false);
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
    setDepartmentFilter(null);
    setFavoritesOnly(false);
    setSearchDraft("");
    setAppliedSearch(null);
    setOffset(0);
  }

  const hasBoardFilters =
    statusFilter !== "active" ||
    departmentFilter !== null ||
    favoritesOnly ||
    appliedSearch !== null;

  return (
    <div className="flex min-w-0 flex-col gap-5">
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
                aria-label={board?.name ?? "Boards"}
              >
                {" "}
                <Popover open={browsing} onOpenChange={setBrowsing}>
                  <PopoverTrigger
                    render={
                      <Button
                        variant="ghost"
                        className="-ml-3 min-h-11 max-w-full justify-start text-xl font-semibold"
                        aria-label="Switch board"
                      />
                    }
                  >
                    <span className="truncate">
                      {board?.name ?? (noBoards ? "Boards" : "Choose a board")}
                    </span>
                    <ChevronDown
                      className="size-4 shrink-0"
                      aria-hidden="true"
                    />
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
                        const target = [
                          ...choices,
                          ...(board ? [board] : []),
                        ].find((choice) => choice.id === id);
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
                      label="Department"
                      value={departmentFilter ?? ""}
                      placeholder="All departments"
                      options={[
                        { value: "", label: "All departments" },
                        ...departmentChoices.map((department) => ({
                          value: department.id,
                          label: department.name,
                        })),
                      ]}
                      onValueChange={(departmentId) => {
                        setDepartmentFilter(departmentId || null);
                        setOffset(0);
                      }}
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant={favoritesOnly ? "default" : "outline"}
                        className="min-h-11"
                        aria-pressed={favoritesOnly}
                        onClick={() => {
                          setFavoritesOnly((value) => !value);
                          setOffset(0);
                        }}
                      >
                        <Star data-icon="inline-start" /> Favorites only
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        className="min-h-11"
                        disabled={!hasBoardFilters}
                        onClick={resetBoardFilters}
                      >
                        Reset filters
                      </Button>
                      {departmentChoicesStatus === "loading" && (
                        <span
                          className="text-muted-foreground text-sm"
                          role="status"
                        >
                          Loading departments…
                        </span>
                      )}
                      {departmentChoicesStatus === "error" && (
                        <span
                          className="flex items-center gap-2 text-sm"
                          role="alert"
                        >
                          Department choices are unavailable.
                          <Button
                            type="button"
                            variant="outline"
                            className="min-h-11"
                            onClick={() => {
                              setDepartmentChoicesStatus("idle");
                              setDepartmentChoicesRetry((value) => value + 1);
                            }}
                          >
                            Retry departments
                          </Button>
                        </span>
                      )}
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
                          onClick={() =>
                            setOffset((value) => value + PAGE_SIZE)
                          }
                        >
                          Next
                        </Button>
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>
              </h1>
              {board?.status === "archived" && (
                <Badge variant="outline">Archived</Badge>
              )}
            </div>
            <p className="text-muted-foreground text-sm break-words">
              {board?.description ||
                (board
                  ? "Your team's updates, events, and records."
                  : noBoards
                    ? "Create your first Board to share updates with your team."
                    : "Choose a Board to get started.")}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11"
            aria-label="Refresh"
            title="Refresh board"
            onClick={resource.refresh}
          >
            <RefreshCw aria-hidden="true" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="outline" className="min-h-11" />}
            >
              Board menu <ChevronDown data-icon="inline-end" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-56">
              {board && (
                <>
                  <DropdownMenuItem
                    className="min-h-11"
                    onClick={() => setManagementMode("manage")}
                  >
                    <Settings2 />
                    Manage Board
                  </DropdownMenuItem>
                  <DropdownMenuGroup>
                    <DropdownMenuItem
                      className="min-h-11"
                      disabled={
                        !resource.personal.data || resource.preferencePending
                      }
                      onClick={() => {
                        void resource.saveFavorite(board.id, !isFavorite);
                      }}
                    >
                      <Star />
                      {isFavorite
                        ? "Remove from favorites"
                        : "Add to favorites"}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="min-h-11"
                      disabled={
                        !resource.personal.data ||
                        resource.preferencePending ||
                        (board.status === "archived" && !isHome)
                      }
                      onClick={() => {
                        void resource.saveHome(isHome ? null : board.id);
                      }}
                    >
                      <Home />
                      {isHome ? "Clear home board" : "Set as home board"}
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="min-h-11"
                    onClick={() =>
                      setGrantsSelection({
                        boardId: board.id,
                        detailSequence: resource.detail.sequence,
                      })
                    }
                  >
                    Manage access
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

                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuGroup>
                <DropdownMenuItem
                  className="min-h-11"
                  onClick={() => setManagementMode("create")}
                >
                  New Board
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="min-h-11"
                  onClick={() => setTemplatesOpen(true)}
                >
                  Templates
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="min-h-11"
                  onClick={() => setPortabilityOpen(true)}
                >
                  Configurations
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <ServerBackedBoardManagement
        mode="create"
        open={managementMode === "create"}
        onOpenChange={(open) => setManagementMode(open ? "create" : null)}
        onCreated={(created) => {
          resource.refresh();
          navigateToBoard(created);
        }}
      />
      {board && (
        <ServerBackedBoardManagement
          mode="manage"
          open={managementMode === "manage"}
          onOpenChange={(open) => setManagementMode(open ? "manage" : null)}
          board={board}
          onUpdated={(updated) => {
            resource.applyBoardMutation(updated);
            resource.refresh();
          }}
          onAccessDenied={() => {
            closeActivity();
            closePreview();
            closeGrants();
            closeWidgets();
            closeAnnouncementManager();
            resource.revokeAccess();
          }}
          onPurged={() => {
            const href: Route = "/boards";
            const resume = () => {
              closeActivity();
              closePreview();
              closeGrants();
              closeWidgets();
              closeAnnouncementManager();
              setBrowsing(false);
              router.push(href, { scroll: false });
              resource.refresh();
            };
            if (requestNavigation(href, resume)) resume();
          }}
        />
      )}

      {resource.list.error && (
        <Alert variant="warning">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>
              {currentListPage ? "Showing the last loaded Board list. " : ""}
              {resource.list.error}
            </span>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={resource.refresh}
            >
              Retry
            </Button>
          </div>
        </Alert>
      )}
      {resource.personal.error && (
        <Alert variant="warning">{resource.personal.error}</Alert>
      )}
      {resource.preferenceError && (
        <Alert variant="destructive">{resource.preferenceError}</Alert>
      )}
      {board && resource.detail.error && (
        <Alert variant="warning">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>Showing the last loaded Board. {resource.detail.error}</span>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={resource.refresh}
            >
              Retry
            </Button>
          </div>
        </Alert>
      )}

      <Sheet open={templatesOpen} onOpenChange={setTemplatesOpen}>
        <SheetContent className="w-full gap-6 overflow-y-auto sm:w-[min(92vw,40rem)]">
          <SheetHeader className="pr-10">
            <SheetTitle>Board templates</SheetTitle>
            <SheetDescription>
              Create a private Board from a saved structure or save the current
              Board as a template.
            </SheetDescription>
          </SheetHeader>
          <Button
            variant="ghost"
            size="icon"
            type="button"
            aria-label="Close Board templates"
            className="absolute top-3 right-3 size-11"
            onClick={() => setTemplatesOpen(false)}
          >
            <X />
          </Button>
          {templatesOpen && (
            <ServerBackedBoardTemplates
              board={board}
              refreshKey={resource.detail.sequence}
              onBoardCreated={(created) => {
                resource.refresh();
                navigateToBoard(created);
              }}
            />
          )}
        </SheetContent>
      </Sheet>

      <Sheet open={portabilityOpen} onOpenChange={setPortabilityOpen}>
        <SheetContent className="w-full gap-6 overflow-y-auto sm:w-[min(92vw,40rem)]">
          <SheetHeader className="pr-10">
            <SheetTitle>Board configurations</SheetTitle>
            <SheetDescription>
              Import, export or duplicate a Board’s structure without copying
              its content or access rules.
            </SheetDescription>
          </SheetHeader>
          <Button
            variant="ghost"
            size="icon"
            type="button"
            aria-label="Close Board configurations"
            className="absolute top-3 right-3 size-11"
            onClick={() => setPortabilityOpen(false)}
          >
            <X />
          </Button>
          {portabilityOpen && (
            <ServerBackedBoardPortability
              board={board}
              refreshKey={resource.detail.sequence}
              onBoardCreated={(created) => {
                resource.refresh();
                navigateToBoard(created);
              }}
              onAccessDenied={(boardId) => {
                if (board?.id !== boardId) return;
                setPortabilityOpen(false);
                resource.revokeAccess();
              }}
            />
          )}
        </SheetContent>
      </Sheet>

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
              onClick={resource.refresh}
            >
              <RefreshCw data-icon="inline-start" /> Retry Board
            </Button>
          )}
          {/* The same actions as the Board menu, so an empty workspace has a
              first step in view. The server still decides who may create. */}
          {!unavailable &&
            !resource.list.error &&
            !appliedSearch &&
            noBoards && (
              <div className="flex flex-wrap justify-center gap-2">
                <Button
                  className="min-h-11"
                  onClick={() => setManagementMode("create")}
                >
                  New Board
                </Button>
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() => setTemplatesOpen(true)}
                >
                  Use a template
                </Button>
              </div>
            )}
        </BoardEmpty>
      ) : (
        <>
          {board.status === "archived" && (
            <Alert>This Board is archived and read-only.</Alert>
          )}

          {section === "calendar" ? (
            <ServerBackedBoardCalendar
              key={board.id}
              boardId={board.id}
              boardActive={board.status === "active"}
              refreshKey={resource.detail.sequence}
              onDraftStateChange={onCalendarDraftStateChange}
            />
          ) : section === "announcements" ? (
            <div className="flex min-w-0 flex-col gap-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2
                    data-slot="section-title"
                    className="text-2xl font-semibold tracking-tight"
                  >
                    Announcements
                  </h2>
                  <p className="text-muted-foreground mt-1 text-sm">
                    Stay up to date with your team.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {board.status === "active" && (
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      onClick={() => setAnnouncementManagerSelection(board.id)}
                    >
                      Manage announcements
                    </Button>
                  )}
                  <ServerBackedBoardAnnouncementEditor
                    key={`editor:${board.id}`}
                    boardId={board.id}
                    boardRevision={board.revision}
                    boardStatus={board.status}
                    refreshKey={resource.detail.sequence}
                    onPublished={() => resource.refresh()}
                    onDraftStateChange={onAnnouncementDraftStateChange}
                  />
                </div>
              </div>
              <ServerBackedBoardAnnouncements
                key={board.id}
                boardId={board.id}
                refreshKey={resource.detail.sequence}
              />

              <Sheet
                open={announcementManagerOpen}
                onOpenChange={(open) => {
                  if (!open) closeAnnouncementManager();
                }}
              >
                <SheetContent
                  side="right"
                  className="w-full overflow-y-auto sm:max-w-2xl"
                >
                  <SheetHeader>
                    <SheetTitle>Manage announcements</SheetTitle>
                    <SheetDescription>
                      Archive, restore, or permanently delete announcements you
                      are allowed to manage.
                    </SheetDescription>
                  </SheetHeader>
                  {announcementManagerOpen && (
                    <ServerBackedBoardAnnouncementLifecycle
                      key={`lifecycle:${board.id}`}
                      boardId={board.id}
                      boardStatus={board.status}
                      refreshKey={resource.detail.sequence}
                      onChanged={() => resource.refresh()}
                      onAccessDenied={(boardId) => {
                        if (board.id !== boardId) return;
                        closeAnnouncementManager();
                        resource.revokeAccess();
                      }}
                    />
                  )}
                </SheetContent>
              </Sheet>
            </div>
          ) : (
            <div className="flex min-w-0 flex-col gap-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2
                    data-slot="section-title"
                    className="text-2xl font-semibold tracking-tight"
                  >
                    Board overview
                  </h2>
                  <p className="text-muted-foreground mt-1 text-sm">
                    Record summaries and shortcuts for your team.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  onClick={() => setWidgetSelection(board.id)}
                >
                  Manage widgets
                </Button>
              </div>
              <ServerBackedBoardWidgets
                key={board.id}
                boardId={board.id}
                refreshKey={resource.detail.sequence}
              />
              <ServerBackedBoardPlacements
                key={`placements:${board.id}`}
                boardId={board.id}
                boardActive={board.status === "active"}
                refreshKey={resource.detail.sequence}
                onAccessDenied={resource.revokeAccess}
              />
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
                  Changes to this Board that are available to your account.
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
                  Check Board-level permissions for an active person without
                  changing your own access.
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
          <Sheet
            open={grantsOpen}
            onOpenChange={(open) => {
              if (!open) closeGrants();
            }}
          >
            <SheetContent className="w-full gap-6 overflow-y-auto sm:w-[min(92vw,44rem)]">
              <SheetHeader className="pr-10">
                <SheetTitle>Manage Board access</SheetTitle>
                <SheetDescription>
                  Grant rules affect Board permissions. Content audiences may
                  narrow what a person can see further.
                </SheetDescription>
              </SheetHeader>
              <Button
                variant="ghost"
                size="icon"
                type="button"
                aria-label="Close Board access rules"
                className="absolute top-3 right-3 size-11"
                onClick={closeGrants}
              >
                <X />
              </Button>
              {grantsOpen && (
                <ServerBackedBoardGrants
                  key={board.id}
                  boardId={board.id}
                  boardActive={board.status === "active"}
                  refreshKey={resource.detail.sequence}
                  onAccessDenied={() => {
                    closeGrants();
                    resource.refresh();
                  }}
                />
              )}
            </SheetContent>
          </Sheet>
          <Sheet
            open={widgetsOpen}
            onOpenChange={(open) => {
              if (!open) closeWidgets();
            }}
          >
            <SheetContent className="w-full gap-6 overflow-y-auto sm:w-[min(92vw,44rem)]">
              <SheetHeader className="pr-10">
                <SheetTitle>Manage Board widgets</SheetTitle>
                <SheetDescription>
                  Add and arrange widgets visible to you. Widget audiences still
                  control who can see each one.
                </SheetDescription>
              </SheetHeader>
              <Button
                variant="ghost"
                size="icon"
                type="button"
                aria-label="Close widget management"
                className="absolute top-3 right-3 size-11"
                onClick={closeWidgets}
              >
                <X />
              </Button>
              {widgetsOpen && (
                <ServerBoardWidgetManagement
                  key={board.id}
                  boardId={board.id}
                  boardActive={board.status === "active"}
                  refreshKey={resource.detail.sequence}
                  onChanged={resource.refresh}
                  onBoardRefresh={resource.refresh}
                  onAccessDenied={(boardId) => {
                    if (board.id !== boardId) return;
                    closeWidgets();
                    resource.revokeAccess();
                  }}
                />
              )}
            </SheetContent>
          </Sheet>
        </>
      )}
      <ConfirmAction
        open={pendingNavigation !== null}
        title="Discard unsaved Board changes?"
        description="Your unsaved Event or announcement changes will be lost."
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
