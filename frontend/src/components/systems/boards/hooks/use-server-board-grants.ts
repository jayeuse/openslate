"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import {
  createBoardGrant,
  listBoardGrantRoles,
  listBoardGrants,
  revokeBoardGrant,
  type BoardGrantList,
  type BoardGrantRoleList,
} from "../adapters/board-grants-api";
import {
  listBoardPreviewUsers,
  type BoardPreviewUser,
  type BoardToolsPage,
} from "../adapters/board-tools-api";

export const PAGE_SIZE = 25;

export type BoardGrantsState = {
  key: string | null;
  sequence: number;
  status: "idle" | "loading" | "ready" | "error";
  page: BoardGrantList | null;
  roles: BoardGrantRoleList | null;
  error: string | null;
};

export type BoardGrantsEvent =
  | { type: "begin"; key: string; sequence: number }
  | {
      type: "resolve";
      key: string;
      sequence: number;
      page: BoardGrantList;
      roles: BoardGrantRoleList;
    }
  | { type: "reject"; key: string; sequence: number; error: string };

export const emptyBoardGrantsState: BoardGrantsState = {
  key: null,
  sequence: 0,
  status: "idle",
  page: null,
  roles: null,
  error: null,
};

export function transitionBoardGrantsState(
  state: BoardGrantsState,
  event: BoardGrantsEvent,
): BoardGrantsState {
  if (event.type === "begin")
    return {
      key: event.key,
      sequence: event.sequence,
      status: "loading",
      page: null,
      roles: null,
      error: null,
    };
  if (state.key !== event.key || state.sequence !== event.sequence)
    return state;
  if (event.type === "resolve")
    return {
      ...state,
      status: "ready",
      page: event.page,
      roles: event.roles,
      error: null,
    };
  return {
    ...state,
    status: "error",
    page: null,
    roles: null,
    error: event.error,
  };
}

export type PrincipalType = "user" | "role" | "everyone";
export type Permission = "view" | "edit" | "manage";
export type Effect = "allow" | "deny";
type Conflict =
  | { kind: "create"; phase: "reload" | "review" }
  | { kind: "revoke"; grantId: string; phase: "reload" | "review" };
type UserChoices = {
  key: string | null;
  status: "idle" | "loading" | "ready" | "error";
  page: BoardToolsPage<BoardPreviewUser> | null;
  error: string | null;
};

function denied(error: unknown): boolean {
  return error instanceof ApiError && [401, 403, 404].includes(error.status);
}

export function useServerBoardGrants({
  boardId,
  boardActive,
  refreshKey,
  onAccessDenied,
}: {
  boardId: string;
  boardActive: boolean;
  refreshKey: number;
  onAccessDenied?: (boardId: string) => void;
}) {
  const id = useId();
  const [grantOffset, setGrantOffset] = useState(0);
  const [roleOffset, setRoleOffset] = useState(0);
  const [roleSearchInput, setRoleSearchInput] = useState("");
  const [roleSearch, setRoleSearch] = useState("");
  const [userOffset, setUserOffset] = useState(0);
  const [userSearchInput, setUserSearchInput] = useState("");
  const [userSearch, setUserSearch] = useState("");
  const [reload, setReload] = useState(0);
  const [userReload, setUserReload] = useState(0);
  const [state, setState] = useState(emptyBoardGrantsState);
  const [users, setUsers] = useState<UserChoices>({
    key: null,
    status: "idle",
    page: null,
    error: null,
  });
  const [principalType, setPrincipalType] = useState<PrincipalType>("everyone");
  const [principalId, setPrincipalId] = useState("");
  const [permission, setPermission] = useState<Permission>("view");
  const [effect, setEffect] = useState<Effect>("allow");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [revokeChoice, setRevokeChoice] = useState<{
    key: string;
    grantId: string;
  } | null>(null);
  const [accessDenied, setAccessDenied] = useState(false);
  const sequence = useRef(0);
  const pendingRef = useRef(false);
  const mounted = useRef(false);
  const deniedRef = useRef(false);

  const key = JSON.stringify([
    boardId,
    boardActive,
    refreshKey,
    grantOffset,
    roleOffset,
    roleSearch,
    reload,
  ]);
  const visible = state.key === key ? state : emptyBoardGrantsState;
  const userKey = JSON.stringify([key, userSearch, userOffset, userReload]);
  const visibleUsers = users.key === userKey ? users : null;
  const selectedRole = visible.roles?.items.find(
    (role) => role.id === principalId,
  );
  const selectedUser = visibleUsers?.page?.items.find(
    (user) => user.id === principalId,
  );
  const choiceValid =
    principalType === "everyone" ||
    (principalType === "role" && selectedRole !== undefined) ||
    (principalType === "user" && selectedUser !== undefined);
  const canMutate =
    boardActive &&
    !accessDenied &&
    visible.status === "ready" &&
    visible.page !== null &&
    visible.roles !== null;
  const revokeTarget =
    revokeChoice?.key === key
      ? (visible.page?.items.find((item) => item.id === revokeChoice.grantId) ??
        null)
      : null;

  function loseAccess() {
    deniedRef.current = true;
    setAccessDenied(true);
    setState((current) =>
      transitionBoardGrantsState(current, {
        type: "reject",
        key: current.key ?? key,
        sequence: current.sequence,
        error: "Board grant access is unavailable.",
      }),
    );
    setUsers({ key: null, status: "error", page: null, error: null });
    setPrincipalId("");
    setConflict(null);
    setRevokeChoice(null);
    setError(null);
    setNotice(null);
    onAccessDenied?.(boardId);
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!boardActive || deniedRef.current) return;
    let active = true;
    const currentSequence = ++sequence.current;
    setState((current) =>
      transitionBoardGrantsState(current, {
        type: "begin",
        key,
        sequence: currentSequence,
      }),
    );
    // The role chooser enforces records.write + Board MANAGE. Do not reveal
    // grant rows unless that request and the grants request both succeed.
    void Promise.all([
      listBoardGrantRoles(boardId, {
        limit: PAGE_SIZE,
        offset: roleOffset,
        search: roleSearch || undefined,
      }),
      listBoardGrants(boardId, { limit: PAGE_SIZE, offset: grantOffset }),
    ])
      .then(([roles, page]) => {
        if (!active || deniedRef.current) return;
        setState((current) =>
          transitionBoardGrantsState(current, {
            type: "resolve",
            key,
            sequence: currentSequence,
            page,
            roles,
          }),
        );
        setConflict((current) =>
          current?.phase === "reload"
            ? { ...current, phase: "review" }
            : current,
        );
      })
      .catch((failure: unknown) => {
        if (!active) return;
        if (denied(failure)) {
          loseAccess();
          return;
        }
        setState((current) =>
          transitionBoardGrantsState(current, {
            type: "reject",
            key,
            sequence: currentSequence,
            error:
              failure instanceof ApiError && failure.status === 409
                ? failure.message
                : "Could not load Board grant rules. Try again.",
          }),
        );
      });
    return () => {
      active = false;
    };
  }, [boardId, boardActive, grantOffset, key, roleOffset, roleSearch]);

  useEffect(() => {
    if (
      !boardActive ||
      deniedRef.current ||
      principalType !== "user" ||
      visible.status !== "ready"
    )
      return;
    let active = true;
    setUsers({ key: userKey, status: "loading", page: null, error: null });
    void listBoardPreviewUsers(boardId, {
      limit: PAGE_SIZE,
      offset: userOffset,
      search: userSearch || undefined,
    })
      .then((page) => {
        if (active && !deniedRef.current)
          setUsers({ key: userKey, status: "ready", page, error: null });
      })
      .catch((failure: unknown) => {
        if (!active) return;
        if (denied(failure)) {
          loseAccess();
          return;
        }
        setUsers({
          key: userKey,
          status: "error",
          page: null,
          error: "Could not load active people. Try again.",
        });
      });
    return () => {
      active = false;
    };
  }, [
    boardId,
    boardActive,
    principalType,
    userKey,
    userOffset,
    userSearch,
    visible.status,
  ]);

  async function saveGrant() {
    if (!canMutate || !choiceValid || pendingRef.current || conflict) return;
    const revision = visible.page?.boardRevision;
    if (!revision) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await createBoardGrant(
        boardId,
        principalType === "user"
          ? {
              revision,
              principalType,
              principalUserId: principalId,
              permission,
              effect,
            }
          : principalType === "role"
            ? {
                revision,
                principalType,
                principalRoleId: principalId,
                permission,
                effect,
              }
            : { revision, principalType, permission, effect },
      );
      if (!mounted.current || deniedRef.current) return;
      setPrincipalId("");
      setNotice("Board grant rule added. Refreshing the current rules.");
      setReload((value) => value + 1);
    } catch (failure) {
      if (!mounted.current) return;
      if (denied(failure)) loseAccess();
      else if (
        failure instanceof ApiError &&
        failure.code === "stale_revision"
      ) {
        setConflict({ kind: "create", phase: "reload" });
        setState((current) =>
          transitionBoardGrantsState(current, {
            type: "reject",
            key: current.key ?? key,
            sequence: current.sequence,
            error:
              "Board changed elsewhere. Reload the latest rules before retrying.",
          }),
        );
      } else
        setError(
          failure instanceof ApiError && failure.status === 409
            ? failure.message
            : "Could not add Board grant rule. Try again.",
        );
    } finally {
      pendingRef.current = false;
      if (mounted.current) setPending(false);
    }
  }

  async function revokeGrant(grantId: string) {
    if (!canMutate || pendingRef.current || conflict) return;
    const revision = visible.page?.boardRevision;
    if (!revision || !visible.page?.items.some((item) => item.id === grantId))
      return;
    pendingRef.current = true;
    setRevokeChoice(null);
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await revokeBoardGrant(boardId, grantId, revision);
      if (!mounted.current || deniedRef.current) return;
      setNotice("Board grant rule revoked. Refreshing the current rules.");
      setReload((value) => value + 1);
    } catch (failure) {
      if (!mounted.current) return;
      if (denied(failure)) loseAccess();
      else if (
        failure instanceof ApiError &&
        failure.code === "stale_revision"
      ) {
        setConflict({ kind: "revoke", grantId, phase: "reload" });
        setState((current) =>
          transitionBoardGrantsState(current, {
            type: "reject",
            key: current.key ?? key,
            sequence: current.sequence,
            error:
              "Board changed elsewhere. Reload the latest rules before retrying.",
          }),
        );
      } else
        setError(
          failure instanceof ApiError && failure.status === 409
            ? failure.message
            : "Could not revoke Board grant rule. Try again.",
        );
    } finally {
      pendingRef.current = false;
      if (mounted.current) setPending(false);
    }
  }

  function searchRoles() {
    setPrincipalId("");
    setRoleOffset(0);
    setRoleSearch(roleSearchInput.trim());
    setReload((value) => value + 1);
  }

  function searchUsers() {
    setPrincipalId("");
    setUserOffset(0);
    setUserSearch(userSearchInput.trim());
    setUserReload((value) => value + 1);
  }

  return {
    id,
    key,
    visible,
    visibleUsers,
    grantOffset,
    setGrantOffset,
    roleOffset,
    setRoleOffset,
    roleSearchInput,
    setRoleSearchInput,
    userOffset,
    setUserOffset,
    userSearchInput,
    setUserSearchInput,
    setUserReload,
    setReload,
    principalType,
    setPrincipalType,
    principalId,
    setPrincipalId,
    permission,
    setPermission,
    effect,
    setEffect,
    pending,
    error,
    notice,
    setNotice,
    conflict,
    setConflict,
    accessDenied,
    choiceValid,
    canMutate,
    selectedRole,
    selectedUser,
    revokeTarget,
    setRevokeChoice,
    saveGrant,
    revokeGrant,
    searchRoles,
    searchUsers,
  };
}
