export type ManageSettings = {
  name: string;
  logo: string;
  locale: string;
  timezone: string;
  currency: string;
  week: string;
  hours: string;
  schedule: string;
  retention: string;
  version: string;
  previous: string;
  tier: string;
  expiry: string;
};
export type ManageSection = "organization" | "backup";
export type ManageValidationErrors = Partial<
  Record<keyof ManageSettings, string>
>;
export type ManageActivityEntry = {
  id: string;
  user: string;
  date: string;
  entity: string;
  action: string;
  target: string;
  before: string;
  after: string;
  source: "example" | "manage";
};

export const initialManageSettings: ManageSettings = {
  name: "Riverside Services",
  logo: "RS",
  locale: "English (Philippines)",
  timezone: "Asia/Manila",
  currency: "PHP",
  week: "Monday",
  hours: "09:00–18:00",
  schedule: "Daily at 02:00",
  retention: "30 days",
  version: "1.4.2",
  previous: "",
  tier: "Team",
  expiry: "2027-09-11",
};
