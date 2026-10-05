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
export const manageOptions = {
  logo: ["RS", "R", "Compass"],
  locale: ["English (Philippines)", "Filipino", "English (US)"],
  timezone: ["Asia/Manila", "UTC", "Asia/Singapore"],
  currency: ["PHP", "USD", "SGD"],
  week: ["Monday", "Sunday"],
  password: [
    "12 characters + mixed case",
    "16 characters + mixed case + number",
    "20-character passphrase",
  ],
  timeout: ["15 minutes", "30 minutes", "60 minutes", "8 hours"],
  mfa: ["Optional", "Required for administrators", "Required for everyone"],
  schedule: ["Disabled", "Daily at 02:00", "Weekly on Sunday at 02:00"],
  retention: ["7 days", "30 days", "90 days"],
};
