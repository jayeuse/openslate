"use client";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { SearchSelect } from "@/components/ui/search-select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import {
  useCommsCommands,
  useCommsRead,
  messageFromCommsError,
} from "../state/runtime";
import { complete } from "../state/workspace-view";

export function DirectDialog({
  onClose,
  select,
}: {
  onClose: () => void;
  select: (id: string) => void;
}) {
  const choices = useCommsRead("direct-candidates", async (client, signal) => {
    const [actor, candidates] = await Promise.all([
      client.getChannelCreationCheck({ kind: "workspace" }, { signal }),
      complete((offset) =>
        client.listDirectCandidates({ limit: 100, offset }, { signal }),
      ),
    ]);
    return { role: actor.membership_role, candidates };
  });
  const { run, isPending } = useCommsCommands();
  const [group, setGroup] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [name, setName] = useState(""),
    [error, setError] = useState("");
  const candidates =
    choices.data?.candidates.map((person) => ({
      id: person.user_id,
      name: person.display_name,
    })) ?? [];
  const pending = isPending("conversation:create");
  const canCreate =
    !!choices.data && !choices.error && choices.data.role !== "guest";
  async function submit() {
    if (
      !canCreate ||
      pending ||
      (group
        ? selected.length < 2 || selected.length > 49
        : selected.length !== 1)
    )
      return;
    try {
      const result = await run(
        "conversation:create",
        async (current, signal) =>
          group
            ? await current.createGroup(
                {
                  name:
                    name.trim() ||
                    selected
                      .map(
                        (id) =>
                          candidates.find((person) => person.id === id)?.name,
                      )
                      .filter(Boolean)
                      .join(", "),
                  participant_ids: [current.context.user_id, ...selected],
                },
                { signal },
              )
            : await current.findOrCreateDirect(
                { recipient_id: selected[0] },
                { signal },
              ),
      );
      select(result.data.id);
      onClose();
    } catch (failure) {
      setError(
        messageFromCommsError(
          failure,
          "The conversation could not be started. Your selection is still available.",
        ),
      );
    }
  }
  return (
    <Dialog
      open
      dismissible={!pending}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-sm:[&_button]:min-h-11 max-sm:[&_button]:min-w-11">
        <DialogTitle>Start direct message</DialogTitle>
        <DialogDescription>
          Choose people available for direct messages in this organization.
        </DialogDescription>
        <div className="my-4 flex gap-2">
          <Button
            className="min-h-11 sm:min-h-0"
            variant={!group ? "secondary" : "ghost"}
            onClick={() => {
              setGroup(false);
              setSelected([]);
            }}
            disabled={pending}
          >
            Direct message
          </Button>
          <Button
            className="min-h-11 sm:min-h-0"
            variant={group ? "secondary" : "ghost"}
            onClick={() => {
              setGroup(true);
              setSelected([]);
            }}
            disabled={pending}
          >
            Group message
          </Button>
        </div>
        {choices.data?.role === "guest" && (
          <Alert>Guests cannot start conversations.</Alert>
        )}
        {choices.error && (
          <Alert role="alert" variant="destructive">
            {choices.error}
            <Button
              className="min-h-11 sm:min-h-0"
              variant="outline"
              onClick={choices.reload}
            >
              Retry
            </Button>
          </Alert>
        )}
        {error && (
          <Alert role="alert" variant="destructive">
            {error}
          </Alert>
        )}
        {group && (
          <label className="mb-3 block text-sm">
            Group name
            <Input
              className="min-h-11 sm:min-h-0"
              aria-label="Group name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={pending}
            />
          </label>
        )}
        <SearchSelect
          label={group ? "Add person" : "Person"}
          value={group ? "" : (selected[0] ?? "")}
          options={candidates
            .filter((person) => !group || !selected.includes(person.id))
            .map((person) => ({ value: person.id, label: person.name }))}
          onValueChange={(id) => setSelected(group ? [...selected, id] : [id])}
          disabled={!canCreate || pending || (group && selected.length >= 49)}
          loading={!choices.data && choices.status === "loading"}
          emptyMessage="No eligible people match."
        />
        {group && (
          <>
            <p className="text-muted-foreground my-2 text-xs">
              You are included. Choose 2–49 other people.
            </p>
            <ul className="my-3 space-y-1">
              {selected.map((id) => (
                <li
                  key={id}
                  className="flex items-center justify-between text-sm"
                >
                  <span>
                    {candidates.find((person) => person.id === id)?.name ??
                      "Person unavailable"}
                  </span>
                  <Button
                    className="min-h-11 sm:min-h-0"
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${candidates.find((person) => person.id === id)?.name ?? "person"}`}
                    onClick={() =>
                      setSelected(selected.filter((value) => value !== id))
                    }
                    disabled={pending}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button
            className="min-h-11 sm:min-h-0"
            variant="outline"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            className="min-h-11 sm:min-h-0"
            onClick={() => void submit()}
            disabled={
              !canCreate ||
              pending ||
              (group ? selected.length < 2 : selected.length !== 1)
            }
          >
            {pending ? "Starting…" : "Start conversation"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
