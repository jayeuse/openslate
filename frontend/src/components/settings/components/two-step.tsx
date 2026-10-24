"use client";

import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { MfaPresentation, useMfaFlow } from "@/components/mfa-flow";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DialogFrameHeader,
  dialogFrameContentClass,
} from "@/components/ui/dialog-frame";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusWord } from "@/components/ui/status-word";
import { accessOwnMfaOptions } from "@/components/systems/access/adapters/access-queries";
import {
  useVerifiedWorkspaceUserId,
  useWorkspaceInteractionSuspended,
} from "@/components/systems/shared/runtime/workspace-identity";
import { twoStepWord } from "../domain/two-step";
import type { SettingsRegion } from "../hooks/use-settings-region";
import { FactValue } from "./rows";

/**
 * The Two-step row (PD11): a status word from one read on load (the read
 * Access Security uses for its own line), the flow's status once it has read
 * one for this account, and a quiet Manage… that opens the framed dialog.
 */
export function TwoStep({ region }: { region: SettingsRegion }) {
  const flow = useMfaFlow();
  const userId = useVerifiedWorkspaceUserId();
  const suspended = useWorkspaceInteractionSuspended();
  const opener = useRef<HTMLButtonElement | null>(null);
  const own = useQuery({
    ...accessOwnMfaOptions(userId),
    enabled: !suspended,
  });
  const status =
    flow.status?.user_id === userId ? flow.status : (own.data ?? null);
  const word = twoStepWord(status);
  return (
    <FactValue
      action={
        <Button
          ref={opener}
          type="button"
          variant="outline"
          aria-label="Manage two-step verification"
          className="min-h-11 xl:min-h-8"
          disabled={suspended || flow.pending || flow.mode !== "workspace"}
          onClick={flow.openManage}
        >
          Manage…
        </Button>
      }
    >
      <span data-testid="two-step-status" className="flex min-w-0">
        {own.isPending && !status ? (
          <Skeleton aria-label="Loading two-step status" className="h-4 w-12" />
        ) : (
          <StatusWord word={word.word} tone={word.tone} />
        )}
      </span>
      {own.isError && !status ? (
        <Button
          type="button"
          variant="ghost"
          aria-label="Retry two-step status"
          className="ml-1 min-h-11 xl:min-h-8"
          disabled={own.isFetching}
          onClick={() => void own.refetch()}
        >
          Retry
        </Button>
      ) : null}
      <Dialog
        open={flow.open && flow.mode === "workspace"}
        onOpenChange={(open) => {
          if (!open) flow.cancel();
        }}
      >
        <DialogContent
          className={`${dialogFrameContentClass} max-w-lg`}
          finalFocus={() =>
            opener.current?.isConnected ? opener.current : false
          }
        >
          <DialogFrameHeader
            title={<DialogTitle>Two-step verification</DialogTitle>}
            description={
              <DialogDescription>
                Ask your administrator if you need to recover your account.
              </DialogDescription>
            }
            closeLabel="Close two-step"
            onClose={flow.cancel}
          />
          {/* The steps and their actions belong to the shared presentation
              (Access and the sign-in gate use it too), so they stay in the
              body (PD40). */}
          <MfaPresentation flow={flow} region={region.display} />
        </DialogContent>
      </Dialog>
    </FactValue>
  );
}
