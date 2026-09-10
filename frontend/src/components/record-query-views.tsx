"use client";
import { useEffect, useRef, useState } from "react";
import { apiFetch, listQuery, type ListResponse } from "@/lib/api";
import {
  type QueryDefinition,
  type SavedView,
  exportRecords,
} from "@/lib/record-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Alert } from "@/components/ui/alert";
import { ConfirmationDialog } from "@/components/confirmation-dialog";
export function RecordQueryViews({
  moduleId,
  definition,
  onLoad,
  isAdmin,
  userId,
  refreshGeneration,
}: {
  moduleId: string;
  definition: QueryDefinition;
  onLoad: (d: QueryDefinition) => void;
  isAdmin: boolean;
  userId: string;
  refreshGeneration: number;
}) {
  const [views, setViews] = useState<SavedView[]>([]);
  const [selected, setSelected] = useState("");
  const selectionRef = useRef("");
  const [baseRevision, setBaseRevision] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const requestGeneration = useRef(0);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [archive, setArchive] = useState(false);
  const current = views.find((v) => v.id === selected);
  const canEdit =
    current &&
    (current.visibility === "workspace"
      ? isAdmin
      : current.owner_id === userId);
  function select(id: string, revision: number | null) {
    selectionRef.current = id;
    setSelected(id);
    setBaseRevision(revision);
  }
  async function load(signal?: AbortSignal) {
    const generation = ++requestGeneration.current;
    const selectionAtStart = selectionRef.current;
    const active = () =>
      !signal?.aborted && generation === requestGeneration.current;
    const all: SavedView[] = [];
    let offset = 0;
    try {
      while (true) {
        const result = await apiFetch<ListResponse<SavedView>>(
          `/views?${listQuery({ module_id: moduleId, limit: 100, offset })}`,
          { signal },
        );
        if (!active()) return;
        all.push(...result.items);
        if (!result.pagination.has_more) break;
        offset += result.items.length;
      }
      setViews(all);
      // Only a completed refresh for the current selection can establish removal.
      if (
        selectionAtStart &&
        selectionAtStart === selectionRef.current &&
        !all.some((view) => view.id === selectionAtStart)
      ) {
        select("", null);
        setArchive(false);
        setNotice(
          "This saved view is no longer available. Your draft is retained.",
        );
      }
    } catch (reason) {
      if (active()) throw reason;
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch(() => {
      if (!controller.signal.aborted)
        setError("Saved views could not be loaded.");
    });
    return () => controller.abort();
  }, [moduleId, refreshGeneration]);
  async function run(action: () => Promise<void>) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "View action failed");
    } finally {
      setPending(false);
    }
  }
  async function save(visibility: "private" | "workspace", update = false) {
    await run(async () => {
      const saved = await apiFetch<SavedView>(
        update ? `/views/${selected}` : "/views",
        {
          method: update ? "PATCH" : "POST",
          body: JSON.stringify(
            update
              ? { revision: baseRevision, name, definition }
              : { module_id: moduleId, name, visibility, definition },
          ),
        },
      );
      // The mutation response is authoritative even if a refresh is superseded.
      requestGeneration.current += 1;
      setViews((previous) => [
        ...previous.filter((view) => view.id !== saved.id),
        saved,
      ]);
      select(saved.id, saved.revision);
      setNotice("");
      await load();
    });
  }
  return (
    <div className="mb-5 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Saved view"
          value={selected}
          onValueChange={(id) => {
            setNotice("");
            const view = views.find((v) => v.id === id);
            select(id, view?.revision ?? null);
            if (view) {
              onLoad(structuredClone(view.definition));
              setName(view.name);
            }
          }}
        >
          <option value="">Unsaved view</option>
          {views.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} · {v.visibility === "workspace" ? "Shared" : "Personal"}
            </option>
          ))}
        </Select>
        <Input
          aria-label="View name"
          placeholder="View name"
          value={name}
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
        />
        <Button
          disabled={pending || !name.trim()}
          variant="outline"
          onClick={() => void save("private")}
        >
          {current ? "Clone as personal view" : "Save personal view"}
        </Button>
        {canEdit && (
          <>
            <Button
              disabled={pending || !name.trim()}
              onClick={() => void save(current.visibility, true)}
            >
              Save changes
            </Button>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => setArchive(true)}
            >
              Archive view
            </Button>
          </>
        )}
        {isAdmin && (
          <>
            <Button
              variant="outline"
              disabled={pending || !name.trim()}
              onClick={() => void save("workspace")}
            >
              Publish shared copy
            </Button>
            <Button
              disabled={pending}
              variant="outline"
              onClick={() =>
                void run(async () => {
                  const blob = await exportRecords(moduleId, definition);
                  const url = URL.createObjectURL(blob);
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = "records.csv";
                  link.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                })
              }
            >
              Export CSV
            </Button>
          </>
        )}
      </div>
      {notice && <Alert variant="warning">{notice}</Alert>}
      {error && (
        <Alert variant="destructive">
          {error}
          <Button variant="ghost" onClick={() => void run(() => load())}>
            Reload views
          </Button>
        </Alert>
      )}
      <ConfirmationDialog
        open={archive}
        onOpenChange={setArchive}
        title="Archive this saved view?"
        description="This removes the definition from your available views. Records are retained."
        confirmLabel="Archive view"
        pending={pending}
        onConfirm={() =>
          run(async () => {
            await apiFetch(`/views/${selected}`, { method: "DELETE" });
            select("", null);
            await load();
            setArchive(false);
          })
        }
      />
    </div>
  );
}
