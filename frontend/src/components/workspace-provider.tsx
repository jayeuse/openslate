"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useRef,
  useCallback,
  type ReactNode,
} from "react";
import { ApiError, apiFetch } from "@/lib/api";
import {
  workspaceSchema,
  currentUserSchema,
  type WorkspaceProfile,
  type CurrentUser,
} from "@/lib/workspace";
import {
  OPENSLADE_INVALIDATION_EVENT,
  useRealtime,
} from "@/components/realtime-provider";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

type WorkspaceContextValue = {
  profile: WorkspaceProfile;
  user: CurrentUser;
  isAdmin: boolean;
  can: (capability: string) => boolean;
  refresh: () => Promise<void>;
};
const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("Workspace context is unavailable");
  return value;
}
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<{
    profile: WorkspaceProfile;
    user: CurrentUser;
  } | null>(null);
  const [error, setError] = useState(false);
  const [reloadRequired, setReloadRequired] = useState(false);
  const [generation, setGeneration] = useState(0);
  const dataRef = useRef<typeof data>(null);
  const requestGeneration = useRef(0);
  const activeController = useRef<AbortController | null>(null);
  const terminal = useRef(false);
  const { invalidate: invalidateRealtime } = useRealtime();
  const refresh = useCallback(async () => {
    if (terminal.current) return;
    activeController.current?.abort();
    requestGeneration.current += 1;
    setGeneration((value) => value + 1);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    activeController.current = controller;
    const request = ++requestGeneration.current;
    const active = () =>
      !controller.signal.aborted && request === requestGeneration.current;
    let profile: WorkspaceProfile | undefined;
    let user: CurrentUser | undefined;
    const publish = () => {
      if (!active()) return;
      const previous = dataRef.current;
      const nextProfile = profile ?? previous?.profile;
      const nextUser = user ?? previous?.user;
      if (nextProfile && nextUser) {
        const next = { profile: nextProfile, user: nextUser };
        dataRef.current = next;
        setData(next);
      }
      if (profile && user) setError(false);
    };
    const terminate = (reload = false) => {
      if (!active()) return;
      terminal.current = true;
      requestGeneration.current += 1;
      controller.abort();
      invalidateRealtime();
      dataRef.current = null;
      setData(null);
      setError(true);
      setReloadRequired(true);
      if (reload) window.location.reload();
    };
    const failure = (reason: unknown, auth: boolean) => {
      if (!active()) return;
      const terminalHttp =
        reason instanceof ApiError &&
        reason.status >= 400 &&
        reason.status < 500 &&
        reason.status !== 408 &&
        reason.status !== 429;
      // Authorization payloads are never usable without successful validation.
      const invalidAuth =
        auth && !(reason instanceof ApiError) && !(reason instanceof TypeError);
      if (terminalHttp || invalidAuth) terminate();
      else setError(true);
    };
    void apiFetch<unknown>("/workspace", { signal: controller.signal })
      .then((value) => {
        if (!active()) return;
        profile = workspaceSchema.parse(value);
        publish();
      })
      .catch((reason) => failure(reason, false));
    void apiFetch<unknown>("/auth/me", { signal: controller.signal })
      .then((value) => {
        if (!active()) return;
        user = currentUserSchema.parse(value);
        if (dataRef.current && dataRef.current.user.id !== user.id) {
          terminate(true);
          return;
        }
        publish();
      })
      .catch((reason) => failure(reason, true));
    return () => {
      controller.abort();
    };
  }, [generation, invalidateRealtime]);
  useEffect(() => {
    const invalidate = () => {
      void refresh();
    };
    window.addEventListener(OPENSLADE_INVALIDATION_EVENT, invalidate);
    window.addEventListener("focus", invalidate);
    return () => {
      window.removeEventListener(OPENSLADE_INVALIDATION_EVENT, invalidate);
      window.removeEventListener("focus", invalidate);
    };
  }, [refresh]);
  if (!data)
    return (
      <main className="grid min-h-screen place-items-center">
        <div className="flex flex-col items-center gap-4">
          <p role={error ? "alert" : "status"}>
            {error ? "Workspace could not be loaded." : "Loading workspace…"}
          </p>
          {error && (
            <Button
              onClick={() =>
                reloadRequired ? window.location.reload() : void refresh()
              }
            >
              Retry
            </Button>
          )}
        </div>
      </main>
    );
  return (
    <WorkspaceContext.Provider
      value={{
        ...data,
        isAdmin: data.user.role === "admin",
        can: (capability) =>
          data.user.permissions.some((item) => item === capability),
        refresh,
      }}
    >
      {error && (
        <Alert
          role="alert"
          variant="warning"
          className="flex items-center justify-center gap-3 rounded-none"
        >
          <span>
            Workspace could not be refreshed. Your current work is retained.
          </span>
          <Button variant="outline" onClick={() => void refresh()}>
            Retry
          </Button>
        </Alert>
      )}
      {children}
    </WorkspaceContext.Provider>
  );
}
