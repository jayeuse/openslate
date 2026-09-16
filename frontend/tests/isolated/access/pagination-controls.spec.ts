import { expect, test } from "@playwright/test";
import { getPageLinkItems } from "../../../src/components/ui/pagination-controls";

test("numbered pagination uses one-based labels without exposing every large page", () => {
  expect(getPageLinkItems(4, 0)).toEqual([0, 1, 2, 3]);
  expect(getPageLinkItems(12, 5)).toEqual([
    0,
    "ellipsis",
    4,
    5,
    6,
    "ellipsis",
    11,
  ]);
});

test("pagination link indexes stay zero-based at the boundaries", () => {
  expect(getPageLinkItems(12, 0)).toEqual([0, 1, "ellipsis", 11]);
  expect(getPageLinkItems(12, 11)).toEqual([0, "ellipsis", 10, 11]);
});
