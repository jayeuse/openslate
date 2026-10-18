import { useLayoutEffect, useState } from "react";

type HandlerSet = Record<string, (...args: never[]) => unknown>;

function createStableHandlers<T extends HandlerSet>(initial: T) {
  let current = initial;
  const handlers = Object.fromEntries(
    Object.keys(initial).map((key) => [
      key,
      (...args: never[]) => current[key](...args),
    ]),
  ) as T;
  return {
    handlers,
    update: (next: T) => {
      current = next;
    },
  };
}

/**
 * Returns functions that keep one identity and always call the newest handler,
 * so a memoized child (or a library that stores handlers) does not update for
 * new closures. The set of keys is fixed at the first render.
 */
export function useStableHandlers<T extends HandlerSet>(handlers: T): T {
  const [stable] = useState(() => createStableHandlers(handlers));
  useLayoutEffect(() => {
    stable.update(handlers);
  });
  return stable.handlers;
}
