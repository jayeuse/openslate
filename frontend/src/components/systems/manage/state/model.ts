export type ManageSettings = {
  name: string;
  logo: string;
  locale: string;
  timezone: string;
  currency: string;
  week: string;
  hours: string;
  password: string;
  timeout: string;
  mfa: string;
  ips: string;
  schedule: string;
  retention: string;
  version: string;
  previous: string;
  tier: string;
  expiry: string;
};
export type ManageSection = "organization" | "security" | "backup";
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
  password: "12 characters + mixed case",
  timeout: "60 minutes",
  mfa: "Optional",
  ips: "192.0.2.0/24",
  schedule: "Daily at 02:00",
  retention: "30 days",
  version: "1.4.2",
  previous: "",
  tier: "Team",
  expiry: "2027-09-11",
};
