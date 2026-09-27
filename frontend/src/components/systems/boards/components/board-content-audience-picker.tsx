"use client";

import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  listBoardContentAudienceTargets,
  type BoardContentAudienceChoice,
  type BoardContentAudienceKind,
} from "../adapters/board-content-audience-api";

export type BoardContentAudienceSelection =
  | { kind: "everyone" | "author" }
  | {
      kind: BoardContentAudienceKind;
      targetId: string | null;
    };

type ChoiceState = {
  status: "idle" | "loading" | "ready" | "error";
  items: BoardContentAudienceChoice[];
  hasMore: boolean;
};

const emptyChoices: ChoiceState = {
  status: "idle",
  items: [],
  hasMore: false,
};

function isTargeted(
  selection: BoardContentAudienceSelection,
): selection is Extract<
  BoardContentAudienceSelection,
  { targetId: string | null }
> {
  return selection.kind !== "everyone" && selection.kind !== "author";
}

export function BoardContentAudiencePicker({
  boardId,
  selection,
  onChange,
  disabled = false,
}: {
  boardId: string;
  selection: BoardContentAudienceSelection;
  onChange: (next: BoardContentAudienceSelection) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [choices, setChoices] = useState<ChoiceState>(emptyChoices);
  const kind = isTargeted(selection) ? selection.kind : null;

  useEffect(() => {
    if (kind === null) return;
    let active = true;
    setChoices({ status: "loading", items: [], hasMore: false });
    void listBoardContentAudienceTargets(boardId, kind, search, offset)
      .then((page) => {
        if (active) setChoices({ status: "ready", ...page });
      })
      .catch(() => {
        if (active) setChoices({ status: "error", items: [], hasMore: false });
      });
    return () => {
      active = false;
    };
  }, [boardId, kind, search, offset]);

  const selectedTarget = isTargeted(selection) ? selection.targetId : null;
  const selectedIsListed = choices.items.some(
    (item) => item.id === selectedTarget,
  );
  return (
    <div className="space-y-3">
      <label
        className="block space-y-1 text-sm font-medium"
        htmlFor={`${id}-kind`}
      >
        Audience
      </label>
      <select
        data-slot="select"
        id={`${id}-kind`}
        className="border-input bg-background text-foreground focus-visible:outline-ring min-h-11 w-full rounded-md border px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2"
        value={selection.kind}
        disabled={disabled}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setSearch("");
          setOffset(0);
          setChoices(emptyChoices);
          if (next === "everyone" || next === "author")
            onChange({ kind: next });
          else if (next === "user" || next === "department")
            onChange({ kind: next, targetId: null });
        }}
      >
        <option value="everyone">Everyone with Board access</option>
        <option value="author">Only the author</option>
        <option value="user">A person</option>
        <option value="department">A department</option>
      </select>
      {kind !== null && (
        <div className="space-y-2">
          <label className="block text-sm font-medium" htmlFor={`${id}-search`}>
            Search {kind === "user" ? "people" : `${kind}s`}
          </label>
          <Input
            id={`${id}-search`}
            className="bg-background text-foreground min-h-11 rounded-md focus-visible:outline-offset-2"
            value={search}
            maxLength={100}
            disabled={disabled}
            onChange={(event) => {
              setSearch(event.currentTarget.value);
              setOffset(0);
            }}
          />
          <label className="block text-sm font-medium" htmlFor={`${id}-target`}>
            {kind === "user" ? "Person" : "Department"}
          </label>
          <select
            data-slot="select"
            id={`${id}-target`}
            className="border-input bg-background text-foreground focus-visible:outline-ring min-h-11 w-full rounded-md border px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2"
            value={selectedTarget ?? ""}
            disabled={disabled || choices.status !== "ready"}
            required
            onChange={(event) =>
              onChange({ kind, targetId: event.currentTarget.value || null })
            }
          >
            <option value="">Choose an active {kind}</option>
            {selectedTarget && !selectedIsListed && (
              <option value={selectedTarget}>
                Current target (not on this page)
              </option>
            )}
            {choices.items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          {choices.status === "loading" && (
            <p role="status">Loading choices…</p>
          )}
          {choices.status === "error" && (
            <p role="alert">
              Choices are unavailable. Try another search or refresh.
            </p>
          )}
          {choices.status === "ready" && choices.items.length === 0 && (
            <p role="status">No active choices on this page.</p>
          )}
          {choices.status === "ready" && (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 rounded-md text-sm"
                disabled={disabled || offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 25))}
              >
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 rounded-md text-sm"
                disabled={disabled || !choices.hasMore}
                onClick={() => setOffset(offset + 25)}
              >
                Next
              </Button>
            </div>
          )}
          <p className="text-muted-foreground text-xs">
            Selected people also need access to this Board.
          </p>
        </div>
      )}
    </div>
  );
}
