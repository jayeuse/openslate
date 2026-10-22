// Reads in flight at once for one burst (thread roots, category settings,
// record-linked messages, quotes, person cards, a picker's members): enough to
// overlap round trips, few enough to stay under the API's per-session limit.
export const BURST = 6;

/**
 * Reads every item with at most `size` in flight; results keep their order.
 * After a failure no further item starts, and the first failure is thrown.
 */
export async function limited<T, R>(
  items: readonly T[],
  size: number,
  read: (item: T) => Promise<R>,
) {
  const results: R[] = new Array(items.length);
  let next = 0,
    failed = false;
  async function worker() {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await read(items[index]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, worker),
  );
  return results;
}
