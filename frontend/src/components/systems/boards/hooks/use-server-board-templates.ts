"use client";

import { useEffect, useRef, useState } from "react";
import { ApiContractError, ApiError } from "@/lib/api";
import {
  getBoardTemplate,
  instantiateBoardTemplate,
  listBoardTemplates,
  readBoard,
  saveBoardTemplate,
  type BoardManagementBoard,
  type BoardTemplate,
} from "../adapters/board-management-api";
import { getMyBoardAccess } from "../adapters/board-tools-api";

const TEMPLATE_LIMIT = 50;

export type BoardTemplatesState = {
  key: string | null;
  sequence: number;
  status: "idle" | "loading" | "ready" | "error";
  templates: BoardTemplate[] | null;
  source: BoardManagementBoard | null;
  canManage: boolean;
  error: string | null;
};

export type BoardTemplatesEvent =
  | { type: "begin"; key: string; sequence: number }
  | {
      type: "resolve";
      key: string;
      sequence: number;
      templates: BoardTemplate[];
      source: BoardManagementBoard | null;
      canManage: boolean;
    }
  | {
      type: "reject";
      key: string;
      sequence: number;
      error: string;
      retain: boolean;
    };

export const emptyBoardTemplatesState: BoardTemplatesState = {
  key: null,
  sequence: 0,
  status: "idle",
  templates: null,
  source: null,
  canManage: false,
  error: null,
};

export function transitionBoardTemplates(
  state: BoardTemplatesState,
  event: BoardTemplatesEvent,
): BoardTemplatesState {
  if (event.type === "begin") {
    const sameBoard = state.key === event.key;
    return {
      key: event.key,
      sequence: event.sequence,
      status: "loading",
      templates: sameBoard ? state.templates : null,
      source: sameBoard ? state.source : null,
      canManage: sameBoard ? state.canManage : false,
      error: null,
    };
  }
  if (state.key !== event.key || state.sequence !== event.sequence)
    return state;
  if (event.type === "resolve")
    return {
      ...state,
      status: "ready",
      templates: event.templates,
      source: event.source,
      canManage: event.canManage,
      error: null,
    };
  return {
    ...state,
    status: "error",
    templates: event.retain ? state.templates : null,
    source: event.retain ? state.source : null,
    canManage: event.retain ? state.canManage : false,
    error: event.error,
  };
}

export async function loadBoardTemplates(
  board: BoardManagementBoard | null,
): Promise<{
  templates: BoardTemplate[];
  source: BoardManagementBoard | null;
  canManage: boolean;
}> {
  const [page, access, source] = await Promise.all([
    listBoardTemplates({ limit: TEMPLATE_LIMIT, offset: 0 }),
    board ? getMyBoardAccess(board.id) : Promise.resolve(null),
    board ? readBoard(board.id) : Promise.resolve(null),
  ]);
  if (
    page.pagination.limit !== TEMPLATE_LIMIT ||
    page.pagination.offset !== 0 ||
    page.pagination.count !== page.items.length ||
    page.pagination.total !== page.items.length ||
    page.pagination.hasMore ||
    (board !== null && source?.id !== board.id)
  )
    throw new ApiContractError();
  return {
    templates: page.items,
    source,
    canManage: access?.manage ?? false,
  };
}

export async function saveCurrentBoardTemplate(
  board: BoardManagementBoard,
  name: string,
): Promise<BoardTemplate> {
  const cleanName = name.trim();
  if (!cleanName || cleanName.length > 80)
    throw new Error("Enter a template name of 1–80 characters.");
  if (board.status !== "active")
    throw new ApiError(409, "Restore the Board before saving a template.");
  const [access, latest] = await Promise.all([
    getMyBoardAccess(board.id),
    readBoard(board.id),
  ]);
  if (!access.manage)
    throw new ApiError(403, "You cannot save this Board as a template.");
  if (latest.id !== board.id || latest.revision !== board.revision)
    throw new ApiError(409, "Board changed; refresh before saving a template.");
  if (latest.status !== "active")
    throw new ApiError(409, "Restore the Board before saving a template.");
  return saveBoardTemplate({ boardId: board.id, name: cleanName });
}

export async function instantiateListedBoardTemplate(
  template: BoardTemplate,
): Promise<BoardManagementBoard> {
  const latest = await getBoardTemplate(template.id);
  if (
    latest.name !== template.name ||
    latest.updatedAt !== template.updatedAt ||
    latest.widgetCount !== template.widgetCount
  )
    throw new ApiError(409, "Template changed; refresh before using it.");
  return instantiateBoardTemplate(template.id);
}

function templateFailure(error: unknown): { message: string; denied: boolean } {
  if (error instanceof ApiError) {
    if ([401, 403, 404].includes(error.status))
      return {
        message: "Board templates are unavailable with your current access.",
        denied: true,
      };
    if (error.status === 409) return { message: error.message, denied: false };
  }
  return {
    message: "Could not verify Board templates. Try again.",
    denied: false,
  };
}

export function useServerBoardTemplates(
  board: BoardManagementBoard | null,
  refreshKey: number,
  onBoardCreated: (board: BoardManagementBoard) => void,
) {
  const [state, setState] = useState(emptyBoardTemplatesState);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const sequence = useRef(0);
  const action = useRef<{ key: string } | null>(null);
  const key = board ? `${board.id}:${board.revision}` : "new-board";
  const visibleState = state.key === key ? state : emptyBoardTemplatesState;

  useEffect(() => {
    const request = ++sequence.current;
    setName("");
    setPending(action.current?.key === key);
    setNotice(null);
    setState((current) =>
      transitionBoardTemplates(current, {
        type: "begin",
        key,
        sequence: request,
      }),
    );
    void loadBoardTemplates(board)
      .then(({ templates, source, canManage }) => {
        if (sequence.current !== request) return;
        setState((current) =>
          transitionBoardTemplates(current, {
            type: "resolve",
            key,
            sequence: request,
            templates,
            source,
            canManage,
          }),
        );
      })
      .catch((error: unknown) => {
        if (sequence.current !== request) return;
        const result = templateFailure(error);
        setState((current) =>
          transitionBoardTemplates(current, {
            type: "reject",
            key,
            sequence: request,
            error: result.message,
            retain:
              !result.denied &&
              current.key === key &&
              current.templates !== null,
          }),
        );
      });
    return () => {
      sequence.current += 1;
    };
  }, [board, key, refreshKey, retry]);

  async function save() {
    if (
      action.current?.key === key ||
      !board ||
      visibleState.status !== "ready" ||
      !visibleState.canManage ||
      visibleState.source?.revision !== board.revision ||
      visibleState.source.status !== "active" ||
      board.status !== "active"
    )
      return;
    const request = sequence.current;
    const operation = { key };
    action.current = operation;
    setPending(true);
    setNotice(null);
    try {
      await saveCurrentBoardTemplate(board, name);
      if (sequence.current !== request) return;
      setName("");
      setNotice("Template saved. It contains Board structure only.");
      const loaded = await loadBoardTemplates(board);
      if (sequence.current !== request) return;
      setState((current) =>
        transitionBoardTemplates(current, {
          type: "resolve",
          key,
          sequence: request,
          ...loaded,
        }),
      );
    } catch (error) {
      if (sequence.current !== request) return;
      const result = templateFailure(error);
      setState((current) =>
        transitionBoardTemplates(current, {
          type: "reject",
          key,
          sequence: request,
          error: result.message,
          retain: !result.denied && current.templates !== null,
        }),
      );
    } finally {
      if (action.current === operation) {
        action.current = null;
        setPending(false);
      }
    }
  }

  async function instantiate(template: BoardTemplate) {
    if (
      action.current?.key === key ||
      visibleState.status !== "ready" ||
      !visibleState.templates?.some((item) => item.id === template.id)
    )
      return;
    const request = sequence.current;
    const operation = { key };
    action.current = operation;
    setPending(true);
    setNotice(null);
    try {
      const created = await instantiateListedBoardTemplate(template);
      if (sequence.current !== request) return;
      setNotice("Private Board created from template.");
      onBoardCreated(created);
    } catch (error) {
      if (sequence.current !== request) return;
      const result = templateFailure(error);
      setState((current) =>
        transitionBoardTemplates(current, {
          type: "reject",
          key,
          sequence: request,
          error: result.message,
          retain: !result.denied && current.templates !== null,
        }),
      );
    } finally {
      if (action.current === operation) {
        action.current = null;
        setPending(false);
      }
    }
  }

  return {
    state: visibleState,
    name,
    pending,
    notice,
    setName,
    save,
    instantiate,
    retry: () => setRetry((value) => value + 1),
  };
}
