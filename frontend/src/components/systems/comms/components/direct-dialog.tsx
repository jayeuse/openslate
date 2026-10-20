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
import { useCommsClient } from "../state/client-context";

export function DirectDialog({
  onClose,
  select,
}: {
  onClose: () => void;
  select: (id: string) => void;
}) {
  const { live } = useCommsClient();
  const [search, setSearch] = useState("");
  const [labels, setLabels] = useState<Record<string, string>>({});
  const q = search.trim();
  const actor = useCommsRead("direct-creation-check", (client, signal) =>
    client.getChannelCreationCheck({ kind: "workspace" }, { signal }),
  );
  const choices = useCommsRead(
    `direct-candidates:${q}`,
    async (_client, signal) => {
      if (!q) return [];
      if (!live) throw new Error("Live candidate search is unavailable");
      return (
        await live.client.listDirectCandidates({ q, limit: 20 }, { signal })
      ).items;
    },
  );
  const { run, isPending } = useCommsCommands();
  const [group, setGroup] = useState(false),
    [selected, setSelected] = useState<string[]>([]),
    [name, setName] = useState(""),
    [error, setError] = useState("");
  const candidates =
    choices.data?.map((person) => ({
      id: person.user_id,
      name: person.display_name,
    })) ?? [];
  const pending = isPending("conversation:create");
  const canCreate =
    !!actor.data && !actor.error && actor.data.membership_role !== "guest";
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
                      .map((id) => labels[id])
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
        {actor.data?.membership_role === "guest" && (
          <Alert>Guests cannot start conversations.</Alert>
        )}
        {(choices.error || actor.error) && (
          <Alert role="alert" variant="destructive">
            {choices.error || actor.error}
            <Button
              className="min-h-11 sm:min-h-0"
              variant="outline"
              onClick={() => {
                choices.reload();
                actor.reload();
              }}
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
          search={search}
          onSearchChange={setSearch}
          label={group ? "Add person" : "Person"}
          value={group ? "" : (selected[0] ?? "")}
          selectedOption={
            !group && selected[0] && labels[selected[0]]
              ? { value: selected[0], label: labels[selected[0]] }
              : undefined
          }
          options={candidates
            .filter((person) => !group || !selected.includes(person.id))
            .map((person) => ({ value: person.id, label: person.name }))}
          onValueChange={(id) => {
            setLabels((current) => ({
              ...current,
              [id]:
                candidates.find((person) => person.id === id)?.name ??
                current[id] ??
                "Person",
            }));
            setSelected(group ? [...selected, id] : [id]);
          }}
          disabled={!canCreate || pending || (group && selected.length >= 49)}
          loading={!choices.data && choices.status === "loading"}
          emptyMessage={
            q ? "No eligible people match." : "Type a name to find people."
          }
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
                  <span>{labels[id] ?? "Person unavailable"}</span>
                  <Button
                    className="min-h-11 sm:min-h-0"
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${labels[id] ?? "person"}`}
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
