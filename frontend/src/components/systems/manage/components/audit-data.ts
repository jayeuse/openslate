export type ActivityOrder = "newest" | "oldest";
/** The quick filter beside the search: every event, or one kind of change. */
export type ActivityKind = "all" | "update" | "create" | "delete";

export type ActivityFilters = {
  query: string;
  kind: ActivityKind;
  /** The person's id, or "" for everyone. */
  user: string;
  /** The audited table (`entity_type`), or "" for every area. */
  entity: string;
  /** Calendar days in the organization's zone, or "". */
  from: string;
  to: string;
  order: ActivityOrder;
};

export const initialActivityFilters: ActivityFilters = {
  query: "",
  kind: "all",
  user: "",
  entity: "",
  from: "",
  to: "",
  order: "newest",
};
