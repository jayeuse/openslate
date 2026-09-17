"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  createSampleCommands,
  createSampleResource,
} from "./sample-async-state";
import { useSampleRuntime } from "./sample-state";

export { sampleOperationMessage } from "./sample-async-state";
export type { SampleResourceState } from "./sample-async-state";

export function useSampleResource<T>({
  keys,
  queryKey,
  load,
}: {
  keys: readonly string[];
  queryKey: string;
  load: (signal: AbortSignal) => Promise<T>;
}) {
  const runtime = useSampleRuntime();
  const [resource] = useState(() => createSampleResource<T>());
  const state = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    resource.getSnapshot,
  );
  const loader = useRef(load);
  const lastQuery = useRef<string | null>(null);
  const keySignature = JSON.stringify(keys);
  useEffect(() => {
    loader.current = load;
  }, [load]);
  const reload = useCallback(() => {
    void resource.load((signal) => loader.current(signal), true);
  }, [resource]);
  useEffect(() => {
    const retain = lastQuery.current === queryKey;
    lastQuery.current = queryKey;
    void resource.load((signal) => loader.current(signal), retain);
    const unsubscribe = runtime.subscribeKeys(
      JSON.parse(keySignature) as string[],
      reload,
    );
    return () => {
      unsubscribe();
      resource.cancel();
    };
  }, [runtime, resource, keySignature, queryKey, reload]);
  return { ...state, reload };
}

export function useSampleCommands() {
  const [commands] = useState(createSampleCommands);
  const pendingKeys = useSyncExternalStore(
    commands.subscribe,
    commands.getSnapshot,
    commands.getSnapshot,
  );
  useEffect(() => () => commands.cancel(), [commands]);
  useEffect(() => {
    function guardLink(event: MouseEvent) {
      if (
        !commands.isPending() ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link =
        event.target instanceof Element
          ? event.target.closest<HTMLAnchorElement>("a[href]")
          : null;
      if (
        !link ||
        link.hasAttribute("download") ||
        (link.target && link.target !== "_self")
      )
        return;
      const destination = new URL(link.href, window.location.href);
      if (
        destination.origin !== window.location.origin ||
        destination.pathname !== window.location.pathname ||
        destination.search !== window.location.search
      )
        event.preventDefault();
    }
    function guardUnload(event: BeforeUnloadEvent) {
      if (!commands.isPending()) return;
      event.preventDefault();
      event.returnValue = "";
    }
    document.addEventListener("click", guardLink, true);
    window.addEventListener("beforeunload", guardUnload);
    return () => {
      document.removeEventListener("click", guardLink, true);
      window.removeEventListener("beforeunload", guardUnload);
    };
  }, [commands]);
  return { run: commands.run, isPending: commands.isPending, pendingKeys };
}
