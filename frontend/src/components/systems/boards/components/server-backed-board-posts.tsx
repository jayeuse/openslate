"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { FilterRow } from "@/components/systems/access/components/access-toolbar";
import { Button } from "@/components/ui/button";
import { SearchSelect } from "@/components/ui/search-select";
import { toast } from "@/components/ui/toast";
import { useVerifiedWorkspaceUserId } from "@/components/systems/shared/runtime/workspace-identity";
import type { WorkspaceRegion } from "@/lib/date-time";
import type { BoardManagementBoard } from "../adapters/board-management-api";
import { readBoardPost, type BoardPost } from "../adapters/board-posts-api";
import { getBoardPostManageState } from "../adapters/board-post-manage-state-api";
import type { BoardPostAuthorChoice } from "../adapters/board-post-author-api";
import {
  canEditPost,
  parsePostShow,
  postAudienceLine,
  postListEmpty,
  postMenuActions,
  postRowMeta,
  postStatesFor,
  postViewForState,
  postingReason,
  readsPostManageState,
  type PostMenuAction,
  type PostViewer,
} from "../domain/post-list";
import { useServerBoardPostEditor } from "../hooks/use-server-board-post-editor";
import { useBoardPostActions } from "../hooks/use-server-board-post-lifecycle";
import {
  normalizePublishedPostSearch,
  postFeedFailure,
  postFeedQueryForSort,
  useServerBoardPostAuthorLabels,
  useServerBoardPostAuthors,
  useServerBoardPosts,
  type PublishedPostSort,
} from "../hooks/use-server-board-posts";
import { canonicalBoardUrl } from "../hooks/use-server-boards";
import { BoardPostList } from "./board-post-list";
import { BoardPostPane, type PostPaneState } from "./board-post-pane";
import { BoardPostEditorDialog } from "./server-backed-board-post-editor";
import { ServerBoardPostHistory } from "./server-board-post-history";
import { ConfirmAction } from "./ui";

const PAGE_SIZE = 25;
const WIDE_QUERY = "(min-width: 64rem)";

function subscribeWide(onChange: () => void) {
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** True from 1024px, where the list and the reading pane sit side by side. */
function useSideBySide(): boolean {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => false,
  );
}

export type PostParams = {
  post?: string | null;
  show?: string | null;
  /** "push" adds a history entry (a phone opening a post); else replace. */
  history?: "push";
};

type PostsProps = {
  board: BoardManagementBoard;
  region: WorkspaceRegion | undefined;
  refreshKey: number;
  /** `?post=`: the open post. */
  selectedPostId: string | null;
  /** `?show=`: the list state. */
  show: string | null;
  /** Changes the post and state in the address. */
  onParams: (params: PostParams) => void;
  /** The header's slot for the tab's one primary action. */
  primarySlot: HTMLElement | null;
  guest: boolean;
  onChanged: () => void;
  onAccessDenied: (boardId: string) => void;
  onDraftStateChange: (
    boardId: string,
    dirty: boolean,
    pending: boolean,
  ) => void;
};

/**
 * The Posts tab (BR10–BR15): from 1024px a list panel and a reading pane
 * side by side; on a phone the list, then the post as its own view.
 */
export function ServerBackedBoardPosts(props: PostsProps) {
  const actorId = useVerifiedWorkspaceUserId();
  return (
    <ScopedServerBackedBoardPosts
      key={`${actorId}:${props.board.id}`}
      {...props}
    />
  );
}

const MENU_CONFIRM = {
  unpublish: {
    title: "Unpublish post?",
    description:
      "Readers no longer see it, and a scheduled replacement is canceled.",
    action: "Unpublish post",
  },
  archive: {
    title: "Archive post?",
    description: "Readers no longer see it. A board manager can restore it.",
    action: "Archive post",
  },
  delete: {
    title: "Delete draft?",
    description:
      "It was never published, so it goes with its files and record links.",
    action: "Delete draft",
  },
} as const;

function ScopedServerBackedBoardPosts({
  board,
  region,
  refreshKey,
  selectedPostId,
  show,
  onParams,
  primarySlot,
  guest,
  onChanged,
  onAccessDenied,
  onDraftStateChange,
}: PostsProps) {
  const boardId = board.id;
  const actorId = useVerifiedWorkspaceUserId();
  const router = useRouter();
  const sideBySide = useSideBySide();
  const states = postStatesFor(board.level);
  const state = parsePostShow(show, board.level);
  const active = board.status === "active";
  const viewer: PostViewer = {
    actorId,
    canWrite: board.level !== "read",
    canManage: board.level === "manage",
    boardActive: active,
  };
  const canPost = active && viewer.canWrite;

  // The editor: New post in the header and Edit in the pane open one owner.
  const editor = useServerBoardPostEditor({
    boardId,
    boardRevision: board.revision,
    boardStatus: board.status,
    refreshKey,
    region,
    onPublished: onChanged,
  });
  // The board's level shows New post at once; the editor's access check can
  // still withdraw it.
  const mayPost =
    canPost && (editor.view.canEdit || editor.view.status === "loading");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<"new" | "edit">("new");
  const editorChanged = editor.view.dirty || editor.view.scheduleDirty;
  useEffect(() => {
    onDraftStateChange(boardId, editorChanged, editor.view.pending);
  }, [boardId, editorChanged, editor.view.pending, onDraftStateChange]);
  useEffect(
    () => () => onDraftStateChange(boardId, false, false),
    [boardId, onDraftStateChange],
  );

  // The list: search applies as it is typed, after a short pause.
  const [query, setQuery] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  useEffect(() => {
    const next = normalizePublishedPostSearch(query);
    const timer = setTimeout(() => setAppliedSearch(next), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const [sort, setSort] = useState<PublishedPostSort>("newest");
  const [selectedAuthor, setSelectedAuthor] =
    useState<BoardPostAuthorChoice | null>(null);
  const [authorSearch, setAuthorSearch] = useState("");
  const listScope = `${state}:${appliedSearch}:${selectedAuthor?.id ?? ""}:${sort}`;
  const [paging, setPaging] = useState({ scope: listScope, offset: 0 });
  const authors = useServerBoardPostAuthors(boardId, refreshKey, authorSearch);
  const authorSelectionGone = authors.state.status === "denied";
  const visibleAuthorId = authorSelectionGone
    ? null
    : (selectedAuthor?.id ?? null);
  const offset =
    authorSelectionGone || paging.scope !== listScope ? 0 : paging.offset;
  const feed = useServerBoardPosts(
    boardId,
    offset,
    refreshKey,
    appliedSearch,
    visibleAuthorId,
    authors.readyToRead,
    { limit: PAGE_SIZE, ...postFeedQueryForSort(sort) },
    state,
  );

  // The open post, read in the view of the list it came from.
  const view = postViewForState(state);
  const [detailRetry, setDetailRetry] = useState(0);
  const detailKey = `${boardId}:${view}:${selectedPostId}:${refreshKey}:${detailRetry}`;
  const [detail, setDetail] = useState<{
    key: string;
    post: BoardPost | null;
    transient: boolean;
  } | null>(null);
  useEffect(() => {
    if (!actorId || selectedPostId === null) return;
    let live = true;
    void readBoardPost(boardId, selectedPostId, view)
      .then((post) => {
        if (live) setDetail({ key: detailKey, post, transient: false });
      })
      .catch((error: unknown) => {
        if (live)
          setDetail({
            key: detailKey,
            post: null,
            transient: postFeedFailure(error).retain,
          });
      });
    return () => {
      live = false;
    };
  }, [actorId, boardId, detailKey, selectedPostId, view]);
  const openDetail = detail?.key === detailKey ? detail : null;
  const openPost = selectedPostId !== null ? (openDetail?.post ?? null) : null;

  const loaded = authorSelectionGone ? null : feed.state.data;
  // Expiry words compare with the time the page was read.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => setNow(Date.now()), [loaded]);
  const knownAuthorIds = [
    ...(loaded?.items.map((post) => post.authorId) ?? []),
    ...(openPost ? [openPost.authorId] : []),
  ];
  const labels = useServerBoardPostAuthorLabels(
    boardId,
    refreshKey,
    knownAuthorIds,
    authors.readyToRead,
  );
  const authorsDenied = authorSelectionGone || labels.denied;
  // A refused author read hides every row, not only the names.
  const page = authorsDenied ? null : loaded;
  const knownLabels = new Map(
    (labels.state.data ?? []).map((choice) => [choice.id, choice.label]),
  );
  const authorLabel = (authorId: string) =>
    authorsDenied
      ? "Author unavailable"
      : (knownLabels.get(authorId) ??
        (labels.state.status === "loading"
          ? "Loading author…"
          : "Author unavailable"));

  // A page past the end (posts left the list) steps back to the last page.
  useEffect(() => {
    if (!page || page.pagination.count > 0 || offset === 0) return;
    const total = page.pagination.total;
    setPaging({
      scope: listScope,
      offset: total === 0 ? 0 : Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE,
    });
  }, [listScope, offset, page]);

  // From 1024px a bare Posts view opens its first post, replacing the
  // address (BR12); a phone keeps the list.
  const firstId = page?.items[0]?.id ?? null;
  useEffect(() => {
    if (sideBySide && selectedPostId === null && firstId !== null)
      onParams({ post: firstId });
  }, [firstId, onParams, selectedPostId, sideBySide]);

  const actions = useBoardPostActions({
    boardId,
    canManage: viewer.canManage,
    onChanged: (action) => {
      onChanged();
      if (action && action.postId === selectedPostId) onParams({ post: null });
    },
    onAccessDenied,
  });
  const [historyPost, setHistoryPost] = useState<BoardPost | null>(null);

  // Delete draft waits for the post's manage state, read as the menu opens:
  // only a post that was never published offers it (BR14).
  const [manageState, setManageState] = useState<{
    postId: string;
    publishedBefore: boolean;
  } | null>(null);
  const manageRead = useRef(0);
  function readManageState(post: BoardPost) {
    const request = ++manageRead.current;
    setManageState(null);
    void getBoardPostManageState(boardId, post.id)
      .then((state) => {
        if (request === manageRead.current)
          setManageState({
            postId: post.id,
            publishedBefore: state.publishedBefore,
          });
      })
      // Without the read the menu keeps its other actions.
      .catch(() => undefined);
  }
  const publishedBefore =
    openPost && manageState?.postId === openPost.id
      ? manageState.publishedBefore
      : null;

  // On a phone the post replaces the list: opening a row adds a history
  // entry, so the system Back and Back to posts both return to the list.
  // Focus moves to the post's title, then back to its row.
  const pushedPostId = useRef<string | null>(null);
  const [focusTitle, setFocusTitle] = useState(false);
  const [focusRow, setFocusRow] = useState<string | null>(null);
  const titleFocused = useCallback(() => setFocusTitle(false), []);
  const rowFocused = useCallback(() => setFocusRow(null), []);
  function openRow(postId: string) {
    if (sideBySide) {
      onParams({ post: postId });
      return;
    }
    pushedPostId.current = postId;
    setFocusTitle(true);
    onParams({ post: postId, history: "push" });
  }
  function backToList() {
    setFocusTitle(false);
    setFocusRow(selectedPostId);
    if (selectedPostId !== null && pushedPostId.current === selectedPostId) {
      pushedPostId.current = null;
      router.back();
    } else onParams({ post: null });
  }

  function runMenu(post: BoardPost, action: PostMenuAction) {
    if (action === "history") {
      setHistoryPost(post);
      return;
    }
    if (action === "copy-link") {
      const href = `${window.location.origin}${canonicalBoardUrl(board, "posts", `post=${post.id}`)}`;
      void navigator.clipboard
        .writeText(href)
        .then(() => toast.add({ title: "Link copied", type: "success" }))
        .catch(() =>
          toast.add({ title: "The link could not be copied.", type: "error" }),
        );
      return;
    }
    actions.begin(post, action);
  }

  const paneState: PostPaneState =
    selectedPostId === null
      ? // Beside an empty list, or while it first loads, there is no post
        // to choose, so the pane holds no hint.
        { kind: "none", hint: (page?.items.length ?? 0) > 0 }
      : authorsDenied
        ? {
            kind: "unavailable",
            retry: () => {
              authors.retry();
              labels.retry();
            },
          }
        : openDetail === null
          ? { kind: "loading" }
          : openDetail.post
            ? { kind: "post", post: openDetail.post }
            : {
                kind: "unavailable",
                retry: openDetail.transient
                  ? () => setDetailRetry((value) => value + 1)
                  : null,
              };

  const rows = (page?.items ?? []).map((post) => ({
    id: post.id,
    title: post.title,
    pinned: post.pinned,
    meta: postRowMeta(post, authorLabel(post.authorId), region, now).filter(
      (part) => part !== "Pinned",
    ),
  }));
  const filtered = appliedSearch !== "" || visibleAuthorId !== null;
  const emptyCopy = postListEmpty(
    state,
    filtered,
    mayPost ? null : postingReason(board, guest),
  );
  const authorError = authors.state.error ?? labels.state.error;
  const clearFilters = () => setSelectedAuthor(null);
  const openNew = () => {
    editor.newDraft();
    setEditorMode("new");
    setEditorOpen(true);
  };

  const newPost = mayPost ? (
    <Button
      type="button"
      className="min-h-11 xl:min-h-8"
      disabled={!editor.view.canEdit || editor.view.pending}
      onClick={openNew}
    >
      <Plus aria-hidden="true" />
      New post
    </Button>
  ) : null;

  return (
    <div className="slim-ui flex min-w-0 flex-col gap-4 lg:grid lg:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)] xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(20rem,24rem)_minmax(0,1fr)] xl:grid-rows-[minmax(0,1fr)]">
      {primarySlot && newPost ? createPortal(newPost, primarySlot) : null}
      <div
        className={
          selectedPostId !== null
            ? "flex min-w-0 flex-col max-lg:hidden xl:min-h-0"
            : "flex min-w-0 flex-col xl:min-h-0"
        }
      >
        <BoardPostList
          states={states}
          state={state}
          onStateChange={(next) =>
            onParams({ show: next === "published" ? null : next, post: null })
          }
          query={query}
          onQueryChange={(value) => setQuery(value.slice(0, 100))}
          sort={sort}
          onSortChange={setSort}
          chips={
            selectedAuthor && !authorsDenied
              ? [
                  {
                    key: "author",
                    label: "Author",
                    value: selectedAuthor.label,
                    onRemove: clearFilters,
                  },
                ]
              : []
          }
          onClearFilters={clearFilters}
          filters={
            <FilterRow>
              <SearchSelect
                label="Author"
                value={visibleAuthorId ?? ""}
                options={[
                  { value: "", label: "All authors" },
                  ...((authorsDenied ? null : authors.state.data) ?? []).map(
                    (choice) => ({ value: choice.id, label: choice.label }),
                  ),
                ]}
                selectedOption={
                  selectedAuthor && !authorsDenied
                    ? { value: selectedAuthor.id, label: selectedAuthor.label }
                    : undefined
                }
                search={authorSearch}
                onSearchChange={(value) => setAuthorSearch(value.slice(0, 100))}
                loading={
                  authors.state.status === "loading" && !authors.loadingMore
                }
                loadingMore={authors.loadingMore}
                error={authorError ?? undefined}
                onRetry={() => {
                  authors.retry();
                  labels.retry();
                }}
                hasMore={authors.state.pagination?.hasMore}
                onLoadMore={authors.loadMore}
                disabled={authorsDenied}
                onValueChange={(value) => {
                  const choice =
                    authors.state.data?.find((item) => item.id === value) ??
                    (selectedAuthor?.id === value ? selectedAuthor : null);
                  if (value && !choice) return;
                  setSelectedAuthor(value ? choice : null);
                }}
              />
            </FilterRow>
          }
          page={page}
          rows={rows}
          loading={feed.state.status === "loading"}
          error={feed.state.error ?? authorError}
          onRetry={() => {
            if (feed.state.error) feed.retry();
            if (authorError) {
              authors.retry();
              labels.retry();
            }
          }}
          selectedId={selectedPostId}
          onOpen={openRow}
          focusRowId={selectedPostId === null ? focusRow : null}
          onRowFocused={rowFocused}
          emptyTitle={emptyCopy.title}
          onPage={(next) => setPaging({ scope: listScope, offset: next })}
          empty={
            <div className="flex flex-col items-start gap-2 p-5">
              <h3 data-slot="empty-title" className="font-medium">
                {emptyCopy.title}
              </h3>
              <p className="text-muted-foreground text-sm">
                {emptyCopy.description}
              </p>
              {filtered ? (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 xl:min-h-8"
                  onClick={() => {
                    setQuery("");
                    setAppliedSearch("");
                    clearFilters();
                  }}
                >
                  Clear search and filters
                </Button>
              ) : mayPost && (state === "published" || state === "drafts") ? (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11 xl:min-h-8"
                  disabled={!editor.view.canEdit}
                  onClick={openNew}
                >
                  <Plus aria-hidden="true" />
                  New post
                </Button>
              ) : null}
            </div>
          }
        />
      </div>
      <div
        className={
          selectedPostId === null
            ? "flex min-w-0 flex-col max-lg:hidden xl:min-h-0"
            : "flex min-w-0 flex-col xl:min-h-0"
        }
      >
        <BoardPostPane
          state={paneState}
          region={region}
          authorLabel={openPost ? authorLabel(openPost.authorId) : ""}
          canEdit={
            openPost !== null &&
            canEditPost(openPost, viewer) &&
            editor.view.canEdit
          }
          actions={
            openPost ? postMenuActions(openPost, viewer, publishedBefore) : []
          }
          busy={
            (openPost !== null && actions.pendingPostId === openPost.id) ||
            editor.view.pending
          }
          onEdit={() => {
            if (!openPost) return;
            void editor.edit(openPost.id).then((opened) => {
              if (!opened) return;
              setEditorMode("edit");
              setEditorOpen(true);
            });
          }}
          onAction={(action) => {
            if (openPost) runMenu(openPost, action);
          }}
          onBack={backToList}
          onMenuOpen={() => {
            if (openPost && readsPostManageState(openPost, viewer))
              readManageState(openPost);
          }}
          focusTitle={focusTitle && !sideBySide}
          onTitleFocused={titleFocused}
        />
      </div>
      <BoardPostEditorDialog
        boardId={boardId}
        editor={editor}
        open={editorOpen}
        mode={editorMode}
        audience={postAudienceLine(board)}
        onClose={() => setEditorOpen(false)}
        onPublished={(postId) => {
          setEditorOpen(false);
          toast.add({ title: "Post published", type: "success" });
          onParams({ post: postId, show: null });
        }}
      />
      {historyPost ? (
        <ServerBoardPostHistory
          region={region}
          boardId={boardId}
          postId={historyPost.id}
          title={historyPost.title}
          authorLabels={Object.fromEntries(knownLabels)}
          onClose={() => setHistoryPost(null)}
        />
      ) : null}
      <ConfirmAction
        open={actions.confirmation !== null}
        title={
          actions.confirmation && actions.confirmation.kind !== "restore"
            ? MENU_CONFIRM[actions.confirmation.kind].title
            : ""
        }
        description={
          actions.confirmation && actions.confirmation.kind !== "restore"
            ? MENU_CONFIRM[actions.confirmation.kind].description
            : ""
        }
        action={
          actions.confirmation && actions.confirmation.kind !== "restore"
            ? MENU_CONFIRM[actions.confirmation.kind].action
            : ""
        }
        disabled={actions.pendingPostId !== null}
        onCancel={actions.cancel}
        onConfirm={actions.confirm}
      />
    </div>
  );
}
