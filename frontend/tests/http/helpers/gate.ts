/**
 * Holds a mocked request open. The route handler calls `signalStarted()` when
 * the request arrives and awaits `wait`; the test awaits `started`, checks the
 * pending state, then calls `release()`.
 */
export type Gate = {
  started: Promise<void>;
  wait: Promise<void>;
  signalStarted: () => void;
  release: () => void;
};

export function gate(): Gate {
  let signalStarted = () => {};
  let release = () => {};
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    started,
    wait,
    signalStarted: () => signalStarted(),
    release: () => release(),
  };
}
