"use client";

import { ArrowRight, Layers, UserRound } from "lucide-react";

import { GuardedWorkspaceLink } from "@/components/workspace-navigation-guard";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { OrganizationTheme } from "@/lib/appearance-preferences";
import { WorkspaceLogo } from "../../shared/runtime/workspace-logo";
import {
  organizationLocaleLabel,
  type ManageWorkspaceProfile,
  type WorkspaceProfileFormFields,
  type WorkspaceProfileField,
} from "../adapters/workspace-api";
import { readableTimezone } from "@/lib/timezone-options";
import { OrganizationEditor } from "./organization-editor";
import { OrganizationFooter } from "./organization-footer";
import { OrganizationReader } from "./organization-reader";
import type { SettingsPanelForm } from "./panel-ui";

export type OrganizationLogoProps = {
  blob: Blob | null | undefined;
  concealed: boolean;
  selection: { kind: "none" | "removed" } | { kind: "selected"; name: string };
  error: string;
  notice: string;
  /** The logo upload waits for file capacity on the server. */
  waiting?: boolean;
  /** Settings saved, but the replaced logo file is not removed yet. */
  cleanupPending: boolean;
  onSelect: (file: File) => void;
  onRemove: () => void;
  onCheckUpload?: () => void;
  onRetryCleanup?: () => void;
  onRetryImage?: () => void;
};

type OrganizationPanelProps = {
  form: SettingsPanelForm;
  /** Changes in the draft, for the footer chip. */
  unsavedCount: number;
  /** A save landed but its readback failed; the draft waits for a fresh read. */
  checkingSaved: boolean;
  /** A save or load error for the footer; the page shows it otherwise. */
  saveError: string;
  regionalDate: string;
  regionalCurrency: string;
  workspace: ManageWorkspaceProfile | undefined;
  workspaceLoading: boolean;
  workspaceLoadFailed: boolean;
  onRetryWorkspace: () => void;
  staleRevision: boolean;
  theme: OrganizationTheme;
  onThemeChange: (theme: OrganizationTheme) => void;
  /** A verified account that cannot change the settings (MD5). */
  readOnly: boolean;
  editDisabled: boolean;
  /** A save is running: Save reads "Saving…" and keeps focus. */
  saving: boolean;
  profile: WorkspaceProfileFormFields | undefined;
  profileErrors: Partial<Record<WorkspaceProfileField, string>>;
  onProfileChange: (key: WorkspaceProfileField, value: string) => void;
  contactsVisible: boolean;
  /** Access People and the Sandbox open only for an administrator (MD3). */
  relatedAreasVisible: boolean;
  logo: OrganizationLogoProps;
};

/**
 * Manage › Organization (MD4): the settings panel and the preview. From
 * 1280px the page stays still; the settings body scrolls above its pinned
 * footer and the preview scrolls on its own. Below 1280px the page scrolls
 * and the preview follows the settings.
 */
export function OrganizationPanel({
  form,
  unsavedCount,
  checkingSaved,
  saveError,
  regionalDate,
  regionalCurrency,
  workspace,
  workspaceLoading,
  workspaceLoadFailed,
  onRetryWorkspace,
  staleRevision,
  theme,
  onThemeChange,
  readOnly,
  editDisabled,
  saving,
  profile,
  profileErrors,
  onProfileChange,
  contactsVisible,
  relatedAreasVisible,
  logo,
}: OrganizationPanelProps) {
  const { saveSection, current, changeSetting, errors, clearDraft } = form;
  const organizationName =
    !logo.concealed && workspace
      ? current.name.trim() || "Unnamed organization"
      : "Organization details unavailable";

  return (
    <div className="flex min-w-0 flex-col gap-4 xl:min-h-0 xl:flex-1">
      {workspaceLoadFailed ? (
        <Alert role="alert" variant="destructive">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p>The organization settings could not be loaded.</p>
              {workspace ? (
                <p className="text-muted-foreground text-sm">
                  Your last loaded settings are still shown.
                </p>
              ) : null}
            </div>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={onRetryWorkspace}
            >
              Retry organization settings
            </Button>
          </div>
        </Alert>
      ) : null}
      {staleRevision ? (
        <Alert variant="destructive">
          Organization settings changed. The latest values are loaded. Review
          your changes and save again.
        </Alert>
      ) : null}
      <div className="grid min-w-0 gap-4 xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(0,1fr)_21.25rem] xl:grid-rows-[minmax(0,1fr)]">
        <section
          aria-label="Organization settings"
          className="bg-card border-border flex min-w-0 flex-col rounded-[var(--radius)] border xl:min-h-0"
        >
          {readOnly ? (
            <div className="relative min-w-0 px-4 pb-2 sm:px-6 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:overscroll-contain">
              <OrganizationReader
                saved={current}
                workspace={workspace}
                theme={theme}
                profile={profile}
                contactsVisible={contactsVisible}
                logo={logo}
                organizationName={organizationName}
              />
            </div>
          ) : (
            <form
              className="flex min-w-0 flex-1 flex-col xl:min-h-0"
              onSubmit={(event) => {
                event.preventDefault();
                void saveSection("organization");
              }}
            >
              <div className="relative min-w-0 px-4 pb-2 sm:px-6 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:overscroll-contain">
                <OrganizationEditor
                  current={current}
                  errors={errors}
                  changeSetting={(key, value) =>
                    changeSetting("organization", key, value)
                  }
                  workspace={workspace}
                  workspaceLoading={workspaceLoading}
                  editDisabled={editDisabled}
                  theme={theme}
                  onThemeChange={onThemeChange}
                  profile={profile}
                  profileErrors={profileErrors}
                  onProfileChange={onProfileChange}
                  contactsVisible={contactsVisible}
                  logo={logo}
                  organizationName={organizationName}
                />
              </div>
              <OrganizationFooter
                unsavedCount={unsavedCount}
                checkingSaved={checkingSaved}
                saveLabel={
                  saving
                    ? "Saving…"
                    : staleRevision
                      ? "Save again"
                      : "Save settings"
                }
                saving={saving}
                saveError={saveError}
                disabled={editDisabled}
                onDiscard={() => clearDraft("organization")}
              />
            </form>
          )}
        </section>

        <aside className="min-w-0 xl:min-h-0 xl:overflow-y-auto xl:overscroll-contain">
          <OrganizationPreview
            workspace={workspace}
            organizationName={organizationName}
            current={current}
            regionalDate={regionalDate}
            regionalCurrency={regionalCurrency}
            logo={logo}
            relatedAreasVisible={relatedAreasVisible}
            live={!readOnly}
          />
        </aside>
      </div>
    </div>
  );
}

/** The live preview: the mark, the name, and the region as it will read. */
function OrganizationPreview({
  workspace,
  organizationName,
  current,
  regionalDate,
  regionalCurrency,
  logo,
  relatedAreasVisible,
  live,
}: {
  workspace: ManageWorkspaceProfile | undefined;
  organizationName: string;
  current: SettingsPanelForm["current"];
  regionalDate: string;
  regionalCurrency: string;
  logo: OrganizationLogoProps;
  relatedAreasVisible: boolean;
  /** An editor's preview follows the draft; a reader's shows the saved look. */
  live: boolean;
}) {
  return (
    <div
      role="region"
      aria-labelledby="manage-organization-preview-title"
      className="bg-card border-border min-w-0 rounded-[var(--radius)] border"
    >
      <div className="border-border flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b px-4 py-3">
        <h2
          id="manage-organization-preview-title"
          className="text-base font-semibold"
        >
          Preview
        </h2>
        {live ? (
          <p className="text-muted-foreground text-xs">Updates as you edit</p>
        ) : null}
      </div>
      <div className="grid gap-3 p-4">
        <div className="flex min-w-0 items-center gap-3">
          <WorkspaceLogo
            blob={logo.blob}
            name={organizationName}
            mark={current.logo}
            hidden={logo.concealed}
            className="size-11 rounded-[var(--radius)] text-sm"
          />
          <div className="min-w-0">
            <h3 className="font-semibold break-words">
              {workspace
                ? organizationName
                : "Organization details unavailable"}
            </h3>
            <p className="text-muted-foreground text-sm break-words">
              {workspace
                ? `${organizationLocaleLabel(current.locale)} · ${readableTimezone(current.timezone)}`
                : "Load the organization settings to preview them here."}
            </p>
          </div>
        </div>
        {logo.onRetryImage ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-fit"
            onClick={logo.onRetryImage}
          >
            Retry logo
          </Button>
        ) : null}
        <dl className="divide-border divide-y">
          {(
            [
              ["Date and time", regionalDate],
              ["Currency format", regionalCurrency],
              ["Working week", `${current.week} · ${current.hours}`],
            ] as const
          ).map(([label, value]) => (
            <div
              key={label}
              className="flex min-h-9 min-w-0 items-center justify-between gap-4 py-1.5"
            >
              <dt className="text-muted-foreground text-sm">{label}</dt>
              <dd className="min-w-0 text-right text-sm font-medium break-words tabular-nums">
                {workspace ? value : "Unavailable"}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      {relatedAreasVisible ? (
        <nav
          aria-label="Related workspace areas"
          className="divide-border border-border divide-y border-t"
        >
          {(
            [
              ["/access?view=people", UserRound, "People and groups"],
              ["/sandbox?section=build", Layers, "Sandbox"],
            ] as const
          ).map(([href, Icon, label]) => (
            <GuardedWorkspaceLink
              key={href}
              href={href}
              className="hover:bg-muted focus-visible:outline-ring flex min-h-11 items-center gap-2.5 px-4 text-sm outline-none focus-visible:outline-2 focus-visible:-outline-offset-2"
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">{label}</span>
              <ArrowRight
                className="text-muted-foreground size-4 shrink-0"
                aria-hidden="true"
              />
            </GuardedWorkspaceLink>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
