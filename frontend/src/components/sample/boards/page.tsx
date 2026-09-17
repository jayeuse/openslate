"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  Archive,
  Check,
  ChevronsUpDown,
  Home,
  LayoutDashboard,
  Link2,
  Plus,
  RefreshCw,
  Settings2,
  Star,
  Wrench,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Field, FieldLabel } from "@/components/ui/field";
import { SearchSelect } from "@/components/ui/search-select";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverDescription,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useBoardsController, type BoardsController } from "./controller";
import {
  type Board,
  type BoardSection,
  type BoardWidget,
  type BoardEvent,
  BOARD_SECTIONS,
  decodeBoardWidgets,
} from "./model";
import { type BoardMutationResult } from "./commands";
import { BoardCalendar } from "./calendar";
import {
  AnnouncementFeed,
  type AnnouncementAction,
  type AnnouncementPersonalAction,
} from "./announcement-feed";
import { canViewBoardAudience, type BoardViewer } from "./content";
import { BoardEmpty, EditSheet, ConfirmAction } from "./ui";
import {
  BoardSettingsSheet,
  BoardToolsSheet,
  CreateBoardSheet,
} from "./administration";
import { getBoardConfiguration, type BoardConfiguration } from "./portability";
import { WidgetSurface, newWidget } from "../openview/widgets";
import {
  OPENVIEW_MODULES,
  getModuleDefinition,
  type OpenViewModuleId,
} from "../openview/model";

type WorkingCopy = { original: Board; draft: Board };
type BoardDialog = "settings" | "tools" | "widget" | "record" | null;

export default function SampleBoards() {
  return (
    <Suspense
      fallback={
        <p className="text-muted-foreground p-6 text-sm" role="status">
          Opening Boards…
        </p>
      }
    >
      <BoardsPage />
    </Suspense>
  );
}

function BoardsPage() {
  const [preview, setPreview] = useState<string | null>(null);
  const controller = useBoardsController(preview);
  const resource = controller.resource;
  if (resource.status === "loading" && !resource.data)
    return (
      <div className="flex flex-col gap-3 p-6" role="status" aria-live="polite">
        <div className="bg-muted h-8 w-48 animate-pulse rounded-lg" />
        <div className="bg-muted h-24 w-full animate-pulse rounded-xl" />
        <p className="text-muted-foreground text-sm">Loading Boards…</p>
      </div>
    );
  if (resource.status === "error" && !resource.data)
    return (
      <Alert variant="destructive" className="m-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>{resource.error}</span>
          <Button
            className="min-h-11"
            variant="outline"
            onClick={resource.reload}
          >
            <RefreshCw data-icon="inline-start" /> Retry
          </Button>
        </div>
      </Alert>
    );
  return (
    <BoardsContent
      controller={controller}
      preview={preview}
      setPreview={setPreview}
    />
  );
}

function BoardsContent({
  controller,
  preview,
  setPreview,
}: {
  controller: BoardsController;
  preview: string | null;
  setPreview: (identityId: string | null) => void;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const { state, personal } = controller;
  const [department, setDepartment] = useState("all");
  const [status, setStatus] = useState("active");
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [editing, setEditing] = useState<WorkingCopy | null>(null);
  const [dialog, setDialog] = useState<BoardDialog>(null);
  const [creating, setCreating] = useState<{
    initial?: BoardConfiguration;
  } | null>(null);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [lifecycle, setLifecycle] = useState<"archive" | "delete" | null>(null);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(
    null,
  );
  const allowNextUnload = useRef(false);
  const [selectedDate, setSelectedDate] = useState(() =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: controller.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date()),
  );
  const [recomputed, setRecomputed] = useState<Record<string, string>>({});
  const dirty =
    editing !== null &&
    JSON.stringify(editing.original) !== JSON.stringify(editing.draft);
  const commandPending = controller.isPending();
  const visibleBoards = state.boards.filter((board) =>
    controller.can(board.id, "view"),
  );
  const requestedId = params.get("board");
  const home = visibleBoards.find(
    (board) => board.id === personal.homeBoardId && board.status === "active",
  );
  const selected =
    requestedId !== null
      ? visibleBoards.find((board) => board.id === requestedId)
      : (home ??
        visibleBoards.find((board) => board.status === "active") ??
        visibleBoards[0]);
  // Browser Back can change the URL while an unsaved board is open. Retain the
  // working copy until Save or Cancel; never substitute another board's draft.
  const board = editing?.draft ?? selected;
  const savedBoard = board
    ? state.boards.find((item) => item.id === board.id)
    : undefined;
  const requestedSection = params.get("section");
  const section: BoardSection = BOARD_SECTIONS.includes(
    requestedSection as BoardSection,
  )
    ? (requestedSection as BoardSection)
    : (board?.defaultSection ?? "overview");
  const editable =
    !!board &&
    !!savedBoard &&
    savedBoard.status === "active" &&
    !preview &&
    !commandPending &&
    (controller.can(board.id, "edit") || controller.can(board.id, "manage"));
  const manageable =
    !!board &&
    !preview &&
    !commandPending &&
    controller.can(board.id, "manage");
  const viewer: BoardViewer = {
    id: controller.actorId,
    active: controller.viewer?.active ?? false,
    roleIds:
      controller.lookup.roles
        ?.filter(
          (role) =>
            role.id === controller.viewer?.role ||
            role.name === controller.viewer?.role,
        )
        .map((role) => role.id) ?? [],
    departmentIds:
      controller.viewer?.departments.map((name) =>
        name.toLowerCase().replaceAll(" ", "-"),
      ) ?? [],
  };
  const people = controller.people;
  const roles = controller.lookup.roles ?? [];
  const departments = (controller.lookup.departments ?? []).map(
    (item) => item.name,
  );
  const choices = visibleBoards.filter(
    (item) =>
      (department === "all" || item.department === department) &&
      (status === "all" || item.status === status) &&
      (!onlyFavorites || personal.favoriteBoardIds.includes(item.id)),
  );

  async function report(
    result: Promise<BoardMutationResult>,
    text: string,
  ): Promise<BoardMutationResult> {
    try {
      const outcome = await result;
      setNotice(
        outcome.ok
          ? { error: false, text }
          : { error: true, text: outcome.error },
      );
      return outcome;
    } catch {
      const outcome = {
        ok: false as const,
        error: "The board could not be updated. Try again.",
      };
      setNotice({ error: true, text: outcome.error });
      return outcome;
    }
  }
  function navigate(id: string, nextSection?: BoardSection) {
    if (commandPending) return;
    const target = state.boards.find((item) => item.id === id);
    router.push(
      `/boards?board=${encodeURIComponent(id)}&section=${nextSection ?? target?.defaultSection ?? "overview"}`,
      { scroll: false },
    );
  }
  function guarded(action: () => void) {
    if (commandPending) return;
    if (dirty) setPending(() => action);
    else {
      setEditing(null);
      setDialog(null);
      action();
    }
  }
  function beginEdit(settings = false) {
    if (!editable || !board) return;
    allowNextUnload.current = false;
    setEditing({
      original: structuredClone(board),
      draft: structuredClone(board),
    });
    setNotice(null);
    if (settings) setDialog("settings");
  }
  async function saveBoard() {
    if (!editing) return;
    const result = await report(
      controller.run({ type: "save-board", ...editing }),
      "Board saved.",
    );
    if (result.ok) {
      const id = editing.draft.id;
      setEditing(null);
      setDialog(null);
      navigate(id, section);
    }
  }
  useEffect(() => {
    if (!dirty) {
      allowNextUnload.current = false;
      return;
    }
    const unload = (event: BeforeUnloadEvent) => {
      if (allowNextUnload.current) {
        allowNextUnload.current = false;
        return;
      }
      event.preventDefault();
    };
    const followLink = (event: MouseEvent) => {
      const anchor =
        event.target instanceof Element
          ? event.target.closest("a[href]")
          : null;
      if (
        !(anchor instanceof HTMLAnchorElement) ||
        anchor.target === "_blank" ||
        anchor.hasAttribute("download") ||
        event.ctrlKey ||
        event.metaKey
      )
        return;
      if (anchor.href === window.location.href) return;
      if (commandPending) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setPending(() => () => {
        allowNextUnload.current = true;
        window.location.href = anchor.href;
      });
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", followLink, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", followLink, true);
    };
  }, [commandPending, dirty]);
  const timerRef = useRef({ controller, board, editing, preview });
  useEffect(() => {
    timerRef.current = { controller, board, editing, preview };
  });
  useEffect(() => {
    const timer = window.setInterval(() => {
      const current = timerRef.current;
      if (
        document.visibilityState !== "visible" ||
        current.preview ||
        current.editing
      )
        return;
      void current.controller.processReminders();
      if (!current.board || current.board.status === "archived") return;
      const now = Date.now();
      setRecomputed((previous) => {
        const next = { ...previous };
        for (const widget of current.board!.widgets) {
          const interval =
            widget.refresh === "one-minute"
              ? 60_000
              : widget.refresh === "five-minutes"
                ? 300_000
                : 0;
          if (
            interval &&
            now -
              new Date(
                previous[widget.id] ?? current.board!.updatedAt,
              ).getTime() >=
              interval
          )
            next[widget.id] = new Date(now).toISOString();
        }
        return JSON.stringify(next) === JSON.stringify(previous)
          ? previous
          : next;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  async function announcementAction(
    action: AnnouncementAction,
  ): Promise<BoardMutationResult> {
    if (action.type === "publish" || action.type === "schedule")
      return controller.run({
        type: "save-announcement",
        announcement: action.announcement,
        original: action.original,
        intent: action.type,
      });
    if (!board)
      return { ok: false as const, error: "Choose an available board." };
    return controller.run({
      type: "announcement-action",
      boardId: board.id,
      announcementId: action.announcementId,
      action:
        action.type === "pin" ? (action.pinned ? "pin" : "unpin") : action.type,
    });
  }
  async function personalAction(
    action: AnnouncementPersonalAction,
  ): Promise<BoardMutationResult> {
    const key =
      action.type === "read"
        ? "readAnnouncementIds"
        : "bookmarkedAnnouncementIds";
    const enabled = action.type === "read" ? action.read : action.bookmarked;
    return controller.updatePersonal((current) => ({
      [key]: enabled
        ? [...new Set([...current[key], action.announcementId])]
        : current[key].filter((id) => id !== action.announcementId),
    }));
  }
  async function eventAction(
    event: BoardEvent,
    action: "archive" | "restore" | "delete",
  ): Promise<BoardMutationResult> {
    return controller.run({
      type: "event-action",
      boardId: event.boardId,
      eventId: event.id,
      action,
    });
  }
  const contextControls = (
    <div className="grid min-w-0 grid-cols-2 gap-3">
      <div className="col-span-2">
        <SearchSelect
          label="Board"
          value={board?.id ?? ""}
          placeholder="Choose a board"
          options={choices.map((item) => ({
            value: item.id,
            label: item.name,
            description: `${item.department}${item.status === "archived" ? " · Archived" : ""}${personal.favoriteBoardIds.includes(item.id) ? " · Favorite" : ""}`,
          }))}
          onValueChange={(id) => {
            setBrowsing(false);
            guarded(() => navigate(id));
          }}
        />
      </div>
      <SearchSelect
        label="Board department"
        value={department}
        options={[
          { value: "all", label: "All departments" },
          ...[...new Set(visibleBoards.map((item) => item.department))].map(
            (name) => ({ value: name, label: name }),
          ),
        ]}
        onValueChange={setDepartment}
      />
      <SearchSelect
        label="Board status"
        value={status}
        options={[
          { value: "active", label: "Active" },
          { value: "archived", label: "Archived" },
          { value: "all", label: "All boards" },
        ]}
        onValueChange={setStatus}
      />
    </div>
  );
  const shownWidgets =
    board?.widgets.filter(
      (widget) => manageable || canViewBoardAudience(widget.audience, viewer),
    ) ?? [];
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <header
        className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between"
        aria-label="Current board"
      >
        <div className="w-full min-w-0 sm:w-auto sm:flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight break-words sm:text-3xl">
              {board?.name ?? "Boards"}
            </h1>
            {board?.status === "archived" && (
              <Badge variant="outline">Archived</Badge>
            )}
            {editing && (
              <Badge variant="secondary">
                {dirty ? "Unsaved changes" : "Editing layout"}
              </Badge>
            )}
            {preview && <Badge variant="outline">Preview only</Badge>}
          </div>
          <p className="text-muted-foreground mt-1 text-sm break-words">
            {board?.description ||
              (board
                ? `${board.department} updates and information`
                : "Choose a board to see updates, requests, and upcoming dates.")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Popover open={browsing} onOpenChange={setBrowsing}>
            <PopoverTrigger
              render={<Button variant="outline" className="min-h-11" />}
            >
              <ChevronsUpDown data-icon="inline-start" />
              Switch board
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="w-[min(26rem,calc(100vw-2rem))] gap-4 p-4"
            >
              <PopoverHeader>
                <PopoverTitle>Find a board</PopoverTitle>
                <PopoverDescription>
                  These filters help you find boards.
                </PopoverDescription>
              </PopoverHeader>
              {contextControls}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-muted-foreground text-sm">
                  {choices.length} matching{" "}
                  {choices.length === 1 ? "board" : "boards"}
                </span>
                <Button
                  variant={onlyFavorites ? "secondary" : "ghost"}
                  className="min-h-11"
                  aria-pressed={onlyFavorites}
                  onClick={() => setOnlyFavorites(!onlyFavorites)}
                >
                  <Star data-icon="inline-start" /> Favorites only
                </Button>
              </div>
              {board && !choices.some((item) => item.id === board.id) && (
                <p className="text-muted-foreground text-sm">
                  The current board is outside these filters.
                </p>
              )}
              {(department !== "all" ||
                status !== "active" ||
                onlyFavorites) && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setDepartment("all");
                    setStatus("active");
                    setOnlyFavorites(false);
                  }}
                >
                  Reset board filters
                </Button>
              )}
              <Button
                variant="outline"
                className="min-h-11"
                disabled={!!preview || !controller.can(null, "manage")}
                onClick={() => {
                  setBrowsing(false);
                  guarded(() => setCreating({}));
                }}
              >
                <Plus data-icon="inline-start" /> New board
              </Button>
            </PopoverContent>
          </Popover>
          {board && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="outline" className="min-h-11" />}
              >
                <Settings2 data-icon="inline-start" />{" "}
                {editable || manageable ? "Manage board" : "Board options"}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-56">
                <DropdownMenuGroup>
                  {editable && !editing && (
                    <DropdownMenuItem
                      className="min-h-11"
                      onClick={() => setDialog("record")}
                    >
                      <Link2 /> Link a record
                    </DropdownMenuItem>
                  )}
                  {!editing && editable && (
                    <DropdownMenuItem
                      className="min-h-11"
                      onClick={() => beginEdit()}
                    >
                      <LayoutDashboard /> Edit board
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    className="min-h-11"
                    onClick={() => setDialog("tools")}
                  >
                    <Wrench /> Board tools
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    className="min-h-11"
                    disabled={!!preview || commandPending}
                    onClick={() => {
                      void report(
                        controller.updatePersonal((current) => ({
                          favoriteBoardIds: current.favoriteBoardIds.includes(
                            board.id,
                          )
                            ? current.favoriteBoardIds.filter(
                                (id) => id !== board.id,
                              )
                            : [...current.favoriteBoardIds, board.id],
                        })),
                        "Favorite updated.",
                      );
                    }}
                  >
                    <Star />{" "}
                    {personal.favoriteBoardIds.includes(board.id)
                      ? "Remove from favorites"
                      : "Add to favorites"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="min-h-11"
                    disabled={
                      !!preview || commandPending || board.status === "archived"
                    }
                    onClick={() => {
                      void report(
                        controller.updatePersonal((current) => ({
                          homeBoardId:
                            current.homeBoardId === board.id ? null : board.id,
                        })),
                        "Home board updated.",
                      );
                    }}
                  >
                    <Home />{" "}
                    {personal.homeBoardId === board.id
                      ? "Clear home board"
                      : "Set as home board"}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                {manageable && board.status === "active" && !editing && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <DropdownMenuItem
                        variant="destructive"
                        className="min-h-11"
                        onClick={() => setLifecycle("archive")}
                      >
                        <Archive /> Archive board
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {preview && (
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() =>
                guarded(() => {
                  setPreview(null);
                  router.replace("/boards", { scroll: false });
                })
              }
            >
              Exit preview
            </Button>
          )}
        </div>
      </header>
      {notice && (
        <Alert variant={notice.error ? "destructive" : "default"}>
          <div className="flex items-center justify-between gap-3">
            <span>{notice.text}</span>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Dismiss message"
              onClick={() => setNotice(null)}
            >
              <X />
            </Button>
          </div>
        </Alert>
      )}
      {controller.resource.status === "ready" && controller.resource.error && (
        <Alert variant="destructive">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>
              Boards is showing the last saved content. Refresh failed:{" "}
              {controller.resource.error}
            </span>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={controller.resource.reload}
            >
              <RefreshCw data-icon="inline-start" /> Retry refresh
            </Button>
          </div>
        </Alert>
      )}
      {!board ? (
        <BoardEmpty
          title={requestedId ? "Board unavailable" : "No boards available"}
          description={
            requestedId
              ? "This board may have been removed or your sample identity may not have access. Choose another board above."
              : "Create a private board to start arranging widgets, announcements, and events."
          }
          icon={<LayoutDashboard />}
        />
      ) : (
        <>
          {board.status === "archived" && (
            <Alert>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>
                  This board is archived. Restore it to resume changes.
                </span>
                {manageable && (
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      onClick={() => {
                        if (commandPending) return;
                        void report(
                          controller.run({
                            type: "board-action",
                            boardId: board.id,
                            action: "restore",
                          }),
                          "Board restored.",
                        );
                      }}
                    >
                      Restore board
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() => setLifecycle("delete")}
                    >
                      Delete permanently
                    </Button>
                  </div>
                )}
              </div>
            </Alert>
          )}
          {editing && (
            <div className="bg-card sticky top-2 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3 shadow-sm">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={!editable || board.widgets.length >= 12}
                  onClick={() => setDialog("widget")}
                >
                  <Plus />
                  Add widget
                </Button>
                {manageable && (
                  <Button
                    variant="outline"
                    className="min-h-11"
                    onClick={() => setDialog("settings")}
                  >
                    <Settings2 />
                    Settings
                  </Button>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  className="min-h-11"
                  onClick={() => guarded(() => {})}
                >
                  Cancel
                </Button>
                <Button
                  className="min-h-11"
                  disabled={commandPending || !dirty || !editable}
                  onClick={saveBoard}
                >
                  <Check />
                  Save board
                </Button>
              </div>
            </div>
          )}
          <Tabs
            value={section}
            onValueChange={(value) =>
              guarded(() => navigate(board.id, value as BoardSection))
            }
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <TabsList className="w-full sm:w-fit">
                {BOARD_SECTIONS.map((value) => (
                  <TabsTrigger
                    key={value}
                    className="min-h-11 flex-1 capitalize sm:flex-none"
                    value={value}
                  >
                    {value}
                  </TabsTrigger>
                ))}
              </TabsList>
              {section === "overview" && !!shownWidgets.length && !editing && (
                <Button
                  variant="ghost"
                  className="min-h-11"
                  onClick={() => {
                    const now = new Date().toISOString();
                    setRecomputed((previous) => ({
                      ...previous,
                      ...Object.fromEntries(
                        shownWidgets.map((widget) => [widget.id, now]),
                      ),
                    }));
                    setNotice({ error: false, text: "Summaries refreshed." });
                  }}
                >
                  <RefreshCw data-icon="inline-start" /> Refresh summaries
                </Button>
              )}
            </div>
            <TabsContent value="overview" className="space-y-5">
              {!shownWidgets.length ? (
                <BoardEmpty
                  title={
                    board.widgets.length
                      ? "No widgets visible to this identity"
                      : "Build your board’s overview"
                  }
                  description={
                    board.widgets.length
                      ? "Widget audiences can be narrower than the board’s audience."
                      : "Add a summary, workload, records list, or chart. Every widget has its own data source."
                  }
                  icon={<LayoutDashboard />}
                >
                  {editable && (
                    <Button
                      className="min-h-11"
                      onClick={() => {
                        if (!editing) beginEdit();
                        setDialog("widget");
                      }}
                    >
                      <Plus />
                      Add first widget
                    </Button>
                  )}
                </BoardEmpty>
              ) : editing ? (
                <WidgetSurface
                  board
                  mode="edit"
                  widgets={board.widgets}
                  records={controller.records}
                  maxWidgets={12}
                  audienceLookup={{
                    roles: [...(controller.lookup.roles ?? [])],
                    identities: [...(controller.lookup.identities ?? [])],
                  }}
                  onChange={(widgets) =>
                    setEditing({
                      ...editing,
                      draft: {
                        ...editing.draft,
                        widgets: decodeBoardWidgets(widgets, controller.lookup),
                      },
                    })
                  }
                  lastRecomputedAt={recomputed}
                  onRecompute={(widget, timestamp) =>
                    setRecomputed((current) => ({
                      ...current,
                      [widget.id]: timestamp,
                    }))
                  }
                />
              ) : (
                <WidgetSurface
                  board
                  mode="view"
                  widgets={shownWidgets}
                  records={controller.records}
                  audienceLookup={{
                    roles: [...(controller.lookup.roles ?? [])],
                    identities: [...(controller.lookup.identities ?? [])],
                  }}
                  lastRecomputedAt={recomputed}
                  onRecompute={(widget, timestamp) =>
                    setRecomputed((current) => ({
                      ...current,
                      [widget.id]: timestamp,
                    }))
                  }
                />
              )}
              {(editing ||
                state.placements.some(
                  (placement) => placement.boardId === board.id,
                )) && (
                <Card>
                  <CardHeader className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <CardTitle>Linked records</CardTitle>
                      <CardDescription>
                        Shortcuts to service requests that matter to this board.
                      </CardDescription>
                    </div>
                    {editable && (
                      <Button
                        variant="outline"
                        className="min-h-11"
                        onClick={() => setDialog("record")}
                      >
                        <Plus />
                        Add record
                      </Button>
                    )}
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {state.placements.filter(
                      (placement) => placement.boardId === board.id,
                    ).length === 0 && (
                      <p className="text-muted-foreground py-4 text-sm">
                        No records linked yet.
                      </p>
                    )}
                    {state.placements
                      .filter((placement) => placement.boardId === board.id)
                      .map((placement) => {
                        const record = controller.records.find(
                          (item) => item.id === placement.recordId,
                        );
                        return (
                          <div
                            key={placement.id}
                            className="flex items-center justify-between gap-3 rounded-lg border p-3"
                          >
                            <div className="min-w-0">
                              {record ? (
                                <Link
                                  href={`/openview?section=records&module=service-requests&record=${encodeURIComponent(record.id)}`}
                                  className="block truncate text-sm font-medium underline-offset-4 hover:underline"
                                >
                                  {record.title}
                                </Link>
                              ) : (
                                <p className="text-sm font-medium">
                                  Record unavailable
                                </p>
                              )}
                              <p className="text-muted-foreground text-xs">
                                {record
                                  ? `${record.status} · ${record.assignee}`
                                  : "Remove this shortcut and add an available record."}
                              </p>
                            </div>
                            {editable && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-11"
                                aria-label={`Remove linked record ${record?.title ?? "unavailable"}`}
                                onClick={() => {
                                  void report(
                                    controller.run({
                                      type: "remove-placement",
                                      boardId: board.id,
                                      placementId: placement.id,
                                    }),
                                    "Record shortcut removed.",
                                  );
                                }}
                              >
                                <X />
                              </Button>
                            )}
                          </div>
                        );
                      })}
                  </CardContent>
                </Card>
              )}
            </TabsContent>
            <TabsContent value="calendar" keepMounted>
              <BoardCalendar
                boardId={board.id}
                boardName={board.name}
                boardArchived={board.status === "archived"}
                pending={commandPending}
                events={state.events.filter(
                  (event) =>
                    event.boardId === board.id &&
                    (manageable ||
                      canViewBoardAudience(
                        event.audience,
                        viewer,
                        event.authorId,
                      )),
                )}
                records={controller.records}
                viewer={{
                  id: controller.actorId,
                  name: controller.viewer?.name ?? "Unavailable identity",
                  active: controller.viewer?.active ?? false,
                }}
                people={people}
                roles={roles}
                departments={departments}
                capabilities={{
                  view: controller.can(board.id, "view"),
                  edit: editable && !editing,
                  manage: manageable && !editing && board.status === "active",
                }}
                timezone={controller.timezone}
                selectedDate={selectedDate}
                onDateChange={setSelectedDate}
                personal={personal}
                previewAs={preview}
                onSave={(event, _scope, original) =>
                  controller.run({ type: "save-event", event, original })
                }
                onAction={eventAction}
                onRemind={controller.remind}
                onCancelReminder={(event, start) =>
                  controller.cancelReminder(event, start)
                }
                onPreferenceChange={controller.updatePersonal}
              />
            </TabsContent>
            <TabsContent value="announcements" keepMounted>
              <AnnouncementFeed
                boardId={board.id}
                announcements={state.announcements.filter(
                  (item) => item.boardId === board.id,
                )}
                viewer={viewer}
                people={people}
                roles={roles}
                departments={departments}
                canEdit={editable && !editing}
                canManage={manageable && !editing && board.status === "active"}
                preview={!!preview || board.status === "archived"}
                personal={personal}
                records={controller.records}
                timezone={controller.timezone}
                pending={commandPending}
                onSave={(announcement, original) =>
                  controller.run({
                    type: "save-announcement",
                    announcement,
                    original,
                    intent: "draft",
                  })
                }
                onAction={announcementAction}
                onPersonal={personalAction}
              />
            </TabsContent>
          </Tabs>
          {dialog === "settings" && editing && (
            <BoardSettingsSheet
              board={editing.draft}
              controller={controller}
              onChange={(draft) => setEditing({ ...editing, draft })}
              onClose={() => setDialog(null)}
            />
          )}
          {dialog === "tools" && (
            <BoardToolsSheet
              board={savedBoard ?? board}
              controller={controller}
              preview={!!preview}
              onPreviewChange={(id) =>
                guarded(() => {
                  setPreview(id);
                  router.replace("/boards", { scroll: false });
                })
              }
              onClose={() => setDialog(null)}
              onDuplicate={() =>
                guarded(() => {
                  setDialog(null);
                  setCreating({
                    initial: getBoardConfiguration(savedBoard ?? board),
                  });
                })
              }
            />
          )}
          {dialog === "widget" && editing && (
            <AddWidget
              onClose={() => setDialog(null)}
              onAdd={(widget) => {
                if (!editable || editing.draft.widgets.length >= 12) return;
                setEditing({
                  ...editing,
                  draft: {
                    ...editing.draft,
                    widgets: [...editing.draft.widgets, widget],
                  },
                });
                setDialog(null);
                navigate(board.id, "overview");
              }}
            />
          )}
          {dialog === "record" && (
            <AddRecord
              controller={controller}
              board={board}
              onClose={() => setDialog(null)}
            />
          )}
          <ConfirmAction
            open={lifecycle !== null}
            title={
              lifecycle === "delete"
                ? "Permanently delete this board?"
                : "Archive this board?"
            }
            action={
              lifecycle === "delete"
                ? "Delete board permanently"
                : "Archive board"
            }
            phrase={lifecycle === "delete" ? board.name : undefined}
            description={
              lifecycle === "delete"
                ? `${state.events.filter((item) => item.boardId === board.id).length} events, ${state.announcements.filter((item) => item.boardId === board.id).length} announcements, ${board.widgets.length} widgets, record shortcuts, and board access rules will be removed. Source records remain available.`
                : "The board and its content become read-only. You can restore it from the Archived filter."
            }
            onCancel={() => setLifecycle(null)}
            disabled={commandPending}
            onConfirm={() => {
              if (!lifecycle || commandPending) return;
              const action = lifecycle;
              void (async () => {
                const result = await report(
                  controller.run({
                    type: "board-action",
                    boardId: board.id,
                    action,
                  }),
                  action === "archive" ? "Board archived." : "Board deleted.",
                );
                if (result.ok) {
                  setLifecycle(null);
                  if (action === "delete") router.replace("/boards");
                }
              })();
            }}
          />
        </>
      )}
      {creating && (
        <CreateBoardSheet
          controller={controller}
          initial={creating.initial}
          onClose={() => setCreating(null)}
          onCreated={(created) => {
            setCreating(null);
            setDepartment("all");
            setStatus("active");
            setOnlyFavorites(false);
            navigate(created.id, created.defaultSection);
            setNotice({
              error: false,
              text: "Private board created. Open Manage board to edit the layout and visibility.",
            });
          }}
        />
      )}
      <ConfirmAction
        open={pending !== null}
        title="Discard unsaved board changes?"
        description="Your saved board stays as it is. This layout and settings draft will be discarded."
        action="Discard changes"
        disabled={commandPending}
        onCancel={() => {
          allowNextUnload.current = false;
          setPending(null);
        }}
        onConfirm={() => {
          const action = pending;
          setPending(null);
          setEditing(null);
          setDialog(null);
          action?.();
        }}
      />
    </div>
  );
}

function AddWidget({
  onAdd,
  onClose,
}: {
  onAdd: (widget: BoardWidget) => void;
  onClose: () => void;
}) {
  const [type, setType] = useState("summary");
  const [moduleId, setModuleId] =
    useState<OpenViewModuleId>("service-requests");
  const [name, setName] = useState("");
  const descriptions: Record<string, string> = {
    summary: "A quick count and breakdown of work.",
    workload: "See how work is distributed across your team.",
    records: "A focused list with the fields people need.",
    chart: "Compare values in a bar, line, or pie chart.",
  };
  return (
    <EditSheet
      open
      title="Add widget"
      description="Choose what to show. Configure fields, filters, and audience after adding it."
      dirty={!!name}
      onClose={onClose}
    >
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          const widget = newWidget(type);
          onAdd({
            ...widget,
            moduleId,
            name: name.trim() || widget.name,
            fields: getModuleDefinition(moduleId)
              .fields.slice(0, 3)
              .map((field) => field.id),
          });
        }}
      >
        <SearchSelect
          label="Widget type"
          value={type}
          options={Object.keys(descriptions).map((value) => ({
            value,
            label: value[0].toUpperCase() + value.slice(1),
            description: descriptions[value],
          }))}
          onValueChange={setType}
        />
        <SearchSelect
          label="Data source"
          value={moduleId}
          options={OPENVIEW_MODULES.map((module) => ({
            value: module.id,
            label: module.name,
            description: module.description,
          }))}
          onValueChange={(id) => setModuleId(id as OpenViewModuleId)}
        />
        <p className="text-muted-foreground text-sm">
          This source is independent of the board’s department. Filters select
          which records appear.
        </p>
        <Field>
          <FieldLabel htmlFor="widget-title">
            Widget title (optional)
          </FieldLabel>
          <Input
            id="widget-title"
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Button type="submit" className="min-h-11 w-full">
          Add to board draft
        </Button>
      </form>
    </EditSheet>
  );
}

function AddRecord({
  controller,
  board,
  onClose,
}: {
  controller: ReturnType<typeof useBoardsController>;
  board: Board;
  onClose: () => void;
}) {
  const [recordId, setRecordId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const available = controller.records.filter(
    (record) =>
      !controller.state.placements.some(
        (placement) =>
          placement.boardId === board.id && placement.recordId === record.id,
      ),
  );
  return (
    <EditSheet
      open
      title="Add linked record"
      description="Add a shortcut to this board. The source record stays in OpenView."
      dirty={false}
      pending={controller.isPending()}
      onClose={onClose}
    >
      <div className="space-y-5">
        <SearchSelect
          label="Service request"
          value={recordId}
          options={available.map((record) => ({
            value: record.id,
            label: record.title,
            description: `${record.status} · ${record.customer}`,
          }))}
          onValueChange={setRecordId}
        />
        {!available.length && (
          <p className="text-muted-foreground text-sm">
            All available records are already linked.
          </p>
        )}
        {error && (
          <Alert variant="destructive">
            <div>{error}</div>
          </Alert>
        )}
        <Button
          className="min-h-11 w-full"
          disabled={!recordId}
          onClick={() => {
            const now = new Date().toISOString();
            void controller
              .run({
                type: "place-record",
                placement: {
                  id: `board-placement-${crypto.randomUUID()}`,
                  boardId: board.id,
                  recordId,
                  moduleId: "service-requests",
                  pinned: false,
                  position: 0,
                  createdAt: now,
                  updatedAt: now,
                },
              })
              .then((result) => {
                if (result.ok) onClose();
                else setError(result.error);
              });
          }}
        >
          Add record
        </Button>
      </div>
    </EditSheet>
  );
}
