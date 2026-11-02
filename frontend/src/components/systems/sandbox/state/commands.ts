/** A refused command; `reference` is the failed request's ID, if any (D1.6). */
export type SandboxCommandFailure = {
  ok: false;
  error: string;
  reference?: string;
};
export type SandboxCommandSuccess<T> = { ok: true; value: T };
export type SandboxCommandResult<T> =
  SandboxCommandSuccess<T> | SandboxCommandFailure;

/** Marks an expected, user-actionable rejection without exposing internals. */
export class SandboxCommandError extends Error {
  /** The failed request's ID when a server refusal is behind it (D1.6). */
  readonly reference: string | undefined;
  constructor(message: string, reference?: string) {
    super(message);
    this.name = "SandboxCommandError";
    this.reference = reference;
  }
}
