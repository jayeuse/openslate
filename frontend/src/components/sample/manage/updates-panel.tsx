"use client";
import { ArrowDownToLine, CheckCircle2, RotateCcw, Search } from "lucide-react";
import { type MouseEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { useManageController, ManageSettings } from "./state";
import { SectionHeading } from "./panel-ui";
type UpdatesPanelProps = {
  panelClass: string;
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
  panelClass,
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
    <section
      className="flex flex-col gap-3"
      aria-labelledby="manage-updates-heading"
    >
      <SectionHeading
        title="Updates"
        description="Review a release before making a local version change."
      />
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
        <Card className={panelClass}>
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">Stable channel</Badge>
              {settings.version === "1.5.0" ? (
                <Badge variant="success">Up to date</Badge>
              ) : null}
            </div>
            <CardTitle id="manage-updates-heading">
              Current version · {settings.version}
            </CardTitle>
            <CardDescription>
              Updates are simulated locally and never install software.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-11 self-start"
              onClick={async () => {
                const result = await manage.checkForUpdate();
                if (!result.ok) {
                  setError(result.message);
                  return;
                }
                setError("");
                setNotice(
                  result.available
                    ? "Release 1.5.0 is available."
                    : "Version is up to date.",
                );
              }}
            >
              <Search data-icon="inline-start" /> Check for updates
            </Button>
            {updateAvailable && settings.version !== "1.5.0" ? (
              <div className="bg-muted flex flex-col gap-3 rounded-lg p-4">
                <h3 className="font-semibold">1.5.0 · Available</h3>
                <p className="text-muted-foreground text-sm">
                  Refined navigation, improved report layouts and clearer
                  session controls.
                </p>
                <Button
                  type="button"
                  className="min-h-11 self-start"
                  onClick={startUpdate}
                >
                  <ArrowDownToLine data-icon="inline-start" /> Apply update
                </Button>
              </div>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              className="min-h-11 self-start"
              onClick={() => setShowChangelog((value) => !value)}
            >
              {showChangelog ? "Hide changelog" : "View changelog"}
            </Button>
            {showChangelog ? (
              <div className="border-t pt-4">
                <h3 className="font-semibold">1.5.0 release notes</h3>
                <ul className="text-muted-foreground mt-3 list-inside list-disc space-y-2 text-sm">
                  <li>Six-pillar workspace navigation</li>
                  <li>Mobile-friendly report inspectors</li>
                  <li>Improved session management clarity</li>
                </ul>
              </div>
            ) : null}
            {settings.previous ? (
              <Button
                type="button"
                variant="outline"
                className="min-h-11 self-start"
                onClick={rollbackUpdate}
              >
                <RotateCcw data-icon="inline-start" /> Roll back update
              </Button>
            ) : null}
          </CardContent>
        </Card>
        <Card className={panelClass}>
          <CardHeader>
            <CardTitle>Release history</CardTitle>
            <CardDescription>
              Local maintenance actions performed in this tab.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="flex flex-col gap-2">
              {history.map((item, index) => (
                <li key={`${item}-${index}`} className="flex gap-3 text-sm">
                  <CheckCircle2
                    className="text-muted-foreground mt-0.5 shrink-0"
                    aria-hidden="true"
                  />
                  <span>{item}</span>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
