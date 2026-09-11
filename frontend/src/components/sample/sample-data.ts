export type SampleRecord = {
  id: string;
  title: string;
  customer: string;
  status: string;
  assignee: string;
  dueDate: string;
};

export const INITIAL_RECORDS: SampleRecord[] = [
  {
    id: "sample-sr-1004",
    title: "Replace pump seal",
    customer: "Riverside Industrial",
    status: "In progress",
    assignee: "Morgan Kim",
    dueDate: "2026-09-18",
  },
  {
    id: "sample-sr-1005",
    title: "Investigate pressure drop",
    customer: "Northvale Co.",
    status: "Open",
    assignee: "Alex Lee",
    dueDate: "2026-09-19",
  },
  {
    id: "sample-sr-1006",
    title: "Electrical panel inspection",
    customer: "Cedar Ridge Facilities",
    status: "Scheduled",
    assignee: "Pat Riley",
    dueDate: "2026-09-20",
  },
  {
    id: "sample-sr-1007",
    title: "HVAC not cooling",
    customer: "Maple Grove Health",
    status: "In progress",
    assignee: "Jamie Torres",
    dueDate: "2026-09-21",
  },
  {
    id: "sample-sr-1008",
    title: "Calibrate flow sensor",
    customer: "Stonebridge Manufacturing",
    status: "On hold",
    assignee: "Drew Shaw",
    dueDate: "2026-09-22",
  },
  {
    id: "sample-sr-1009",
    title: "Leak in supply line",
    customer: "Lakeside University",
    status: "Open",
    assignee: "Morgan Kim",
    dueDate: "2026-09-23",
  },
  {
    id: "sample-sr-1010",
    title: "Routine maintenance",
    customer: "Pinecrest Logistics",
    status: "Scheduled",
    assignee: "Alex Lee",
    dueDate: "2026-09-24",
  },
  {
    id: "sample-sr-1011",
    title: "Update control software",
    customer: "Summit Foods",
    status: "Open",
    assignee: "Pat Riley",
    dueDate: "2026-09-25",
  },
];
