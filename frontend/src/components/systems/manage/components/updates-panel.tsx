"use client";

import { ArrowRight, CheckCircle2, RotateCcw, Search } from "lucide-react";
import { type MouseEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ManageSettings, useManageController } from "../state/state";

type UpdatesPanelProps = {
  settings: ManageSettings;
  actions: {
    manage: Pick<ReturnType<typeof useManageController>, "checkForUpdate">;
    setError: import("react").Dispatch<import("react").SetStateAction<string>>;
    setNotice: import("react").Dispatch<import("react").SetStateAction<string>>;
    startUpdate: () => void;
    setShowChangelog: import("react").Dispatch<
      import("react").SetStateAction<boolean>
    >;
    rollbackUpdate: (event: MouseEvent<HTMLElement>) => void;
  };
  updateAvailable: boolean;
  showChangelog: boolean;
  history: string[];
};

export function UpdatesPanel({
  settings,
  actions,
  updateAvailable,
  showChangelog,
  history,
}: UpdatesPanelProps) {
  const {
    manage,
    setError,
    setNotice,
    startUpdate,
    setShowChangelog,
    rollbackUpdate,
  } = actions;

  return (
    <section className="min-w-0 p-6" aria-labelledby="manage-updates-heading">
      <div className="flex flex-col gap-5">
        <h2
          id="manage-updates-heading"
          className="text-xl font-semibold tracking-tight"
        >
          Software version
        </h2>

        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">Stable channel</Badge>
          {settings.version === "1.5.0" ? (
            <Badge variant="success">Up to date</Badge>
          ) : null}
        </div>

        <div className="border-border border-b pb-5">
          <p className="text-muted-foreground text-sm">Current version</p>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <p className="text-4xl font-semibold tabular-nums">
              {settings.version}
            </p>
            <span className="text-muted-foreground text-sm">
              Sample version
            </span>
          </div>
        </div>

        {updateAvailable && settings.version !== "1.5.0" ? (
          <Alert variant="warning" role="status">
            <p className="font-medium">Version 1.5.0 is available</p>
            <p className="text-sm">
              Preview the changes before applying this sample update.
            </p>
            <p className="mt-2 text-sm">
              Refined navigation, improved report layouts, and clearer session
              controls.
            </p>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          {updateAvailable && settings.version !== "1.5.0" ? (
            <Button type="button" className="min-h-11" onClick={startUpdate}>
              Review update <ArrowRight data-icon="inline-end" />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={async () => {
              const result = await manage.checkForUpdate();
              if (!result.ok) {
                setError(result.message);
                return;
              }
              setError("");
              setNotice(result.available ? "" : "Version is up to date.");
            }}
          >
            <Search data-icon="inline-start" /> Check for updates
          </Button>
          {settings.previous ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={rollbackUpdate}
            >
              <RotateCcw data-icon="inline-start" /> Roll back update
            </Button>
          ) : null}
        </div>

        <p className="text-muted-foreground text-sm">
          No software is installed from this preview.
        </p>

        <div className="flex flex-col items-start gap-2">
          <Button
            type="button"
            variant="ghost"
            className="min-h-11 px-0 underline underline-offset-4"
            onClick={() => setShowChangelog((value) => !value)}
          >
            {showChangelog ? "Hide changelog" : "View changelog"}
          </Button>
          {showChangelog ? (
            <div className="w-full border-t pt-4">
              <h3 className="font-semibold">1.5.0 release notes</h3>
              <ul className="text-muted-foreground mt-3 list-inside list-disc space-y-2 text-sm">
                <li>Six-pillar workspace navigation</li>
                <li>Mobile-friendly report inspectors</li>
                <li>Improved session management clarity</li>
              </ul>
            </div>
          ) : null}
        </div>

        <div className="border-border border-t pt-5">
          <h3 className="font-semibold">Release history</h3>
          <ol className="mt-3 flex flex-col gap-3">
            {history.map((item, index) => (
              <li key={`${item}-${index}`} className="flex gap-3 text-sm">
                <CheckCircle2
                  className="text-muted-foreground mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                <span>{item}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
