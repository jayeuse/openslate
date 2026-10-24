"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useUserPreferences } from "@/components/theme-provider";
import { useWorkspaceNavigationGuard } from "@/components/workspace-navigation-guard";
import { useAdmittedWorkspaceScope } from "@/components/systems/shared/runtime/workspace-identity";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import EmailChange from "./components/email-change";
import { AppearanceSection } from "./components/appearance";
import { IdentitySection } from "./components/identity";
import { IdentityFooter } from "./components/identity-footer";
import { PasswordDialog } from "./components/password-dialog";
import { PreferenceStatus } from "./components/preference-status";
import { SettingsPreview } from "./components/preview";
import { RegionalSection } from "./components/regional";
import {
  FactValue,
  focusReturn,
  SettingsRow,
  SettingsSection,
} from "./components/rows";
import { Sessions } from "./components/sessions";
import { TwoStep } from "./components/two-step";
import { useAccountSecurity } from "./hooks/use-account-security";
import { useIdentityEditor } from "./hooks/use-identity-editor";
import { useSettingsRegion } from "./hooks/use-settings-region";

/**
 * Account settings (PD9-PD15): everything the person edits about their own
 * account. From 1280px the page is still, with the settings panel and the
 * Preview side by side, and only the panels scroll; below it one column
 * scrolls with the frame. Identity saves through the pinned footer;
 * Appearance and Regional save at once.
 */
export default function AccountSettings() {
  const editor = useIdentityEditor();
  const security = useAccountSecurity();
  const region = useSettingsRegion();
  const preference = useUserPreferences();
  // The one preference status shows in the group changed last (PD43).
  const [statusGroup, setStatusGroup] = useState<"look" | "regional">("look");
  const [preferenceChanged, setPreferenceChanged] = useState(false);
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const passwordOpener = useRef<HTMLButtonElement | null>(null);
  const dirty = editor.dirty;
  const pending = editor.pending || preference.saving;
  useWorkspaceNavigationGuard(
    useCallback(
      (href, resume) => {
        if (href.startsWith("/settings#") || (!dirty && !pending)) return true;
        if (pending) return false;
        setLeaving(() => resume);
        return false;
      },
      [dirty, pending],
    ),
  );
  useEffect(() => {
    if (!dirty && !pending) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, pending]);
  const status = <PreferenceStatus changed={preferenceChanged} />;
  return (
    <SettingsFrame>
      <header className="shrink-0">
        <h1
          data-slot="page-title"
          className="text-2xl font-semibold tracking-tight sm:text-3xl"
        >
          Account settings
        </h1>
        <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
          Your name, sign-in, and personal preferences.
        </p>
      </header>
      <div className="grid min-w-0 gap-4 min-[1440px]:grid-cols-[minmax(0,1fr)_21.25rem] xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(0,1fr)_18.75rem] xl:grid-rows-[minmax(0,1fr)]">
        <section
          aria-label="Settings"
          data-slot="card"
          className="slim-ui bg-card border-border flex min-w-0 flex-col rounded-[var(--radius)] border xl:min-h-0"
        >
          <div
            data-settings-scroll
            className="relative min-w-0 px-4 pb-2 text-sm sm:px-6 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:overscroll-contain"
          >
            <IdentitySection editor={editor} email={<EmailChange />} />
            <SettingsSection id="security" title="Sign-in">
              <SettingsRow label="Password">
                <FactValue
                  action={
                    <Button
                      ref={passwordOpener}
                      type="button"
                      variant="outline"
                      aria-label="Change password"
                      className="min-h-11 xl:min-h-8"
                      // Waits while a session change runs (one at a time).
                      disabled={!security.accountId || security.busy}
                      onClick={() => security.password.setOpen(true)}
                    >
                      Change…
                    </Button>
                  }
                >
                  {/* "Last changed" shows only when the server sends it; it
                      does not yet. */}
                  {null}
                </FactValue>
              </SettingsRow>
              <SettingsRow label="Two-step">
                <TwoStep region={region} />
              </SettingsRow>
              <SettingsRow label="Sessions">
                <Sessions security={security} region={region} />
              </SettingsRow>
              <PasswordDialog
                security={security}
                finalFocus={() =>
                  focusReturn(passwordOpener.current, "security")()
                }
              />
            </SettingsSection>
            <AppearanceSection
              status={statusGroup === "look" ? status : null}
              onChange={() => {
                setStatusGroup("look");
                setPreferenceChanged(true);
              }}
            />
            <RegionalSection
              status={statusGroup === "regional" ? status : null}
              organizationZone={region.organizationZone}
              onChange={() => {
                setStatusGroup("regional");
                setPreferenceChanged(true);
              }}
            />
          </div>
          <IdentityFooter editor={editor} />
        </section>
        <SettingsPreview editor={editor} region={region} />
      </div>
      <AlertDialog
        open={leaving !== null}
        onOpenChange={(open) => {
          if (!open) setLeaving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Discard unsaved profile changes?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Your unsaved profile edits will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setLeaving(null)}
            >
              Keep editing
            </Button>
            <Button
              variant="destructive"
              className="min-h-11"
              onClick={() => {
                const resume = leaving;
                setLeaving(null);
                resume?.();
              }}
            >
              Discard changes
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsFrame>
  );
}

/**
 * The page declares its own layout (PD27, PD47): in the shell it cancels the
 * vertical padding of #main-content from 1280px and fills the viewport below
 * the header, as Manage does with its own padding; without an organization
 * it fills the viewport below "Your organizations". The shell gets no
 * pathname branch.
 */
function SettingsFrame({ children }: { children: ReactNode }) {
  const inShell = useAdmittedWorkspaceScope() !== null;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-4 sm:gap-5 xl:min-h-0 xl:overflow-hidden",
        inShell
          ? "xl:-my-7 xl:h-[calc(100dvh-3.5rem)] xl:py-3"
          : "xl:h-[calc(100dvh-7.25rem)]",
      )}
    >
      {children}
    </div>
  );
}
