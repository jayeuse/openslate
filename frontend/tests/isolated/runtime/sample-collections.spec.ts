import { expect, test } from "@playwright/test";
import {
  completeCollection,
  pageCollection,
} from "../../../src/components/sample/sample-collections";

test("page results retain the full query total and final-page boundary", () => {
  const items = Array.from({ length: 25 }, (_, id) => ({ id }));
  const all = completeCollection(items, "records:all");
  const last = pageCollection(all, 20, 10);
  expect(last).toEqual({
    kind: "page",
    queryKey: "records:all",
    items: items.slice(20),
    total: 25,
    offset: 20,
    limit: 10,
  });
  expect(pageCollection(all, 40, 10)).toEqual(last);
  expect(all.items).toHaveLength(25);
});

test("empty results reset the offset without inventing sample rows", () => {
  expect(pageCollection(completeCollection([], "empty"), 30, 10)).toEqual({
    kind: "page",
    queryKey: "empty",
    items: [],
    total: 0,
    offset: 0,
    limit: 10,
  });
});
