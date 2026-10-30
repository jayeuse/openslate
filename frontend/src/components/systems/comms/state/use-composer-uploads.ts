"use client";
import { useEffect, useRef, useState } from "react";
import type { CommsSettings } from "../domain/configuration";
import type { LocalAttachment } from "../domain/view-model";
import { attachmentTypes, composerFailure } from "../domain/composer-input";
import { useCommsCommands } from "./runtime";
import { useCommsClient } from "./client-context";
import { cacheLocalAttachment } from "../../shared/runtime/local-attachments";
import {
  FILES_BUSY_MESSAGE,
  isFilesBusy,
} from "../../shared/adapters/files-api";

export function useComposerUploads(
  conversationId: string,
  settings: CommsSettings,
  onReady: (file: LocalAttachment) => void,
) {
  const { client } = useCommsClient();
  const { run } = useCommsCommands();
  const flights = useRef(new Map<string, AbortController>());
  const [items, setItems] = useState<
    {
      id: string;
      file: File;
      progress: number;
      error: string;
      active: boolean;
      /** The upload waits for file capacity on the server. */
      waiting?: boolean;
      reservation?: string;
    }[]
  >([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const owned = flights.current;
    setItems([]);
    setError("");
    return () => {
      for (const controller of owned.values()) controller.abort();
      owned.clear();
    };
  }, [client, conversationId]);
  const allowed = attachmentTypes.filter(
    (type) =>
      !settings.allowedFileTypes.length ||
      settings.allowedFileTypes.includes(
        type as CommsSettings["allowedFileTypes"][number],
      ),
  );
  const update = (id: string, patch: Partial<(typeof items)[number]>) =>
    setItems((rows) =>
      rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  async function upload(item: (typeof items)[number]) {
    if (!client || flights.current.has(item.id)) return;
    const controller = new AbortController();
    flights.current.set(item.id, controller);
    update(item.id, { active: true, error: "", progress: 0, waiting: false });
    try {
      const result = await run(
        `upload:${conversationId}:${item.id}`,
        async (current, lifetime) => {
          const signal = AbortSignal.any([lifetime, controller.signal]);
          const reservation =
            item.reservation ??
            (
              await current.reserveAttachment(
                conversationId,
                { filename: item.file.name, expected_size: item.file.size },
                { signal },
              )
            ).id;
          if (signal.aborted) throw new Error("Upload cancelled");
          update(item.id, { reservation });
          return current.uploadAttachment(
            conversationId,
            reservation,
            item.file,
            {
              signal,
              on_waiting: (waiting) => {
                if (!signal.aborted) update(item.id, { waiting });
              },
              on_progress: ({ loaded_bytes, total_bytes }) => {
                if (!signal.aborted)
                  update(item.id, {
                    progress: Math.min(
                      100,
                      Math.round(
                        (100 * loaded_bytes) / Math.max(1, total_bytes),
                      ),
                    ),
                  });
              },
            },
          );
        },
      );
      if (controller.signal.aborted) return;
      cacheLocalAttachment(result.id, item.file);
      onReady({
        id: result.id,
        name: item.file.name,
        size: item.file.size,
        type: result.media_type ?? item.file.type,
      });
      setItems((rows) => rows.filter((row) => row.id !== item.id));
    } catch (error) {
      if (controller.signal.aborted) return;
      const failure = composerFailure(error);
      const detail = failure?.body.detail;
      const code =
        detail && typeof detail === "object" && "code" in detail
          ? detail.code
          : "";
      update(item.id, {
        active: false,
        waiting: false,
        error: isFilesBusy(error)
          ? FILES_BUSY_MESSAGE
          : code === "file_uploads_full"
            ? "Too many files are waiting; try again shortly"
            : code === "file_quota_busy"
              ? "File storage is busy."
              : "The file could not be attached. Your draft is still available.",
      });
    } finally {
      flights.current.delete(item.id);
    }
  }
  function add(files: File[], existingCount: number) {
    if (existingCount + items.length + files.length > 10) {
      setError("Attach at most 10 files.");
      return;
    }
    const maximum = Math.min(10, settings.maxFileSizeMb || 10) * 1024 * 1024;
    for (const file of files) {
      if (!allowed.includes(file.name.split(".").at(-1)?.toLowerCase() ?? "")) {
        setError("This file type is not allowed.");
        return;
      }
      if (!file.size || file.size > maximum) {
        setError(`Choose a non-empty file up to ${maximum / 1024 / 1024} MiB.`);
        return;
      }
    }
    setError("");
    const rows = files.map((file) => ({
      id: crypto.randomUUID(),
      file,
      progress: 0,
      error: "",
      active: true,
    }));
    setItems((current) => [...current, ...rows]);
    for (const row of rows) void upload(row);
  }
  return {
    items,
    error,
    accept: allowed.map((type) => `.${type}`).join(","),
    add,
    retry: upload,
    remove: (id: string) => {
      flights.current.get(id)?.abort();
      flights.current.delete(id);
      setItems((rows) => rows.filter((row) => row.id !== id));
    },
  };
}
