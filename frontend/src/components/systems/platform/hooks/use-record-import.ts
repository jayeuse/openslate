"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import { requestSessionRecheck } from "@/lib/auth-api";
import {
  importBatches,
  sendImportBatch,
  type CsvRow,
  type ImportEnvelope,
  type ImportResultRow,
} from "../adapters/record-import-api";
import {
  checkCsvFile,
  importMappingError,
  parseCsvText,
} from "../helpers/csv-import-rules";
import { importFailure } from "../helpers/record-import-failure";
import type { WorkspaceNavigationGuard } from "@/components/workspace-navigation-guard";

type CsvDraft = { name: string; headers: string[]; rows: CsvRow[] };
type Preview = { digest: string; rows: ImportResultRow[] };
type Configuration = Omit<ImportEnvelope, "mode" | "schema_digest" | "headers">;

function failureMessage(error: unknown, fallback: string): string {
  const failure = importFailure(error, fallback);
  if (failure.recheckSession) queueMicrotask(requestSessionRecheck);
  return failure.message;
}

export function useRecordImport() {
  const client = useQueryClient();
  const [csv, setCsv] = useState<CsvDraft | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [operation, setOperation] = useState<
    "file" | "preview" | "import" | null
  >(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [stopping, setStopping] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [confirmed, setConfirmed] = useState<Map<number, string>>(new Map());
  const [leave, setLeave] = useState<{ resume: () => void } | null>(null);
  const mounted = useRef(true);
  const generation = useRef(0);
  const current = useRef<typeof operation>(null);
  const stop = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const receipts = useRef(new Map<number, string>());
  const resumeAfterBatch = useRef<(() => void) | null>(null);

  useEffect(() => {
    mounted.current = true;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (current.current !== "import") return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      mounted.current = false;
      stop.current = true;
      generation.current += 1;
      controller.current?.abort();
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, []);

  function invalidatePreview() {
    setPreview(null);
    setError("");
    setNotice("");
  }
  function reset() {
    generation.current += 1;
    controller.current?.abort();
    setCsv(null);
    setPreview(null);
    setError("");
    setNotice("");
    setUncertain(false);
    receipts.current = new Map();
    setConfirmed(new Map());
  }
  async function readFile(file: File | undefined) {
    if (current.current === "import" || uncertain) return;
    reset();
    if (!file) return;
    const started = generation.current;
    current.current = "file";
    setOperation("file");
    try {
      checkCsvFile(file);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(
          await file.arrayBuffer(),
        );
      } catch {
        throw new Error("The CSV must use valid UTF-8 encoding.");
      }
      if (generation.current !== started || !mounted.current) return;
      const { headers, rows } = parseCsvText(text);
      setCsv({ name: file.name, headers, rows });
    } catch (error) {
      if (generation.current === started && mounted.current)
        setError(failureMessage(error, "The CSV could not be read."));
    } finally {
      if (generation.current === started && mounted.current) {
        current.current = null;
        setOperation(null);
      }
    }
  }
  async function previewImport(configuration: Configuration) {
    if (!csv || current.current || uncertain) return;
    const mappingError = importMappingError(configuration.mapping);
    if (mappingError) {
      setError(mappingError);
      return;
    }
    const started = generation.current;
    stop.current = false;
    setStopping(false);
    setPreview(null);
    setError("");
    setNotice("");
    current.current = "preview";
    setOperation("preview");
    const abort = new AbortController();
    controller.current = abort;
    try {
      const requests = importBatches(
        {
          ...configuration,
          headers: csv.headers,
          mode: "preview",
          schema_digest: null,
        },
        csv.rows.filter((row) => !receipts.current.has(row.row_number)),
      );
      const rows: ImportResultRow[] = [];
      let digest: string | null = null;
      for (const request of requests) {
        if (stop.current || !mounted.current || generation.current !== started)
          return;
        const result = await sendImportBatch(request, abort.signal);
        if (stop.current || !mounted.current || generation.current !== started)
          return;
        if (digest !== null && digest !== result.schema_digest)
          throw new Error(
            "Module schema changed during preview; preview again.",
          );
        digest = result.schema_digest;
        rows.push(...result.rows);
      }
      if (digest) setPreview({ digest, rows });
    } catch (error) {
      if (
        !abort.signal.aborted &&
        generation.current === started &&
        mounted.current
      )
        setError(
          failureMessage(
            error,
            "The preview could not be completed. Try again.",
          ),
        );
    } finally {
      if (generation.current === started && mounted.current) {
        current.current = null;
        controller.current = null;
        setOperation(null);
      }
    }
  }
  async function importRecords(configuration: Configuration) {
    if (!csv || !preview || current.current || uncertain) return;
    const eligible = new Set(
      preview.rows
        .filter(
          (row) =>
            row.status === "valid" && !receipts.current.has(row.row_number),
        )
        .map((row) => row.row_number),
    );
    if (!eligible.size) return;
    let requests;
    try {
      requests = importBatches(
        {
          ...configuration,
          headers: csv.headers,
          mode: "import",
          schema_digest: preview.digest,
        },
        csv.rows.filter((row) => eligible.has(row.row_number)),
      );
    } catch (error) {
      setError(failureMessage(error, "This batch is too large."));
      return;
    }
    current.current = "import";
    stop.current = false;
    setOperation("import");
    setStopping(false);
    setError("");
    setNotice("");
    try {
      for (const request of requests) {
        if (stop.current || !mounted.current) break;
        let result;
        try {
          // Do not abort an in-flight creation command. Cancel awaits its receipt.
          result = await sendImportBatch(request);
          const priorIds = new Set(receipts.current.values());
          if (
            result.rows.some(
              (row) => row.record_id && priorIds.has(row.record_id),
            )
          )
            throw new Error("Duplicate record receipt");
        } catch (error) {
          if (!mounted.current) break;
          const knownFailure =
            error instanceof ApiError &&
            [401, 403, 404, 409, 422].includes(error.status);
          if (knownFailure) {
            setError(failureMessage(error, "Import could not be completed."));
            setPreview(null);
          } else {
            resumeAfterBatch.current = null;
            setUncertain(true);
            setError(
              `Rows ${request.rows[0].row_number}–${request.rows.at(-1)!.row_number} are unconfirmed. ${receipts.current.size} records are confirmed. Check this module before starting another import; this batch will not be retried.`,
            );
          }
          stop.current = true;
          break;
        }
        for (const row of result.rows)
          if (row.record_id)
            receipts.current.set(row.row_number, row.record_id);
        if (mounted.current) {
          setConfirmed(new Map(receipts.current));
          setPreview((previous) =>
            previous
              ? {
                  ...previous,
                  rows: previous.rows.map(
                    (row) =>
                      result.rows.find(
                        (receipt) => receipt.row_number === row.row_number,
                      ) ?? row,
                  ),
                }
              : null,
          );
        }
        if (result.created_count) {
          void client.invalidateQueries({
            queryKey: ["openview"],
            refetchType: "none",
          });
          void client.invalidateQueries({
            queryKey: ["platform", "search"],
            refetchType: "none",
          });
        }
      }
      if (mounted.current)
        setNotice(
          `${receipts.current.size} records imported.${stop.current ? " Import stopped; confirmed records remain." : ""}`,
        );
    } finally {
      current.current = null;
      if (mounted.current) {
        setOperation(null);
        setStopping(false);
        setLeave(null);
        const resume = resumeAfterBatch.current;
        resumeAfterBatch.current = null;
        resume?.();
      }
    }
  }
  function cancel() {
    stop.current = true;
    if (current.current === "import") setStopping(true);
    else {
      controller.current?.abort();
      setPreview(null);
      setNotice("Import preview cancelled.");
    }
  }
  const guard = useCallback<WorkspaceNavigationGuard>((_href, resume) => {
    if (current.current !== "import") return true;
    setLeave({ resume });
    return false;
  }, []);
  function stopAndLeave() {
    if (!leave) return;
    resumeAfterBatch.current = leave.resume;
    cancel();
    if (current.current !== "import") {
      const resume = resumeAfterBatch.current;
      resumeAfterBatch.current = null;
      setLeave(null);
      resume?.();
    }
  }
  function stay() {
    resumeAfterBatch.current = null;
    setLeave(null);
  }
  return {
    csv,
    preview,
    operation,
    error,
    notice,
    stopping,
    uncertain,
    confirmed,
    leave,
    guard,
    readFile,
    reset,
    invalidatePreview,
    previewImport,
    importRecords,
    cancel,
    stay,
    stopAndLeave,
    setDraftError: (message: string) => setError(message),
    validRemaining:
      preview?.rows.filter(
        (row) => row.status === "valid" && !confirmed.has(row.row_number),
      ).length ?? 0,
  };
}
