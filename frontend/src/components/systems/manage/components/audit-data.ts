export type ActivityOrder = "newest" | "oldest";

export type ActivityFilters = {
  query: string;
  user: string;
  entity: string;
  action: string;
  from: string;
  to: string;
  order: ActivityOrder;
};

export const initialActivityFilters: ActivityFilters = {
  query: "",
  user: "All users",
  entity: "All entities",
  action: "All actions",
  from: "",
  to: "",
  order: "newest",
};
