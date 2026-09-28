"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { subscribeOpenViewInvalidations } from "@/components/systems/openview/adapters/invalidation-events";
import { invalidatesRecords } from "@/components/systems/openview/adapters/openview-queries";
import {
  listOpenViewDataSourceFields,
  listOpenViewDataSources,
  queryOpenViewRecords,
  type OpenViewDataSource,
  type OpenViewDataSourceField,
  type OpenViewRecord,
} from "@/components/systems/openview/adapters/views-api";
import type { BoardAttachmentVersions } from "../adapters/board-files-api";
import {
  addBoardRecordLink,
  listBoardRecordLinks,
  removeBoardRecordLink,
  type BoardRecordLink,
  type BoardEditableRecordLinkTarget,
  type BoardRecordLinkTarget,
} from "../adapters/board-record-links-api";

type Props =
  | { access: "read"; target: BoardRecordLinkTarget }
  | {
      access: "edit";
      target: BoardEditableRecordLinkTarget;
      versions: BoardAttachmentVersions;
      refreshVersions: () => Promise<BoardAttachmentVersions>;
      onBusyChange?: (busy: boolean) => void;
      locked?: boolean;
    };

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409)
      return "This content changed. Reload the editor and try again.";
    if ([401, 403, 404].includes(error.status))
      return "This Board, content or Record is no longer available to you.";
  }
  return "Record links could not be updated. Try again.";
}

export function recordTitleForLink(
  record: OpenViewRecord,
  titleField: Pick<OpenViewDataSourceField, "id" | "type"> | null,
): string {
  const fallback = `Record ${record.id.slice(0, 8)}`;
  if (!titleField) return fallback;
  const displayValue = record.displayValues[titleField.id];
  if (typeof displayValue === "string" && displayValue.trim())
    return displayValue.slice(0, 100);
  if (titleField.type === "select" || titleField.type === "user")
    return fallback;
  const value = record.data[titleField.id];
  if (typeof value === "string" && value.trim()) return value.slice(0, 100);
  if (typeof value === "number" && Number.isFinite(value))
    return String(value).slice(0, 100);
  return fallback;
}

export function ServerBoardRecordLinks(props: Props) {
  const editable = props.access === "edit" ? props : null;
  const kind = props.target.kind;
  const boardId = props.target.boardId;
  const contentId = props.target.contentId;
  const view = props.target.kind === "post" ? props.target.view : null;
  const target = useMemo<BoardRecordLinkTarget>(
    () =>
      kind === "event"
        ? { kind, boardId, contentId }
        : { kind, boardId, contentId, view: view ?? "published" },
    [kind, boardId, contentId, view],
  );
  const [items, setItems] = useState<BoardRecordLink[]>([]);
  const itemsRef = useRef<BoardRecordLink[] | null>(null);
  const [listStatus, setListStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [listReload, setListReload] = useState(0);
  const [sources, setSources] = useState<OpenViewDataSource[]>([]);
  const [sourceOffset, setSourceOffset] = useState(0);
  const [sourceHasMore, setSourceHasMore] = useState(false);
  const [sourceError, setSourceError] = useState(false);
  const [moduleId, setModuleId] = useState("");
  const [titleField, setTitleField] = useState<OpenViewDataSourceField | null>(
    null,
  );
  const [records, setRecords] = useState<OpenViewRecord[]>([]);
  const [recordOffset, setRecordOffset] = useState(0);
  const [recordHasMore, setRecordHasMore] = useState(false);
  const [recordStatus, setRecordStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [search, setSearch] = useState("");
  const [recordId, setRecordId] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const versionsRef = useRef<BoardAttachmentVersions | null>(
    editable?.versions ?? null,
  );
  const busyChange = editable?.onBusyChange;
  const busyChangeRef = useRef(busyChange);
  const boardRevision = editable?.versions.boardRevision ?? null;
  const contentRevision = editable?.versions.contentRevision ?? null;

  useEffect(() => {
    busyChangeRef.current = busyChange;
  }, [busyChange]);
  useEffect(() => {
    const refresh = () => setListReload((value) => value + 1);
    return subscribeOpenViewInvalidations((event) => {
      if (event.type === "resync") {
        refresh();
        return;
      }
      if (!invalidatesRecords(event.entity)) return;
      if (
        event.moduleId === undefined ||
        itemsRef.current === null ||
        itemsRef.current.some((item) => item.moduleId === event.moduleId)
      )
        refresh();
    }, refresh);
  }, [target]);
  useEffect(() => {
    if (boardRevision !== null && contentRevision !== null)
      versionsRef.current = { boardRevision, contentRevision };
  }, [boardRevision, contentRevision]);
  useEffect(() => {
    busyChangeRef.current?.(pending);
    return () => busyChangeRef.current?.(false);
  }, [pending]);
  useEffect(() => {
    let active = true;
    itemsRef.current = null;
    setListStatus("loading");
    void listBoardRecordLinks(target).then(
      (page) => {
        if (!active) return;
        itemsRef.current = page.items;
        setItems(page.items);
        setListStatus("ready");
      },
      () => {
        if (!active) return;
        itemsRef.current = [];
        setItems([]);
        setListStatus("error");
      },
    );
    return () => {
      active = false;
    };
  }, [target, listReload]);
  useEffect(() => {
    if (props.access !== "edit") return;
    let active = true;
    void listOpenViewDataSources({ limit: 25, offset: sourceOffset }).then(
      (page) => {
        if (!active) return;
        setSources(page.items);
        setSourceHasMore(page.pagination.hasMore);
        setSourceError(false);
      },
      () => {
        if (active) setSourceError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [props.access, sourceOffset]);
  useEffect(() => {
    if (props.access !== "edit" || !moduleId) return;
    let active = true;
    setRecordStatus("loading");
    void (async () => {
      const selectedSource = sources.find((source) => source.id === moduleId);
      const selectedTitleFieldId = selectedSource?.titleFieldId ?? null;
      const collectedFields: OpenViewDataSourceField[] = [];
      let titleFieldFound = selectedTitleFieldId === null;
      let nextOffset = 0;
      for (let pageNumber = 0; pageNumber < 50; pageNumber += 1) {
        const page = await listOpenViewDataSourceFields(moduleId, {
          limit: 100,
          offset: nextOffset,
        });
        collectedFields.push(...page.items);
        if (
          selectedTitleFieldId !== null &&
          page.items.some((field) => field.id === selectedTitleFieldId)
        ) {
          titleFieldFound = true;
        }
        if (!page.pagination.hasMore || titleFieldFound) break;
        if (page.items.length === 0)
          throw new Error("Data source fields could not be loaded.");
        nextOffset += page.items.length;
      }
      if (!titleFieldFound)
        throw new Error("The selected Record title field is unavailable.");
      const nextTitleField = selectedTitleFieldId
        ? (collectedFields.find((field) => field.id === selectedTitleFieldId) ??
          null)
        : null;
      const queryFields = collectedFields.slice(0, 100);
      const searchable = queryFields
        .filter((field) =>
          ["text", "long_text", "email", "url", "select"].includes(field.type),
        )
        .map((field) => ({ fieldId: field.id, expectedType: field.type }));
      const columns = queryFields
        .slice(
          0,
          nextTitleField &&
            !queryFields.some((field) => field.id === nextTitleField.id)
            ? 99
            : 100,
        )
        .map((field) => ({ fieldId: field.id, expectedType: field.type }));
      if (
        nextTitleField &&
        !columns.some((column) => column.fieldId === nextTitleField.id)
      )
        columns.push({
          fieldId: nextTitleField.id,
          expectedType: nextTitleField.type,
        });
      const page = await queryOpenViewRecords({
        moduleId,
        definition: {
          version: 1,
          logic: "and",
          columns,
          filters: [],
          sort: [],
          deleted: "exclude",
          search: searchable.length > 0 ? search.trim() || null : null,
          searchFields: searchable,
        },
        limit: 25,
        offset: recordOffset,
      });
      if (!active) return;
      setTitleField(nextTitleField);
      setRecords(page.items);
      setRecordHasMore(page.pagination.hasMore);
      setRecordStatus("ready");
    })().catch(() => {
      if (!active) return;
      setTitleField(null);
      setRecords([]);
      setRecordStatus("error");
    });
    return () => {
      active = false;
    };
  }, [props.access, moduleId, recordOffset, search, sources]);

  async function mutate(action: "add" | "remove", linkId?: string) {
    if (!editable || editable.locked || pending) return;
    if (action === "add" && !recordId) return;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const versions = versionsRef.current ?? editable.versions;
      if (action === "add")
        await addBoardRecordLink(editable.target, recordId, versions);
      else if (linkId)
        await removeBoardRecordLink(editable.target, linkId, versions);
      versionsRef.current = await editable.refreshVersions();
      setRecordId("");
      setListReload((value) => value + 1);
      setNotice(action === "add" ? "Record linked." : "Record link removed.");
    } catch (operationError) {
      setError(errorText(operationError));
    } finally {
      setPending(false);
    }
  }

  const selectedRecord = records.find((record) => record.id === recordId);
  return (
    <section aria-label="Record links" className="space-y-3">
      <h4 className="text-sm font-semibold">Record links</h4>
      {listStatus === "loading" && <p role="status">Loading linked Records…</p>}
      {listStatus === "error" && (
        <Alert variant="warning">
          Record links could not be loaded.{" "}
          <Button
            type="button"
            variant="outline"
            onClick={() => setListReload((value) => value + 1)}
          >
            Retry
          </Button>
        </Alert>
      )}
      {listStatus === "ready" &&
        (items.length === 0 ? (
          <p className="text-muted-foreground text-sm">No linked Records.</p>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 text-sm"
              >
                {item.available && item.url ? (
                  <a
                    href={item.url}
                    className="text-primary underline underline-offset-2"
                  >
                    {item.label}
                  </a>
                ) : (
                  <span>{item.label} · Record unavailable</span>
                )}
                {editable && (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    disabled={pending || editable.locked}
                    onClick={() => void mutate("remove", item.id)}
                    aria-label={`Remove ${item.label} record link`}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ))}
      {editable && !editable.locked && items.length < 20 && (
        <div className="space-y-3 rounded-md border p-3">
          <p className="text-sm font-medium">Link an existing Record</p>
          <label className="block space-y-1 text-sm">
            <span>Data source</span>
            <select
              data-slot="select"
              aria-label="Record data source"
              className="border-input bg-background min-h-11 w-full rounded-md border px-3"
              value={moduleId}
              onChange={(event) => {
                setModuleId(event.currentTarget.value);
                setRecordId("");
                setRecordOffset(0);
                setTitleField(null);
              }}
            >
              <option value="">Choose a data source</option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
          </label>
          {sourceError && <p role="alert">Data sources could not be loaded.</p>}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={sourceOffset === 0}
              onClick={() => setSourceOffset(Math.max(0, sourceOffset - 25))}
            >
              Previous sources
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!sourceHasMore}
              onClick={() => setSourceOffset(sourceOffset + 25)}
            >
              Next sources
            </Button>
          </div>
          {moduleId && (
            <>
              <label className="block space-y-1 text-sm">
                <span>Search Records</span>
                <Input
                  className="bg-background text-foreground min-h-11 rounded-md"
                  maxLength={240}
                  value={search}
                  onChange={(event) => {
                    setSearch(event.currentTarget.value);
                    setRecordOffset(0);
                    setRecordId("");
                  }}
                />
              </label>
              {recordStatus === "loading" && (
                <p role="status">Loading Records…</p>
              )}
              {recordStatus === "error" && (
                <p role="alert">Records could not be loaded.</p>
              )}
              {recordStatus === "ready" && (
                <>
                  <label className="block space-y-1 text-sm">
                    <span>Record</span>
                    <select
                      data-slot="select"
                      aria-label="Record to link"
                      className="border-input bg-background min-h-11 w-full rounded-md border px-3"
                      value={recordId}
                      onChange={(event) => {
                        const id = event.currentTarget.value;
                        setRecordId(id);
                      }}
                    >
                      <option value="">Choose a Record</option>
                      {records.map((record) => (
                        <option key={record.id} value={record.id}>
                          {recordTitleForLink(record, titleField)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {records.length === 0 && (
                    <p className="text-muted-foreground text-sm">
                      No Records match on this page.
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={recordOffset === 0}
                      onClick={() =>
                        setRecordOffset(Math.max(0, recordOffset - 25))
                      }
                    >
                      Previous Records
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!recordHasMore}
                      onClick={() => setRecordOffset(recordOffset + 25)}
                    >
                      Next Records
                    </Button>
                  </div>
                </>
              )}
            </>
          )}
          <Button
            type="button"
            className="min-h-11"
            disabled={!selectedRecord || pending}
            onClick={() => void mutate("add")}
          >
            Link Record
          </Button>
        </div>
      )}
      {error && <Alert variant="destructive">{error}</Alert>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
