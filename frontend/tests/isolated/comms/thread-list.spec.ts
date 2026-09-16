import { expect, test } from "@playwright/test";
import {
  filterCommsThreadItems,
  type CommsThreadListItem,
} from "../../../src/components/sample/comms/thread-list";

const items: CommsThreadListItem[] = [
  {
    id: "active-1",
    title: "Open question",
    inactive: false,
    metadata: "1 reply",
  },
  {
    id: "inactive-1",
    title: "Resolved question",
    inactive: true,
    metadata: "2 replies",
  },
  {
    id: "active-2",
    title: "Another open question",
    inactive: false,
    metadata: "0 replies",
  },
];

test("Comms thread filtering keeps active and inactive lists separate and ordered", () => {
  expect(
    filterCommsThreadItems(items, "active").map((item) => item.id),
  ).toEqual(["active-1", "active-2"]);
  expect(
    filterCommsThreadItems(items, "inactive").map((item) => item.id),
  ).toEqual(["inactive-1"]);
  expect(items.map((item) => item.id)).toEqual([
    "active-1",
    "inactive-1",
    "active-2",
  ]);
});
