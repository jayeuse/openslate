"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import {
  downloadBoardConfiguration,
  duplicateBoardStructure,
  importBoardConfiguration,
  readBoard,
  type BoardConfigurationDownload,
  type BoardManagementBoard,
} from "../adapters/board-management-api";
import {
  getMyBoardAccess,
  type BoardMyAccess,
} from "../adapters/board-tools-api";

const MAX_CONFIGURATION_BYTES = 1024 * 1024;
export type PortabilityAction = "export" | "import" | "duplicate";
export type PortabilityConfirmation = "import" | "duplicate" | null;
export type PortabilitySourceStatus =
  "idle" | "loading" | "ready" | "unavailable";

type SourceState = {
  key: string;
  status: PortabilitySourceStatus;
  source: BoardManagementBoard | null;
  canDuplicate: boolean;
};

function isAccessLoss(error: unknown): boolean {
  return error instanceof ApiError && [401, 403, 404].includes(error.status);
}

async function recheckBoardViewAfterActionDenial(
  boardId: string,
  error: unknown,
  onReadDenied?: (boardId: string) => void,
): Promise<void> {
  if (!isAccessLoss(error)) return;
  try {
    await readBoard(boardId);
  } catch (readError) {
    if (isAccessLoss(readError)) onReadDenied?.(boardId);
  }
}

async function readCurrentBoard(
  board: BoardManagementBoard,
  onReadDenied?: (boardId: string) => void,
): Promise<BoardManagementBoard> {
  let latest: BoardManagementBoard;
  try {
    latest = await readBoard(board.id);
  } catch (error) {
    if (isAccessLoss(error)) onReadDenied?.(board.id);
    throw error;
  }
  if (latest.id !== board.id || latest.revision !== board.revision)
    throw new ApiError(
      409,
      "Board changed. Refresh the Board before continuing.",
    );
  return latest;
}

export async function prepareBoardConfiguration(
  board: BoardManagementBoard,
  onReadDenied?: (boardId: string) => void,
): Promise<BoardConfigurationDownload> {
  await readCurrentBoard(board, onReadDenied);
  try {
    return await downloadBoardConfiguration(board.id);
  } catch (error) {
    await recheckBoardViewAfterActionDenial(board.id, error, onReadDenied);
    throw error;
  }
}

export async function duplicateCurrentBoardStructure(
  board: BoardManagementBoard,
  onReadDenied?: (boardId: string) => void,
): Promise<BoardManagementBoard> {
  await readCurrentBoard(board, onReadDenied);
  let access: BoardMyAccess;
  try {
    access = await getMyBoardAccess(board.id);
  } catch (error) {
    if (isAccessLoss(error)) onReadDenied?.(board.id);
    throw error;
  }
  if (!access.manage)
    throw new ApiError(403, "You cannot duplicate this Board.");
  try {
    return await duplicateBoardStructure(board.id);
  } catch (error) {
    await recheckBoardViewAfterActionDenial(board.id, error, onReadDenied);
    throw error;
  }
}

async function loadPortabilitySource(
  boardId: string,
  onReadDenied: (boardId: string) => void,
) {
  let source: BoardManagementBoard;
  try {
    source = await readBoard(boardId);
  } catch (error) {
    if (isAccessLoss(error)) onReadDenied(boardId);
    throw error;
  }
  let access: BoardMyAccess;
  try {
    access = await getMyBoardAccess(boardId);
  } catch (error) {
    if (isAccessLoss(error)) onReadDenied(boardId);
    throw error;
  }
  return { source, canDuplicate: access.manage };
}

function safeFailure(error: unknown, action: PortabilityAction): string {
  if (error instanceof ApiError) {
    if ([401, 403, 404].includes(error.status))
      return action === "import"
        ? "Import is unavailable with your current access."
        : "This Board action is unavailable with your current access.";
    if ([409, 413, 422].includes(error.status)) return error.message;
  }
  if (
    action === "import" &&
    error instanceof Error &&
    error.message.startsWith("Choose a valid Board configuration")
  )
    return error.message;
  return `Could not ${action === "export" ? "prepare the download" : action === "import" ? "import the configuration" : "duplicate the Board"}. Try again.`;
}

export function useServerBoardPortability({
  board,
  refreshKey,
  onBoardCreated,
  onAccessDenied,
}: {
  board: BoardManagementBoard | null;
  refreshKey: number;
  onBoardCreated: (board: BoardManagementBoard) => void;
  onAccessDenied: (boardId: string) => void;
}) {
  const key = board
    ? `${board.id}:${board.revision}:${refreshKey}`
    : "no-board";
  const boardId = board?.id ?? null;
  const [source, setSource] = useState<SourceState>({
    key: "",
    status: "idle",
    source: null,
    canDuplicate: false,
  });
  const [retry, setRetry] = useState(0);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [confirmation, setConfirmation] =
    useState<PortabilityConfirmation>(null);
  const [pending, setPending] = useState<PortabilityAction | null>(null);
  const [prepared, setPrepared] = useState<{
    key: string;
    url: string;
    filename: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sourceSequence = useRef(0);
  const action = useRef<{ kind: PortabilityAction; key: string } | null>(null);
  const mounted = useRef(true);
  const deniedCallback = useRef(onAccessDenied);

  useEffect(() => {
    deniedCallback.current = onAccessDenied;
  }, [onAccessDenied]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const sequence = ++sourceSequence.current;
    setPrepared(null);
    setConfirmation(null);
    setError(null);
    setNotice(null);
    if (!boardId) {
      setSource({ key, status: "idle", source: null, canDuplicate: false });
      return () => {
        sourceSequence.current += 1;
      };
    }
    setSource({ key, status: "loading", source: null, canDuplicate: false });
    void loadPortabilitySource(boardId, (deniedBoardId) => {
      if (sourceSequence.current === sequence)
        deniedCallback.current(deniedBoardId);
    })
      .then((result) => {
        if (sourceSequence.current !== sequence) return;
        setSource({ key, status: "ready", ...result });
      })
      .catch(() => {
        if (sourceSequence.current !== sequence) return;
        setSource({
          key,
          status: "unavailable",
          source: null,
          canDuplicate: false,
        });
      });
    return () => {
      sourceSequence.current += 1;
    };
  }, [boardId, key, retry]);

  useEffect(
    () => () => {
      if (prepared) URL.revokeObjectURL(prepared.url);
    },
    [prepared],
  );

  const visibleSource =
    source.key === key
      ? source
      : { key, status: "loading" as const, source: null, canDuplicate: false };
  const currentSource =
    board !== null &&
    visibleSource.status === "ready" &&
    visibleSource.source?.id === board.id &&
    visibleSource.source.revision === board.revision;

  function clearCurrentSource(sequence: number) {
    if (!mounted.current || sourceSequence.current !== sequence) return;
    setSource({
      key,
      status: "unavailable",
      source: null,
      canDuplicate: false,
    });
    setPrepared(null);
    setConfirmation(null);
  }

  function selectFile(file: File | null) {
    if (pending) return;
    setConfirmation(null);
    setError(null);
    setNotice(null);
    setSelectedFile(null);
    if (!file) return;
    if (file.size > MAX_CONFIGURATION_BYTES) {
      setError("Choose a Board configuration no larger than 1 MiB.");
      return;
    }
    setSelectedFile(file);
  }

  async function runExport() {
    if (!board || !currentSource || pending || action.current) return;
    const sequence = sourceSequence.current;
    const operation = { kind: "export" as const, key };
    action.current = operation;
    setPending("export");
    setPrepared(null);
    setError(null);
    setNotice(null);
    try {
      const result = await prepareBoardConfiguration(board, (boardId) => {
        if (sourceSequence.current === sequence) {
          clearCurrentSource(sequence);
          deniedCallback.current(boardId);
        }
      });
      if (!mounted.current || sourceSequence.current !== sequence) return;
      setPrepared({
        key,
        url: URL.createObjectURL(result.blob),
        filename: result.filename,
      });
      setNotice("Structure-only configuration is ready to download.");
    } catch (caught) {
      if (mounted.current && sourceSequence.current === sequence) {
        if (isAccessLoss(caught)) clearCurrentSource(sequence);
        setError(safeFailure(caught, "export"));
      }
    } finally {
      if (action.current === operation) {
        action.current = null;
        if (mounted.current) setPending(null);
      }
    }
  }

  async function confirmAction() {
    if (!confirmation || pending || action.current) return;
    const kind = confirmation;
    if (kind === "import" && !selectedFile) return;
    if (
      kind === "duplicate" &&
      (!board || !currentSource || !visibleSource.canDuplicate)
    )
      return;
    const sourceAtStart = sourceSequence.current;
    const operation = { kind, key };
    action.current = operation;
    setPending(kind);
    setConfirmation(null);
    setError(null);
    setNotice(null);
    try {
      let created: BoardManagementBoard;
      if (kind === "import") {
        if (!selectedFile) return;
        created = await importBoardConfiguration(selectedFile);
      } else {
        if (!board) return;
        created = await duplicateCurrentBoardStructure(board, (boardId) => {
          if (mounted.current && sourceSequence.current === sourceAtStart) {
            clearCurrentSource(sourceAtStart);
            deniedCallback.current(boardId);
          }
        });
      }
      if (!mounted.current) return;
      if (kind === "import") setSelectedFile(null);
      if (kind === "import" || sourceSequence.current === sourceAtStart)
        setNotice("Project Board created with no groups.");
      onBoardCreated(created);
    } catch (caught) {
      if (
        mounted.current &&
        (kind === "import" || sourceSequence.current === sourceAtStart)
      ) {
        if (kind === "duplicate" && isAccessLoss(caught))
          clearCurrentSource(sourceAtStart);
        setError(safeFailure(caught, kind));
      }
    } finally {
      if (action.current === operation) {
        action.current = null;
        if (mounted.current) setPending(null);
      }
    }
  }

  return {
    source: visibleSource.source,
    sourceStatus: visibleSource.status,
    canDuplicate: visibleSource.canDuplicate,
    selectedFileName: selectedFile?.name ?? null,
    preparedFilename: prepared?.key === key ? prepared.filename : null,
    preparedUrl: prepared?.key === key ? prepared.url : null,
    pending,
    confirmation,
    error,
    notice,
    selectFile,
    setConfirmation,
    runExport,
    confirmAction,
    retry: () => setRetry((value) => value + 1),
  };
}
