export type FetchImplementation = typeof fetch;

export function withRequestSignal(
  signal: AbortSignal,
  transport: FetchImplementation = fetch,
): FetchImplementation {
  return (input, init) => transport(input, { ...init, signal });
}
