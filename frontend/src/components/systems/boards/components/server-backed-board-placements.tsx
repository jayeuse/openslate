"use client";

import { createElement, useEffect, useId, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { PaginationControls } from "@/components/ui/pagination-controls";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApiContractError, ApiError } from "@/lib/api";
import {
  createBoardPlacement,
  deleteBoardPlacement,
  listBoardPlacements,
  type BoardPlacementPage,
} from "../adapters/board-placements-api";
import {
  getMyBoardAccess,
  type BoardMyAccess,
} from "../adapters/board-tools-api";
import {
  listOpenViewDataSourceFields,
  listOpenViewDataSources,
  queryOpenViewRecords,
  type OpenViewDataSource,
  type OpenViewPage,
  type OpenViewQueryDefinition,
} from "../../openview/adapters/views-api";
import { BoardEmpty } from "./ui";

const PAGE_SIZE = 25;
const PLACEMENT_PAGE_SIZE_OPTIONS = [5, 10, 25] as const;
const LABEL_TYPES = new Set(["text", "long_text", "email", "url", "select"]);

export type PlacementWorkspaceState = {
  key: string | null;
  sequence: number;
  status: "idle" | "loading" | "ready" | "error";
  page: BoardPlacementPage | null;
  access: BoardMyAccess | null;
  error: string | null;
};
export type PlacementWorkspaceEvent =
  | { type: "begin"; key: string; sequence: number }
  | {
      type: "resolve";
      key: string;
      sequence: number;
      page: BoardPlacementPage;
      access: BoardMyAccess;
    }
  | {
      type: "reject";
      key: string;
      sequence: number;
      error: string;
      retain: boolean;
    };

export const emptyPlacementWorkspaceState: PlacementWorkspaceState = {
  key: null,
  sequence: 0,
  status: "idle",
  page: null,
  access: null,
  error: null,
};

export function transitionPlacementWorkspace(
  state: PlacementWorkspaceState,
  event: PlacementWorkspaceEvent,
): PlacementWorkspaceState {
  if (event.type === "begin")
    return {
      key: event.key,
      sequence: event.sequence,
      status: "loading",
      page: null,
      access: null,
      error: null,
    };
  if (state.key !== event.key || state.sequence !== event.sequence)
    return state;
  if (event.type === "resolve")
    return {
      ...state,
      status: "ready",
      page: event.page,
      access: event.access,
      error: null,
    };
  return {
    ...state,
    status: "error",
    error: event.error,
    page: event.retain ? state.page : null,
    access: event.retain ? state.access : null,
  };
}

type RecordChoicesPage = {
  choices: { id: string; label: string }[];
  hasMore: boolean;
};

/** Candidate labels are obtained only through the records.read-gated catalog and query. */
export async function loadPlacementRecordChoices(
  moduleId: string,
  search: string,
  offset: number,
): Promise<RecordChoicesPage> {
  const fields = await listOpenViewDataSourceFields(moduleId, {
    limit: 100,
    offset: 0,
  });
  if (
    fields.pagination.offset !== 0 ||
    fields.pagination.count !== fields.items.length
  )
    throw new ApiContractError();
  const labelField = fields.items.find((field) => LABEL_TYPES.has(field.type));
  const definition: OpenViewQueryDefinition = {
    version: 1,
    logic: "and",
    columns: labelField
      ? [{ fieldId: labelField.id, expectedType: labelField.type }]
      : [],
    filters: [],
    sort: [],
    deleted: "exclude",
    search: search.trim().slice(0, 240) || null,
    searchFields: fields.items
      .filter((field) => LABEL_TYPES.has(field.type))
      .map((field) => ({ fieldId: field.id, expectedType: field.type })),
  };
  const result = await queryOpenViewRecords({
    moduleId,
    definition,
    limit: PAGE_SIZE,
    offset,
  });
  if (
    result.pagination.offset !== offset ||
    result.pagination.count !== result.items.length ||
    result.items.some(
      (record) => record.moduleId !== moduleId || record.isDeleted,
    )
  )
    throw new ApiContractError();
  return {
    choices: result.items.map((record) => {
      const value = labelField ? record.data[labelField.id] : null;
      const title = typeof value === "string" ? value.trim().slice(0, 120) : "";
      return {
        id: record.id,
        label: title || `Record ${record.id.slice(0, 8)}`,
      };
    }),
    hasMore: result.pagination.hasMore,
  };
}

function failure(error: unknown): { message: string; denied: boolean } {
  if (error instanceof ApiError) {
    if ([401, 403, 404].includes(error.status))
      return {
        message: "Board shortcuts are unavailable with your current access.",
        denied: true,
      };
    if (error.status === 409) return { message: error.message, denied: false };
  }
  return {
    message: "Could not load Board shortcuts. Try again.",
    denied: false,
  };
}

function choiceQueryRevokedBoardAccess(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

export function ServerBoardPlacementsDisplay({
  page,
  canEdit = false,
  pending = false,
  onRemove,
  onAddShortcut,
  sources,
}: {
  page: BoardPlacementPage;
  canEdit?: boolean;
  pending?: boolean;
  onRemove?: (placementId: string) => void;
  onAddShortcut?: () => void;
  sources?: OpenViewDataSource[];
}) {
  return createElement(
    "section",
    { "aria-label": "Linked records", className: "min-w-0" },
    createElement(
      "div",
      { className: "mb-4 flex flex-wrap items-center justify-between gap-3" },
      createElement(
        "div",
        { className: "min-w-0" },
        createElement(
          "h2",
          { className: "text-lg font-semibold" },
          "Linked records",
        ),
        createElement(
          "p",
          { className: "text-muted-foreground text-sm", role: "status" },
          `${page.pagination.total} record shortcuts`,
        ),
      ),
      canEdit && onAddShortcut
        ? createElement(
            Button,
            {
              type: "button",
              variant: "outline",
              className: "min-h-11",
              disabled: pending,
              onClick: onAddShortcut,
            },
            "Add shortcut",
          )
        : null,
    ),
    createElement(
      Table,
      { "aria-label": "Linked record shortcuts" },
      createElement(
        TableHeader,
        null,
        createElement(
          TableRow,
          null,
          createElement(TableHead, null, "Record"),
          createElement(TableHead, null, "Source"),
          createElement(TableHead, { className: "text-right" }, "Action"),
        ),
      ),
      createElement(
        TableBody,
        null,
        page.items.length === 0
          ? createElement(
              TableRow,
              null,
              createElement(
                TableCell,
                {
                  colSpan: 3,
                  className:
                    "text-muted-foreground whitespace-normal py-6 text-sm",
                },
                canEdit
                  ? "No linked records on this page. Add a shortcut to make an OpenView record easy to reach."
                  : "No linked records on this page.",
              ),
            )
          : page.items.map((placement) => {
              const sourceName =
                placement.available && placement.moduleId
                  ? sources?.find((source) => source.id === placement.moduleId)
                      ?.name
                  : null;
              return createElement(
                TableRow,
                { key: placement.id },
                createElement(
                  TableCell,
                  { className: "whitespace-normal" },
                  createElement(
                    "p",
                    { className: "font-medium" },
                    placement.available
                      ? "Record shortcut"
                      : "Unavailable record",
                  ),
                  createElement(
                    "p",
                    { className: "text-muted-foreground text-sm" },
                    placement.available
                      ? "OpenView checks your record access again when you open it."
                      : "This record or its source is no longer available.",
                  ),
                ),
                createElement(
                  TableCell,
                  {
                    className:
                      "text-muted-foreground max-w-48 whitespace-normal",
                  },
                  placement.available
                    ? sourceName || "Source name unavailable"
                    : "Unavailable source",
                ),
                createElement(
                  TableCell,
                  { className: "whitespace-normal" },
                  createElement(
                    "div",
                    { className: "flex flex-wrap justify-end gap-2" },
                    placement.available && placement.moduleId
                      ? createElement(
                          "a",
                          {
                            className:
                              "border-border bg-card hover:bg-muted inline-flex min-h-11 items-center rounded-md border px-3 text-sm font-medium",
                            href: `/openview?module=${encodeURIComponent(placement.moduleId)}&record=${encodeURIComponent(placement.recordId)}`,
                          },
                          "Open record",
                        )
                      : null,
                    canEdit && onRemove
                      ? createElement(
                          Button,
                          {
                            type: "button",
                            variant: "outline",
                            className: "min-h-11",
                            disabled: pending,
                            onClick: () => onRemove(placement.id),
                          },
                          "Remove shortcut",
                        )
                      : null,
                  ),
                ),
              );
            }),
      ),
    ),
  );
}

type LoadState<T> = {
  key: string;
  status: "loading" | "ready" | "error";
  data: T | null;
  error: string | null;
};

export function ServerBackedBoardPlacements({
  boardId,
  boardActive,
  refreshKey,
  onAccessDenied,
}: {
  boardId: string;
  boardActive: boolean;
  refreshKey: number;
  onAccessDenied: () => void;
}) {
  const pageSizeControlId = useId();
  const [placementPaging, setPlacementPaging] = useState({
    boardId,
    offset: 0,
  });
  const [placementPageSize, setPlacementPageSize] = useState<number>(PAGE_SIZE);
  const offset =
    placementPaging.boardId === boardId ? placementPaging.offset : 0;
  const [refresh, setRefresh] = useState(0);
  const [workspace, setWorkspace] = useState(emptyPlacementWorkspaceState);
  const workspaceSequence = useRef(0);
  const currentBoard = useRef(boardId);
  const onAccessDeniedRef = useRef(onAccessDenied);
  useEffect(() => {
    onAccessDeniedRef.current = onAccessDenied;
  }, [onAccessDenied]);
  const workspaceKey = `${boardId}:${placementPageSize}:${offset}:${refreshKey}:${refresh}`;
  const currentWorkspace =
    workspace.key === workspaceKey ? workspace : emptyPlacementWorkspaceState;
  const [sourcePaging, setSourcePaging] = useState({ boardId, offset: 0 });
  const sourceOffset =
    sourcePaging.boardId === boardId ? sourcePaging.offset : 0;
  const [sources, setSources] = useState<LoadState<
    OpenViewPage<OpenViewDataSource>
  > | null>(null);
  const sourceSequence = useRef(0);
  const sourceKey = `${boardId}:${sourceOffset}:${refreshKey}:${refresh}`;
  const [selection, setSelection] = useState({
    boardId,
    moduleId: "",
    recordId: "",
  });
  const selectedModuleId =
    selection.boardId === boardId ? selection.moduleId : "";
  const selectedRecordId =
    selection.boardId === boardId ? selection.recordId : "";
  const [searchDraft, setSearchDraft] = useState("");
  const [query, setQuery] = useState({
    boardId,
    moduleId: "",
    search: "",
    offset: 0,
  });
  const [records, setRecords] = useState<LoadState<RecordChoicesPage> | null>(
    null,
  );
  const recordSequence = useRef(0);
  const recordKey = `${boardId}:${selectedModuleId}:${query.search}:${query.offset}:${refreshKey}:${refresh}`;
  const [pending, setPending] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    currentBoard.current = boardId;
    setPending(false);
    setConflict(false);
    setMutationError(null);
    setPickerOpen(false);
    return () => {
      currentBoard.current = "";
    };
  }, [boardId]);

  useEffect(() => {
    if (!boardActive || currentWorkspace.access?.edit === false)
      setPickerOpen(false);
  }, [boardActive, currentWorkspace.access?.edit]);

  useEffect(() => {
    const sequence = ++workspaceSequence.current;
    setWorkspace((state) =>
      transitionPlacementWorkspace(state, {
        type: "begin",
        key: workspaceKey,
        sequence,
      }),
    );
    void Promise.all([
      getMyBoardAccess(boardId),
      listBoardPlacements(boardId, { limit: placementPageSize, offset }),
    ])
      .then(([access, page]) => {
        if (sequence !== workspaceSequence.current) return;
        if (
          page.pagination.limit !== placementPageSize ||
          page.pagination.offset !== offset ||
          page.pagination.count !== page.items.length
        )
          throw new ApiContractError();
        if (offset > 0 && offset >= page.pagination.total) {
          const lastValidOffset =
            page.pagination.total === 0
              ? 0
              : Math.floor((page.pagination.total - 1) / placementPageSize) *
                placementPageSize;
          setPlacementPaging({ boardId, offset: lastValidOffset });
          return;
        }
        setWorkspace((state) =>
          transitionPlacementWorkspace(state, {
            type: "resolve",
            key: workspaceKey,
            sequence,
            page,
            access,
          }),
        );
        setConflict(false);
        setMutationError(null);
      })
      .catch((error: unknown) => {
        if (sequence !== workspaceSequence.current) return;
        const result = failure(error);
        setWorkspace((state) =>
          transitionPlacementWorkspace(state, {
            type: "reject",
            key: workspaceKey,
            sequence,
            error: result.message,
            retain: false,
          }),
        );
        if (result.denied) {
          setPickerOpen(false);
          onAccessDeniedRef.current();
        }
      });
    return () => {
      workspaceSequence.current += 1;
    };
  }, [boardId, offset, placementPageSize, workspaceKey]);

  useEffect(() => {
    const sequence = ++sourceSequence.current;
    setSources({ key: sourceKey, status: "loading", data: null, error: null });
    void listOpenViewDataSources({ limit: PAGE_SIZE, offset: sourceOffset })
      .then((data) => {
        if (sequence !== sourceSequence.current) return;
        if (
          data.pagination.offset !== sourceOffset ||
          data.pagination.count !== data.items.length
        )
          throw new ApiContractError();
        setSources({ key: sourceKey, status: "ready", data, error: null });
      })
      .catch((error: unknown) => {
        if (sequence !== sourceSequence.current) return;
        setSources({
          key: sourceKey,
          status: "error",
          data: null,
          error:
            error instanceof ApiError && error.status < 500
              ? "Record sources are unavailable with your current access."
              : "Could not load record sources. Try again.",
        });
        if (choiceQueryRevokedBoardAccess(error)) {
          setPickerOpen(false);
          const deniedSequence = ++workspaceSequence.current;
          setWorkspace({
            key: workspaceKey,
            sequence: deniedSequence,
            status: "error",
            page: null,
            access: null,
            error: "Board shortcuts are unavailable with your current access.",
          });
          onAccessDeniedRef.current();
        }
      });
    return () => {
      sourceSequence.current += 1;
    };
  }, [sourceKey, sourceOffset, workspaceKey]);

  useEffect(() => {
    if (
      !selectedModuleId ||
      query.boardId !== boardId ||
      query.moduleId !== selectedModuleId
    ) {
      setRecords(null);
      return;
    }
    const sequence = ++recordSequence.current;
    setRecords({ key: recordKey, status: "loading", data: null, error: null });
    void loadPlacementRecordChoices(
      selectedModuleId,
      query.search,
      query.offset,
    )
      .then((data) => {
        if (sequence !== recordSequence.current) return;
        setRecords({ key: recordKey, status: "ready", data, error: null });
      })
      .catch((error: unknown) => {
        if (sequence !== recordSequence.current) return;
        setRecords({
          key: recordKey,
          status: "error",
          data: null,
          error:
            error instanceof ApiError && error.status < 500
              ? "Records are unavailable with your current access."
              : "Could not load records. Try again.",
        });
        if (choiceQueryRevokedBoardAccess(error)) {
          setPickerOpen(false);
          const deniedSequence = ++workspaceSequence.current;
          setWorkspace({
            key: workspaceKey,
            sequence: deniedSequence,
            status: "error",
            page: null,
            access: null,
            error: "Board shortcuts are unavailable with your current access.",
          });
          onAccessDeniedRef.current();
        }
      });
    return () => {
      recordSequence.current += 1;
    };
  }, [boardId, query, recordKey, selectedModuleId, workspaceKey]);

  const page = currentWorkspace.page;
  const canEdit = boardActive && currentWorkspace.access?.edit === true;
  const sourcePage =
    sources?.key === sourceKey && sources.status === "ready"
      ? sources.data
      : null;
  const recordPage =
    records?.key === recordKey && records.status === "ready"
      ? records.data
      : null;
  const selectedRecord = recordPage?.choices.find(
    (choice) => choice.id === selectedRecordId,
  );
  const alreadyLinked =
    page?.items.some((placement) => placement.recordId === selectedRecordId) ??
    false;

  async function mutate(
    action: () => Promise<unknown>,
    onSuccess?: () => void,
  ): Promise<void> {
    if (!page || !canEdit || pending || conflict) return;
    const actionBoardId = boardId;
    setPending(true);
    setMutationError(null);
    try {
      await action();
      if (currentBoard.current !== actionBoardId) return;
      setSelection((value) => ({ ...value, recordId: "" }));
      setRefresh((value) => value + 1);
      onSuccess?.();
    } catch (error) {
      if (currentBoard.current !== actionBoardId) return;
      const result = failure(error);
      setMutationError(result.message);
      if (error instanceof ApiError && error.status === 409) setConflict(true);
      if (result.denied) {
        setPickerOpen(false);
        const sequence = ++workspaceSequence.current;
        setWorkspace((state) =>
          transitionPlacementWorkspace(state, {
            type: "begin",
            key: workspaceKey,
            sequence,
          }),
        );
        setWorkspace((state) =>
          transitionPlacementWorkspace(state, {
            type: "reject",
            key: workspaceKey,
            sequence,
            error: result.message,
            retain: false,
          }),
        );
        onAccessDeniedRef.current();
      }
    } finally {
      if (currentBoard.current === actionBoardId) setPending(false);
    }
  }

  return (
    <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
      <div className="flex min-w-0 flex-col gap-5">
        <p className="text-muted-foreground text-sm">
          Shortcuts do not grant access to a record. OpenView checks record
          access separately.
        </p>
        {currentWorkspace.error && (
          <Alert variant="destructive">
            <span>{currentWorkspace.error}</span>
            <Button
              type="button"
              variant="outline"
              className="ml-2 min-h-11"
              disabled={pending}
              onClick={() => setRefresh((value) => value + 1)}
            >
              Retry
            </Button>
          </Alert>
        )}
        {mutationError && !pickerOpen && (
          <Alert variant="destructive">
            <span>{mutationError}</span>
            {conflict && (
              <span>
                {" "}
                Refresh latest Board shortcuts before choosing whether to retry.
              </span>
            )}
            <Button
              type="button"
              variant="outline"
              className="ml-2 min-h-11"
              disabled={pending}
              onClick={() => setRefresh((value) => value + 1)}
            >
              Retry
            </Button>
          </Alert>
        )}
        {!page && currentWorkspace.status !== "error" && (
          <p role="status" className="text-muted-foreground py-8 text-sm">
            Loading linked records…
          </p>
        )}
        {!page && currentWorkspace.status === "error" && (
          <BoardEmpty
            title="Linked records unavailable"
            description="No shortcuts are shown. Retry or ask a Board manager to check your access."
          />
        )}
        {page && (
          <>
            <ServerBoardPlacementsDisplay
              page={page}
              canEdit={canEdit && !conflict}
              pending={pending}
              sources={sourcePage?.items}
              onAddShortcut={() => setPickerOpen(true)}
              onRemove={(placementId) =>
                void mutate(() =>
                  deleteBoardPlacement(
                    boardId,
                    placementId,
                    page.boardRevision,
                  ),
                )
              }
            />
            <div className="bg-card flex min-w-0 flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-muted-foreground text-sm" role="status">
                {page.pagination.total === 0
                  ? "No linked records"
                  : page.pagination.count > 0
                    ? `Showing ${page.pagination.offset + 1}–${page.pagination.offset + page.pagination.count} of ${page.pagination.total}`
                    : `No shortcuts on this page · ${page.pagination.total} total`}
              </p>
              <div className="flex flex-wrap items-center gap-3 sm:justify-end">
                <div className="flex items-center gap-2">
                  <label
                    htmlFor={`board-placement-page-size-${pageSizeControlId}`}
                    className="text-muted-foreground text-sm"
                  >
                    Rows per page
                  </label>
                  <NativeSelect
                    id={`board-placement-page-size-${pageSizeControlId}`}
                    aria-label="Rows per page"
                    className="w-20 [&_select]:min-h-11"
                    value={String(placementPageSize)}
                    disabled={pending || currentWorkspace.status === "loading"}
                    onChange={(event) => {
                      const nextPageSize = PLACEMENT_PAGE_SIZE_OPTIONS.find(
                        (option) =>
                          String(option) === event.currentTarget.value,
                      );
                      if (nextPageSize === undefined) return;
                      setPlacementPageSize(nextPageSize);
                      setPlacementPaging({ boardId, offset: 0 });
                    }}
                  >
                    {PLACEMENT_PAGE_SIZE_OPTIONS.map((option) => (
                      <NativeSelectOption key={option} value={String(option)}>
                        {option}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
                {pending || currentWorkspace.status === "loading" ? (
                  <span className="text-muted-foreground text-sm">
                    Loading pages…
                  </span>
                ) : (
                  <PaginationControls
                    ariaLabel="Linked record pages"
                    className="w-auto"
                    pageCount={Math.max(
                      1,
                      Math.ceil(page.pagination.total / placementPageSize),
                    )}
                    pageIndex={Math.floor(
                      page.pagination.offset / placementPageSize,
                    )}
                    onPageIndexChange={(nextPageIndex) =>
                      setPlacementPaging({
                        boardId,
                        offset: nextPageIndex * placementPageSize,
                      })
                    }
                  />
                )}
              </div>
            </div>
            {canEdit && pickerOpen && (
              <DialogContent className="max-w-xl">
                <DialogHeader>
                  <DialogTitle>Add record shortcut</DialogTitle>
                  <DialogDescription>
                    Choose a source and record you can already open. This does
                    not change record access or copy record data to the Board.
                  </DialogDescription>
                </DialogHeader>
                {mutationError && (
                  <Alert variant="destructive">
                    <span>
                      {mutationError}
                      {conflict
                        ? " Refresh the latest shortcuts before choosing whether to retry."
                        : ""}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      className="ml-2 min-h-11"
                      disabled={pending}
                      onClick={() => setRefresh((value) => value + 1)}
                    >
                      {conflict ? "Refresh latest shortcuts" : "Retry"}
                    </Button>
                  </Alert>
                )}
                <div className="mt-4 flex flex-col gap-3">
                  <label
                    htmlFor="board-placement-source"
                    className="text-sm font-medium"
                  >
                    Record source
                  </label>
                  <select
                    id="board-placement-source"
                    className="border-input bg-background min-h-11 rounded-md border px-3"
                    value={selectedModuleId}
                    disabled={!sourcePage || pending || conflict}
                    onChange={(event) => {
                      const moduleId = event.target.value;
                      setSelection({ boardId, moduleId, recordId: "" });
                      setQuery({ boardId, moduleId, search: "", offset: 0 });
                      setSearchDraft("");
                    }}
                  >
                    <option value="">Choose a source</option>
                    {sourcePage?.items.map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.name}
                      </option>
                    ))}
                  </select>
                  {sources?.key === sourceKey && sources.error && (
                    <Alert variant="destructive">
                      <span>{sources.error}</span>
                      <Button
                        type="button"
                        variant="outline"
                        className="ml-2 min-h-11"
                        disabled={pending}
                        onClick={() => setRefresh((value) => value + 1)}
                      >
                        Retry sources
                      </Button>
                    </Alert>
                  )}
                  {sourcePage &&
                    (sourcePage.pagination.hasMore || sourceOffset > 0) && (
                      <nav
                        aria-label="Record source pages"
                        className="flex items-center gap-2"
                      >
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11"
                          disabled={sourceOffset === 0 || pending}
                          onClick={() => {
                            setSelection({
                              boardId,
                              moduleId: "",
                              recordId: "",
                            });
                            setQuery({
                              boardId,
                              moduleId: "",
                              search: "",
                              offset: 0,
                            });
                            setSourcePaging({
                              boardId,
                              offset: Math.max(0, sourceOffset - PAGE_SIZE),
                            });
                          }}
                        >
                          Previous sources
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11"
                          disabled={!sourcePage.pagination.hasMore || pending}
                          onClick={() => {
                            setSelection({
                              boardId,
                              moduleId: "",
                              recordId: "",
                            });
                            setQuery({
                              boardId,
                              moduleId: "",
                              search: "",
                              offset: 0,
                            });
                            setSourcePaging({
                              boardId,
                              offset: sourceOffset + PAGE_SIZE,
                            });
                          }}
                        >
                          Next sources
                        </Button>
                      </nav>
                    )}
                  {selectedModuleId && (
                    <>
                      <form
                        className="flex flex-wrap items-end gap-2"
                        onSubmit={(event) => {
                          event.preventDefault();
                          setSelection((value) => ({ ...value, recordId: "" }));
                          setQuery({
                            boardId,
                            moduleId: selectedModuleId,
                            search: searchDraft,
                            offset: 0,
                          });
                        }}
                      >
                        <label
                          htmlFor="board-placement-search"
                          className="flex min-w-48 flex-1 flex-col gap-1 text-sm font-medium"
                        >
                          Find a record
                          <Input
                            id="board-placement-search"
                            value={searchDraft}
                            maxLength={240}
                            disabled={pending || conflict}
                            onChange={(event) =>
                              setSearchDraft(event.target.value)
                            }
                          />
                        </label>
                        <Button
                          type="submit"
                          variant="outline"
                          className="min-h-11"
                          disabled={pending || conflict}
                        >
                          Search
                        </Button>
                      </form>
                      <label
                        htmlFor="board-placement-record"
                        className="text-sm font-medium"
                      >
                        Record
                      </label>
                      <select
                        id="board-placement-record"
                        className="border-input bg-background min-h-11 rounded-md border px-3"
                        value={selectedRecord?.id ?? ""}
                        disabled={!recordPage || pending || conflict}
                        onChange={(event) =>
                          setSelection((value) => ({
                            ...value,
                            recordId: event.target.value,
                          }))
                        }
                      >
                        <option value="">Choose a record</option>
                        {recordPage?.choices.map((choice) => (
                          <option key={choice.id} value={choice.id}>
                            {choice.label}
                          </option>
                        ))}
                      </select>
                      {records?.key === recordKey && records.error && (
                        <Alert variant="destructive">
                          <span>{records.error}</span>
                          <Button
                            type="button"
                            variant="outline"
                            className="ml-2 min-h-11"
                            disabled={pending}
                            onClick={() => setRefresh((value) => value + 1)}
                          >
                            Retry records
                          </Button>
                        </Alert>
                      )}
                      {recordPage &&
                        (recordPage.hasMore || query.offset > 0) && (
                          <nav
                            aria-label="Record candidate pages"
                            className="flex items-center gap-2"
                          >
                            <Button
                              type="button"
                              variant="outline"
                              className="min-h-11"
                              disabled={query.offset === 0 || pending}
                              onClick={() => {
                                setSelection((value) => ({
                                  ...value,
                                  recordId: "",
                                }));
                                setQuery((value) => ({
                                  ...value,
                                  offset: Math.max(0, value.offset - PAGE_SIZE),
                                }));
                              }}
                            >
                              Previous records
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              className="min-h-11"
                              disabled={!recordPage.hasMore || pending}
                              onClick={() => {
                                setSelection((value) => ({
                                  ...value,
                                  recordId: "",
                                }));
                                setQuery((value) => ({
                                  ...value,
                                  offset: value.offset + PAGE_SIZE,
                                }));
                              }}
                            >
                              Next records
                            </Button>
                          </nav>
                        )}
                      {recordPage && recordPage.choices.length === 0 && (
                        <p
                          role="status"
                          className="text-muted-foreground text-sm"
                        >
                          No records match this search.
                        </p>
                      )}
                      {alreadyLinked && (
                        <p
                          role="status"
                          className="text-muted-foreground text-sm"
                        >
                          This record is already linked on this page.
                        </p>
                      )}
                      <Button
                        type="button"
                        className="min-h-11 self-start"
                        disabled={
                          !selectedRecord ||
                          alreadyLinked ||
                          pending ||
                          conflict
                        }
                        onClick={() => {
                          if (selectedRecord)
                            void mutate(
                              () =>
                                createBoardPlacement(
                                  boardId,
                                  page.boardRevision,
                                  selectedRecord.id,
                                ),
                              () => setPickerOpen(false),
                            );
                        }}
                      >
                        Add shortcut
                      </Button>
                    </>
                  )}
                </div>
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={pending}
                    onClick={() => setPickerOpen(false)}
                  >
                    Cancel
                  </Button>
                </DialogFooter>
              </DialogContent>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
