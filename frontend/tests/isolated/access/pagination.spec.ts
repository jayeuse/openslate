import { expect, test } from "@playwright/test";

import {
  AccessLoadError,
  loadAllAccessPages,
  loadVersionedAccessDetails,
} from "../../../src/components/systems/access/state/pagination";

function page<Item>(items: Item[], offset: number, total: number) {
  return {
    items,
    pagination: {
      limit: 100,
      offset,
      count: items.length,
      total,
      has_more: offset + items.length < total,
    },
  };
}

test("loads every page once and forwards an abort signal", async () => {
  const controller = new AbortController();
  const offsets: number[] = [];
  const signals: AbortSignal[] = [];

  const items = await loadAllAccessPages(
    async ({ limit, offset, signal }) => {
      expect(limit).toBe(100);
      offsets.push(offset);
      if (signal) signals.push(signal);
      return offset === 0
        ? page([{ id: "first" }], 0, 2)
        : page([{ id: "second" }], 1, 2);
    },
    { signal: controller.signal },
  );

  expect(items).toEqual([{ id: "first" }, { id: "second" }]);
  expect(offsets).toEqual([0, 1]);
  expect(signals).toEqual([controller.signal, controller.signal]);

  controller.abort();
  await expect(
    loadAllAccessPages(async () => page([], 0, 0), {
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
});

test("rejects repeated, non-progressing, inconsistent, and over-bound pages", async () => {
  await expect(
    loadAllAccessPages(async ({ offset }) =>
      page([{ id: "repeat" }], offset, 2),
    ),
  ).rejects.toBeInstanceOf(AccessLoadError);
  await expect(
    loadAllAccessPages(async ({ offset }) => ({
      ...page([], offset, 1),
      pagination: { ...page([], offset, 1).pagination, has_more: true },
    })),
  ).rejects.toBeInstanceOf(AccessLoadError);
  await expect(
    loadAllAccessPages(async ({ offset }) =>
      page([{ id: `${offset}` }], offset + 1, 1),
    ),
  ).rejects.toBeInstanceOf(AccessLoadError);
  await expect(
    loadAllAccessPages(async ({ offset }) =>
      page([{ id: `${offset}` }], offset, 2001),
    ),
  ).rejects.toBeInstanceOf(AccessLoadError);
});

test("versioned details replace stale list data in stable order", async () => {
  const list = [
    { id: "one", value: "list-one" },
    { id: "two", value: "list-two" },
  ];

  const result = await loadVersionedAccessDetails(list, async (id) => ({
    data: { id, value: `detail-${id}` },
    etag: `"${id}-etag"`,
  }));

  expect(result.items).toEqual([
    { id: "one", value: "detail-one" },
    { id: "two", value: "detail-two" },
  ]);
  expect(result.etags).toEqual({ one: '"one-etag"', two: '"two-etag"' });
});

test("versioned detail reads are batched, fail closed, and propagate aborts", async () => {
  let active = 0;
  let maximumActive = 0;
  const list = Array.from({ length: 17 }, (_, index) => ({ id: `${index}` }));
  const batched = await loadVersionedAccessDetails(list, async (id) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await Promise.resolve();
    active -= 1;
    return { data: { id }, etag: `"${id}"` };
  });
  expect(maximumActive).toBeLessThanOrEqual(8);
  expect(batched.items.map((item) => item.id)).toEqual(
    list.map((item) => item.id),
  );

  await expect(
    loadVersionedAccessDetails([{ id: "missing" }], async () => ({
      data: { id: "missing" },
      etag: "",
    })),
  ).rejects.toBeInstanceOf(AccessLoadError);
  await expect(
    loadVersionedAccessDetails(
      [{ id: "absent" }],
      async () => ({ data: { id: "absent" } }) as never,
    ),
  ).rejects.toBeInstanceOf(AccessLoadError);
  await expect(
    loadVersionedAccessDetails([{ id: "failed" }], async () => {
      throw new Error("detail failed");
    }),
  ).rejects.toThrow("detail failed");

  const controller = new AbortController();
  await expect(
    loadVersionedAccessDetails(
      [{ id: "aborted" }],
      async (id, options) => {
        expect(options.signal).toBe(controller.signal);
        controller.abort();
        return { data: { id }, etag: '"aborted"' };
      },
      { signal: controller.signal },
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
});
