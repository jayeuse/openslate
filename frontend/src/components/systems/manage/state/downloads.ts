import type { ManageSnapshot } from "./model";

export function downloadManageSnapshot(snapshot: ManageSnapshot): void {
  const blob = new Blob(
    [
      JSON.stringify(
        {
          format: "openslate.manage.sample",
          version: 1,
          scope:
            "Manage configuration only; excludes drafts, sessions, history and other workspace data",
          snapshot,
        },
        null,
        2,
      ),
    ],
    { type: "application/json" },
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${snapshot.id}.json`;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(url);
  }
}
