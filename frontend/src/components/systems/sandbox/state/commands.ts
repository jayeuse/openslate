export type SandboxCommandFailure = { ok: false; error: string };
export type SandboxCommandSuccess<T> = { ok: true; value: T };
export type SandboxCommandResult<T> =
  SandboxCommandSuccess<T> | SandboxCommandFailure;

/** Marks an expected, user-actionable rejection without exposing internals. */
export class SandboxCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxCommandError";
  }
}
