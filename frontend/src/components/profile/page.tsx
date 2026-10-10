"use client";

import { PageHeader } from "@/components/page-header";
import Identity from "./components/identity";
import LookBehavior from "./components/look-behavior";
import Regional from "./components/regional";
import SignInSecurity from "./components/sign-in-security";
import { useCallback, useEffect, useState } from "react";
import { useUserPreferences } from "@/components/theme-provider";
import { useWorkspaceNavigationGuard } from "@/components/workspace-navigation-guard";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

const sections = [
  ["identity", "Identity"],
  ["security", "Sign-in & security"],
  ["look", "Look & behavior"],
  ["regional", "Regional"],
] as const;

export default function Profile() {
  const preference = useUserPreferences();
  const [identityState, setIdentityState] = useState({
    dirty: false,
    pending: false,
  });
  const [regionalDirty, setRegionalDirty] = useState(false);
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const dirty = identityState.dirty || regionalDirty;
  const pending = identityState.pending || preference.saving;
  useWorkspaceNavigationGuard(
    useCallback(
      (href, resume) => {
        if (href.startsWith("/profile#") || (!dirty && !pending)) return true;
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
  return (
    <div className="max-w-5xl space-y-8">
      <PageHeader
        title="Your profile"
        description="Your identity, sign-in security, and personal preferences. Organization settings stay in Manage."
      />
      <nav
        aria-label="Profile sections"
        className="flex flex-wrap gap-2 border-b pb-4"
      >
        {sections.map(([id, label]) => (
          <a
            key={id}
            href={`#${id}`}
            className="hover:bg-muted focus-visible:outline-ring inline-flex min-h-11 items-center rounded-md px-3 text-sm font-medium focus-visible:outline-2"
          >
            {label}
          </a>
        ))}
      </nav>
      {sections.map(([id, label]) => (
        <section
          key={id}
          id={id}
          aria-labelledby={`profile-heading-${id}`}
          className="scroll-mt-24 space-y-4"
        >
          <h2 id={`profile-heading-${id}`} className="text-lg font-semibold">
            {label}
          </h2>
          {id === "identity" ? (
            <Identity onStateChange={setIdentityState} />
          ) : id === "look" ? (
            <LookBehavior />
          ) : id === "regional" ? (
            <Regional onDirtyChange={setRegionalDirty} />
          ) : (
            <SignInSecurity />
          )}
        </section>
      ))}
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
    </div>
  );
}
