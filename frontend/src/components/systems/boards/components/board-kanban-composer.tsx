"use client";

import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, Plus, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { WorkspaceRegion } from "@/lib/date-time";
import { cn } from "@/lib/utils";
import { fieldsFirstPageOptions } from "../../openview/adapters/openview-queries";
import {
  platformSearchOptions,
  type PlatformSearchItem,
} from "../../platform/adapters/platform-search-api";
import {
  kanbanErrorMessage,
  readKanbanRecordValues,
} from "../adapters/board-kanban-api";
import {
  defaultCardDates,
  recordDateChoices,
  shortDate,
  type RecordDateChoice,
} from "../domain/kanban";

/**
 * Add a card (BR62), the Trello way: a title adds an objective; Find a
 * record searches the modules the person reads and adds a record card,
 * whose start and due come from the record's dates (BR63).
 */
export function KanbanComposer({
  stageName,
  region,
  onAddObjective,
  onAddRecord,
  onClose,
}: {
  stageName: string;
  region: WorkspaceRegion;
  onAddObjective: (title: string) => Promise<void>;
  onAddRecord: (input: {
    recordId: string;
    startOn: string | null;
    dueOn: string | null;
  }) => Promise<void>;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"title" | "find">("title");
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setPending(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (failure) {
      setError(kanbanErrorMessage(failure));
      return false;
    } finally {
      setPending(false);
    }
  }

  async function addTitle() {
    const next = title.trim();
    if (!next || pending) return;
    // The composer stays open for the next card.
    if (await run(() => onAddObjective(next))) setTitle("");
  }

  const errorLine = error ? (
    <p role="alert" className="text-danger-text text-xs">
      {error}
    </p>
  ) : null;
  if (mode === "find")
    return (
      <RecordFinder
        stageName={stageName}
        region={region}
        pending={pending}
        error={errorLine}
        onBack={() => {
          setError(null);
          setMode("title");
        }}
        onAdd={async (input) => {
          if (await run(() => onAddRecord(input))) setMode("title");
        }}
      />
    );
  return (
    <form
      className="flex min-w-0 flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        void addTitle();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !pending) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <Textarea
        autoFocus
        aria-label="Card title"
        placeholder="Card title"
        value={title}
        maxLength={200}
        disabled={pending}
        className="min-h-14 resize-none"
        onChange={(event) => setTitle(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void addTitle();
          }
        }}
      />
      {errorLine}
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <Button
          type="submit"
          className="min-h-11 xl:min-h-8"
          disabled={pending || !title.trim()}
        >
          {pending ? "Adding…" : "Add card"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Close without adding"
          className="size-11 xl:size-8"
          disabled={pending}
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 w-full xl:min-h-8"
          disabled={pending}
          onClick={() => setMode("find")}
        >
          <Search aria-hidden="true" />
          Find a record
        </Button>
      </div>
    </form>
  );
}

function RecordFinder({
  stageName,
  region,
  pending,
  error,
  onBack,
  onAdd,
}: {
  stageName: string;
  region: WorkspaceRegion;
  pending: boolean;
  error: React.ReactNode;
  onBack: () => void;
  onAdd: (input: {
    recordId: string;
    startOn: string | null;
    dueOn: string | null;
  }) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<PlatformSearchItem | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(text.trim()), 250);
    return () => clearTimeout(timer);
  }, [text]);
  const results = useQuery({
    ...platformSearchOptions(search, "record", 0),
    enabled: search.length > 0 && picked === null,
  });
  const found = (results.data?.items ?? []).filter((item) => item.can_open);
  if (picked)
    return (
      <RecordDates
        record={picked}
        stageName={stageName}
        region={region}
        pending={pending}
        error={error}
        onBack={() => setPicked(null)}
        onAdd={onAdd}
      />
    );
  return (
    <div
      className="flex min-w-0 flex-col gap-1.5"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onBack();
        }
      }}
    >
      <Input
        autoFocus
        type="search"
        aria-label="Find a record"
        placeholder="Find a record"
        maxLength={100}
        value={text}
        className="min-h-11 xl:h-8 xl:min-h-8"
        onChange={(event) => setText(event.currentTarget.value)}
      />
      <div role="status" className="text-muted-foreground text-xs">
        {search && results.isFetching
          ? "Searching…"
          : search && results.isError
            ? "Records could not be searched. Try again."
            : search && found.length === 0 && results.isSuccess
              ? "No records match."
              : ""}
      </div>
      {found.length > 0 ? (
        <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
          {found.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                aria-label={`${item.title}, ${item.context_label}`}
                className="hover:bg-muted flex min-h-11 w-full min-w-0 items-center gap-2 rounded-sm px-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-[var(--focus)] xl:min-h-8"
                onClick={() => setPicked(item)}
              >
                <FileText
                  aria-hidden="true"
                  className="text-muted-foreground size-3.5 shrink-0"
                />
                <span className="min-w-0 truncate font-medium">
                  {item.title}
                </span>
                <span className="text-muted-foreground ml-auto shrink-0 text-xs">
                  {item.context_label}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        className="min-h-11 self-start xl:min-h-8"
        onClick={onBack}
      >
        Type a title instead
      </Button>
    </div>
  );
}

/** The picked record, and its dates as the card's start and due. */
function RecordDates({
  record,
  stageName,
  region,
  pending,
  error,
  onBack,
  onAdd,
}: {
  record: PlatformSearchItem;
  stageName: string;
  region: WorkspaceRegion;
  pending: boolean;
  error: React.ReactNode;
  onBack: () => void;
  onAdd: (input: {
    recordId: string;
    startOn: string | null;
    dueOn: string | null;
  }) => Promise<void>;
}) {
  const id = useId();
  const moduleId = record.module_id ?? "";
  const fields = useQuery(fieldsFirstPageOptions(moduleId));
  const values = useQuery({
    queryKey: ["boards", "kanban", "record-dates", record.id],
    queryFn: () => readKanbanRecordValues(record.id),
  });
  const choices: RecordDateChoice[] =
    fields.data && values.data
      ? recordDateChoices(fields.data.items, values.data, region.timezone)
      : [];
  const defaults = defaultCardDates(choices);
  const [start, setStart] = useState<string | null | undefined>(undefined);
  const [due, setDue] = useState<string | null | undefined>(undefined);
  const startId = start === undefined ? defaults.start : start;
  const dueId = due === undefined ? defaults.due : due;
  const dateOf = (fieldId: string | null) =>
    choices.find((choice) => choice.fieldId === fieldId)?.date ?? null;
  const loading = fields.isPending || values.isPending;
  const startOn = dateOf(startId);
  const dueOn = dateOf(dueId);
  const invalid = startOn !== null && dueOn !== null && startOn > dueOn;
  const select = (
    label: "Start" | "Due",
    value: string | null,
    onChange: (next: string | null) => void,
  ) => (
    <div className="grid grid-cols-[3rem_minmax(0,1fr)] items-center gap-2">
      <label
        htmlFor={`${id}-${label}`}
        className="text-muted-foreground text-xs"
      >
        {label}
      </label>
      <NativeSelect
        id={`${id}-${label}`}
        value={value ?? ""}
        disabled={pending}
        className="min-h-11 xl:min-h-8"
        onChange={(event) => onChange(event.currentTarget.value || null)}
      >
        <NativeSelectOption value="">None</NativeSelectOption>
        {choices.map((choice) => (
          <NativeSelectOption key={choice.fieldId} value={choice.fieldId}>
            {choice.name} · {shortDate(choice.date, region)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  );
  return (
    <form
      className="flex min-w-0 flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (pending || loading || invalid) return;
        void onAdd({ recordId: record.id, startOn, dueOn });
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onBack();
        }
      }}
    >
      <p className="flex min-w-0 items-center gap-1.5 text-sm">
        <FileText
          aria-hidden="true"
          className="text-muted-foreground size-3.5 shrink-0"
        />
        <span className="min-w-0 truncate font-medium">{record.title}</span>
        <span className="text-muted-foreground shrink-0 text-xs">
          {record.context_label}
        </span>
      </p>
      {loading ? (
        <p role="status" className="text-muted-foreground text-xs">
          Reading the record’s dates…
        </p>
      ) : choices.length > 0 ? (
        <>
          {select("Start", startId, setStart)}
          {select("Due", dueId, setDue)}
        </>
      ) : null}
      <p
        className={cn(
          "text-muted-foreground text-xs",
          invalid && "text-danger-text",
        )}
        role={invalid ? "alert" : undefined}
      >
        {invalid
          ? "The start must not be after the due date."
          : `Moving this card changes only the board, never the record.`}
      </p>
      {error}
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="submit"
          className="min-h-11 xl:min-h-8"
          disabled={pending || loading || invalid}
        >
          <Plus aria-hidden="true" />
          {pending ? "Adding…" : "Add card"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 xl:min-h-8"
          disabled={pending}
          onClick={onBack}
        >
          Back
        </Button>
        <span className="sr-only">Adds to {stageName}</span>
      </div>
    </form>
  );
}
