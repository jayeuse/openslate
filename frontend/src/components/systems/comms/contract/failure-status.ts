/** The HTTP status of a typed Comms refusal, when the error carries one. */
export function failureStatus(error: unknown): number | undefined {
  return typeof error === "object" &&
    error !== null &&
    "failure" in error &&
    typeof error.failure === "object" &&
    error.failure !== null &&
    "status" in error.failure
    ? Number(error.failure.status)
    : undefined;
}
