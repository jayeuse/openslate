type PageGuide = {
  title: string;
  entries: readonly [string, string, string, string?, string?, string?];
};

/** Canonical navigation pages; sections share their page's guide. */
export const PAGE_GUIDES = {
  sandbox: {
    title: "Sandbox",
    entries: [
      "Build your departments and record structure on the canvas. Structure offers the same editing controls without dragging.",
      "Select an item to inspect its fields and relationships. Design changes are saved to your draft, not published immediately.",
      "Use Triggers to describe what should happen when a record changes. Test uses temporary inputs, not operational records.",
      "Review & Publish explains the changes before you confirm them. History lets you inspect saved versions and compare designs.",
    ],
  },
  boards: {
    title: "Boards",
    entries: [
      "Choose a board to see the team information you can access. Company boards are shared with everyone in the organization.",
      "Posts holds updates and their history. Open a post to read it; editing controls depend on your access.",
      "Calendar shows the board's events. Open an event to see its details and available actions.",
      "Overview brings the board's information together. You can only open linked records and files that you are allowed to read.",
    ],
  },
  comms: {
    title: "OpenComms",
    entries: [
      "OpenComms is an example messaging screen, not a connected organization messaging service.",
      "Explore example conversations and messages to see how the screen works. Changes last until you close this tab.",
      "Example contacts and conversations do not grant access to real people, records, or private files.",
    ],
  },
  access: {
    title: "Access",
    entries: [
      "Access describes who can see and change the organization's information. The available sections depend on your role.",
      "Administrators use People to invite people and manage their accounts. A person's name opens their permitted profile card.",
      "Groups give people read, write, or manage access to departments and records. Group managers only manage the groups assigned to them.",
      "Administrators use Security to manage sign-in policies. Your own sign-in settings are in your profile.",
    ],
  },
  openview: {
    title: "OpenView",
    entries: [
      "Choose a record structure and a saved view to browse the records you can read.",
      "Filters, sorting, and visible columns help you find the right record. Open a record to inspect it before making a change.",
      "Dashboards and Charts summarize accessible information. A chart does not grant access to its underlying records.",
      "Reports prepares saved report results and exports. Editing and export controls depend on your access.",
    ],
  },
  manage: {
    title: "Manage",
    entries: [
      "Organization shows the saved organization settings, including its administrator contacts and regional defaults.",
      "Administrators can change settings. Save confirms a change; Discard changes restores the saved values.",
      "Backup and Audit are available according to your role. Read the displayed status before starting an operator action.",
      "Updates & licensing shows the installation's current information. Your personal appearance and preferences stay in your profile.",
    ],
  },
  platform: {
    title: "Platform",
    entries: [
      "Search finds the people and information you can access. Open a result only when its destination is available.",
      "Files shows accessible files. Uploads and downloads use the application's permission checks.",
      "Notifications points you to changes that matter to you. A notification does not grant new access.",
      "Import & export offers the available data-transfer actions. Review their scope before confirming a change.",
    ],
  },
  profile: {
    title: "Profile",
    entries: [
      "Identity holds your display name, job title, phone, short bio, and photo. Save identity confirms only your changed fields.",
      "Sign-in & security shows your sign-in information, sessions, and available two-step verification controls.",
      "Look & behavior holds your color mode, reduced-motion choice, and keyboard shortcuts. Text size and density apply to this device.",
      "Regional holds your personal display preferences. Organization defaults remain in Manage.",
    ],
  },
} as const satisfies Record<string, PageGuide>;

export function pageGuideForNavigation(key: string | null): PageGuide | null {
  const page = key?.split(":")[0];
  return page && Object.hasOwn(PAGE_GUIDES, page)
    ? PAGE_GUIDES[page as keyof typeof PAGE_GUIDES]
    : null;
}
