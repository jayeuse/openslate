"use client";

import { useId, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { reportDone } from "@/lib/feedback";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DialogFrameFooter,
  DialogFrameHeader,
  dialogFrameContentClass,
} from "@/components/ui/dialog-frame";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  createBoard,
  type BoardManagementBoard,
} from "../adapters/board-management-api";
import {
  blankDraft,
  boardCreateForDraft,
  validDraft,
  type BoardManagementDraft,
} from "../domain/board-details";
import { ConfirmAction } from "./ui";

const control = "min-h-11 xl:min-h-8";

/**
 * New project board (BR30), for administrators from All boards: Name and
 * Description in the shared dialog frame. After Create the board opens with
 * Board settings on Access, where its groups are added.
 */
export function BoardNewProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (board: BoardManagementBoard) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<BoardManagementDraft>(blankDraft);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const pendingRef = useRef(false);
  const dirty = draft.name !== "" || draft.description !== "";
  const named = draft.name.trim().length > 0;

  function reset() {
    setDraft(blankDraft);
    setError(null);
  }

  function requestClose() {
    if (pendingRef.current) return;
    if (dirty) setDiscardOpen(true);
    else {
      reset();
      onOpenChange(false);
    }
  }

  async function create() {
    if (pendingRef.current || !validDraft(draft)) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const created = await createBoard(boardCreateForDraft(draft));
      reportDone("Board created.");
      reset();
      onOpenChange(false);
      onCreated(created);
    } catch (failure) {
      setError(
        failure instanceof ApiError && [401, 403].includes(failure.status)
          ? "Only an administrator can create a board."
          : "The board could not be created. Try again.",
      );
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <>
      <Dialog
        open={open}
        dismissible={!pending}
        onOpenChange={(next) => {
          if (!next) requestClose();
        }}
      >
        <DialogContent
          className={dialogFrameContentClass}
          initialFocus={() => document.getElementById(`${id}-name`)}
        >
          <DialogFrameHeader
            title={<DialogTitle>New project board</DialogTitle>}
            closeLabel="Close new project board"
            closeDisabled={pending}
            onClose={requestClose}
          />
          <form
            id={`${id}-form`}
            className="flex min-w-0 flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <fieldset
              disabled={pending}
              className="flex min-w-0 flex-col gap-4"
            >
              <Field>
                <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
                <Input
                  id={`${id}-name`}
                  value={draft.name}
                  maxLength={200}
                  required
                  autoComplete="off"
                  className="h-11"
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-description`}>
                  Description
                </FieldLabel>
                <Textarea
                  id={`${id}-description`}
                  value={draft.description}
                  maxLength={240}
                  onChange={(event) =>
                    setDraft({ ...draft, description: event.target.value })
                  }
                />
              </Field>
            </fieldset>
            {error ? <Alert variant="destructive">{error}</Alert> : null}
          </form>
          <DialogFrameFooter>
            <DialogFooter className="mt-0">
              <Button
                type="button"
                variant="outline"
                className={control}
                disabled={pending}
                onClick={requestClose}
              >
                Cancel
              </Button>
              <DisabledReason
                reason={named ? null : "Name the board first."}
                stable
              >
                <Button
                  type="submit"
                  form={`${id}-form`}
                  className={control}
                  disabled={pending}
                >
                  {pending ? "Creating…" : "Create board"}
                </Button>
              </DisabledReason>
            </DialogFooter>
          </DialogFrameFooter>
        </DialogContent>
      </Dialog>
      <ConfirmAction
        open={discardOpen}
        title="Discard the new board?"
        description="The name and description you typed will be lost."
        action="Discard"
        onCancel={() => setDiscardOpen(false)}
        onConfirm={() => {
          setDiscardOpen(false);
          reset();
          onOpenChange(false);
        }}
      />
    </>
  );
}
