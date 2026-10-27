"use client";

import { useId, useState, type ReactNode } from "react";
import { Check, Plus } from "lucide-react";
import { PersonAvatar } from "@/components/person-avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { SearchSelect } from "@/components/ui/search-select";
import { Select, SelectItem } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { WorkspaceRegion } from "@/lib/date-time";
import type {
  CardSheet,
  KanbanLabel,
  KanbanStage,
} from "../adapters/board-kanban-schemas";
import { shortDate } from "../domain/kanban";
import type { CardField, CardSheetModel } from "../hooks/use-card-sheet";
import { useAssigneePicker } from "../hooks/use-assignee-picker";
import { LabelChip, type KanbanPerson } from "./board-kanban-card";

const control = "min-h-11 xl:min-h-8";

/**
 * One label-left row of a card sheet (the slim grammar): a 128px muted
 * label column and the value or field on the right; phones stack them.
 */
export function SheetRow({
  label,
  htmlFor,
  children,
}: {
  label: string;
  /** The field's id; a read-only row has none. */
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-1 border-b py-2 last:border-b-0 sm:grid-cols-[8rem_minmax(0,1fr)] sm:items-center sm:gap-4">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="text-muted-foreground text-sm">
          {label}
        </label>
      ) : (
        <span className="text-muted-foreground text-sm">{label}</span>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
        {children}
      </div>
    </div>
  );
}

export type CardFieldContext = {
  model: CardSheetModel;
  sheet: CardSheet;
  canWrite: boolean;
  region: WorkspaceRegion;
  /** Managers: opens the board's Labels editor (BR70). */
  onCreateLabels?: () => void;
};

/**
 * A date that saves when it is left or Enter is pressed. While it is being
 * changed, a live refresh does not overwrite it; after the save, it shows
 * the card again.
 */
export function DateRow({
  label,
  field,
  value,
  context,
  onSave,
}: {
  label: string;
  field: CardField;
  value: string | null;
  context: CardFieldContext;
  onSave: (date: string | null) => Promise<boolean>;
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  if (!context.canWrite)
    return (
      <SheetRow label={label}>
        <span className="tabular-nums">
          {value ? shortDate(value, context.region) : "None"}
        </span>
      </SheetRow>
    );
  const commit = () => {
    if (draft === null) return;
    if (draft === (value ?? "")) return setDraft(null);
    void onSave(draft || null).finally(() => setDraft(null));
  };
  return (
    <SheetRow label={label} htmlFor={id}>
      <Input
        id={id}
        type="date"
        // "Add dates" on the Gantt opens the sheet on the first date field.
        data-card-dates={
          field === "start" || field === "cardStart" ? "" : undefined
        }
        className={cn(control, "max-w-48 tabular-nums")}
        value={draft ?? value ?? ""}
        disabled={context.model.saving === field}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          commit();
        }}
      />
    </SheetRow>
  );
}

/** The assignee: a person who can read the board, or no one. */
export function AssigneeRow({
  context,
  people,
}: {
  context: CardFieldContext;
  people: ReadonlyMap<string, KanbanPerson>;
}) {
  const current = context.sheet.card.assigneeId;
  const person = current ? people.get(current) : undefined;
  if (!context.canWrite)
    return (
      <SheetRow label="Assignee">
        {person ? (
          <>
            <PersonAvatar name={person.name} avatarUrl={person.avatarUrl} />
            <span>{person.name}</span>
          </>
        ) : (
          <span>{current ? "Someone" : "No one"}</span>
        )}
      </SheetRow>
    );
  return <AssigneePicker context={context} person={person} />;
}

/**
 * A writer's assignee field: the board's readers, searched on the server and
 * read 100 at a time, so a company board's long list stays usable.
 */
function AssigneePicker({
  context,
  person,
}: {
  context: CardFieldContext;
  person: KanbanPerson | undefined;
}) {
  const id = useId();
  const picker = useAssigneePicker(context.sheet.card.boardId);
  const current = context.sheet.card.assigneeId;
  const listed = picker.people.find((choice) => choice.id === current);
  return (
    <SheetRow label="Assignee" htmlFor={id}>
      <div className="w-full max-w-72 min-w-0">
        <SearchSelect
          id={id}
          label="Assignee"
          hideLabel
          value={current ?? ""}
          placeholder="No one"
          searchPlaceholder="Search people…"
          emptyMessage="No one by that name can read this board."
          options={[
            // "No one" is a choice only before a search narrows the list.
            ...(picker.search.trim() ? [] : [{ value: "", label: "No one" }]),
            ...picker.people.map((choice) => ({
              value: choice.id,
              label: choice.name,
            })),
          ]}
          // The placeholder names "No one"; an assignee off the loaded page
          // keeps their name on the trigger.
          selectedOption={
            current
              ? {
                  value: current,
                  label: listed?.name ?? person?.name ?? "Current assignee",
                }
              : undefined
          }
          search={picker.search}
          onSearchChange={picker.setSearch}
          loading={picker.loading}
          error={picker.error}
          onRetry={picker.retry}
          hasMore={picker.hasMore}
          onLoadMore={picker.loadMore}
          loadingMore={picker.loadingMore}
          disabled={context.model.saving === "assignee"}
          popupClassName="slim-ui"
          onValueChange={(value) => {
            if (value === (current ?? "")) return;
            void context.model.save("assignee", { assigneeId: value || null });
          }}
        />
      </div>
    </SheetRow>
  );
}

/** The card's labels; writers apply or remove the board's labels (BR70). */
export function LabelsRow({
  context,
  labels,
  labelMap,
}: {
  context: CardFieldContext;
  labels: readonly KanbanLabel[];
  labelMap: ReadonlyMap<string, KanbanLabel>;
}) {
  const applied = context.sheet.card.labelIds;
  const chips = applied.flatMap((labelId) => {
    const label = labelMap.get(labelId);
    return label ? [<LabelChip key={labelId} label={label} />] : [];
  });
  return (
    <SheetRow label="Labels">
      {chips.length > 0 ? (
        chips
      ) : (
        <span className="text-muted-foreground">None</span>
      )}
      {context.canWrite && labels.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                className={cn(control, "px-2")}
                aria-label={chips.length > 0 ? "Edit labels" : "Add labels"}
                disabled={context.model.saving === "labels"}
              />
            }
          >
            <Plus aria-hidden="true" data-icon="inline-start" />
            {chips.length > 0 ? "Edit" : "Add"}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="slim-ui min-w-48">
            {labels.map((label) => {
              const on = applied.includes(label.id);
              return (
                <DropdownMenuItem
                  key={label.id}
                  role="menuitemcheckbox"
                  aria-checked={on}
                  closeOnClick={false}
                  className={control}
                  onClick={() =>
                    void context.model.save("labels", {
                      labelIds: on
                        ? applied.filter((labelId) => labelId !== label.id)
                        : [...applied, label.id],
                    })
                  }
                >
                  <Check
                    aria-hidden="true"
                    className={cn(!on && "invisible")}
                  />
                  <LabelChip label={label} />
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {/* No label exists yet: a manager makes them here, not a dead end. */}
      {labels.length === 0 && context.onCreateLabels ? (
        <Button
          type="button"
          variant="ghost"
          className={cn(control, "px-2")}
          onClick={context.onCreateLabels}
        >
          <Plus aria-hidden="true" data-icon="inline-start" />
          Create labels
        </Button>
      ) : null}
    </SheetRow>
  );
}

/**
 * The description. An edit keeps the revision it began from (J6), so a
 * change another person saved meanwhile is refused, not overwritten.
 */
export function DescriptionField({ context }: { context: CardFieldContext }) {
  const id = useId();
  const saved = context.sheet.description ?? "";
  const [draft, setDraft] = useState<{ text: string; revision: number } | null>(
    null,
  );
  const changed = draft !== null && draft.text !== saved;
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-2">
      <h3 id={`${id}-title`} className="text-sm font-semibold">
        {context.canWrite ? (
          <label htmlFor={id}>Description</label>
        ) : (
          "Description"
        )}
      </h3>
      {context.canWrite ? (
        <>
          <Textarea
            id={id}
            maxLength={5000}
            className="min-h-20"
            placeholder="Add a description"
            value={draft?.text ?? saved}
            onChange={(event) => {
              const text = event.currentTarget.value;
              setDraft((current) => ({
                text,
                revision: current?.revision ?? context.sheet.card.revision,
              }));
            }}
          />
          {changed ? (
            <div className="flex gap-2">
              <Button
                type="button"
                className={control}
                disabled={context.model.saving === "description"}
                onClick={() =>
                  void context.model
                    .save(
                      "description",
                      { description: draft.text },
                      draft.revision,
                    )
                    .then((done) => {
                      if (done) setDraft(null);
                    })
                }
              >
                {context.model.saving === "description"
                  ? "Saving…"
                  : "Save description"}
              </Button>
              <Button
                type="button"
                variant="outline"
                className={control}
                onClick={() => setDraft(null)}
              >
                Cancel
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <p className="max-w-[65ch] text-sm leading-6 break-words whitespace-pre-wrap">
          {saved || <span className="text-muted-foreground">None</span>}
        </p>
      )}
    </section>
  );
}

/** A record card's stage on this board (BR64); a move changes only the board. */
export function StageRow({
  stageId,
  stages,
  canWrite,
  pending,
  onMove,
}: {
  stageId: string;
  stages: readonly KanbanStage[];
  canWrite: boolean;
  pending: boolean;
  onMove: (stage: KanbanStage) => void;
}) {
  const id = useId();
  const current = stages.find((stage) => stage.id === stageId);
  if (!canWrite)
    return (
      <SheetRow label="Stage">
        <span>{current?.name ?? "Unknown stage"}</span>
      </SheetRow>
    );
  return (
    <SheetRow label="Stage" htmlFor={id}>
      <Select
        id={id}
        className={cn(control, "xl:h-8")}
        value={stageId}
        disabled={pending}
        onValueChange={(value) => {
          const stage = stages.find((item) => item.id === value);
          if (stage && stage.id !== stageId) onMove(stage);
        }}
      >
        {stages.map((stage) => (
          <SelectItem key={stage.id} value={stage.id}>
            {stage.name}
          </SelectItem>
        ))}
      </Select>
    </SheetRow>
  );
}
