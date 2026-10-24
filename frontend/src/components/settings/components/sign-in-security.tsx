"use client";

import { useRef } from "react";
import Account from "@/components/systems/platform/components/account";
import { AccessMfaDialog } from "@/components/systems/access/components/security-dialogs";
import { useMfaFlow } from "@/components/mfa-flow";
import { Button } from "@/components/ui/button";
import { useWorkspaceInteractionSuspended } from "@/components/systems/shared/runtime/workspace-identity";
import EmailChange from "./email-change";

export default function SignInSecurity() {
  const flow = useMfaFlow();
  const opener = useRef<HTMLButtonElement | null>(null);
  const suspended = useWorkspaceInteractionSuspended();
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-muted-foreground max-w-prose text-sm">
          Manage your password, signed-in devices, and authenticator. Two-step
          verification can be optional or required by your organization.
        </p>
        <Button
          ref={opener}
          variant="outline"
          className="min-h-11"
          disabled={suspended || flow.pending || flow.mode !== "workspace"}
          onClick={flow.openManage}
        >
          Manage two-step verification
        </Button>
      </div>
      <EmailChange />
      <Account />
      <AccessMfaDialog opener={opener} />
    </div>
  );
}
