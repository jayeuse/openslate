"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Search, Trash2 } from "lucide-react";
import { PersonAvatar } from "@/components/person-avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  DialogFrameHeader,
  dialogFrameContentClass,
} from "@/components/ui/dialog-frame";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { kanbanErrorMessage } from "../adapters/board-kanban-api";
import {
  CHART_COLORS,
  type ChartColor,
  type KanbanLabel,
} from "../adapters/board-kanban-schemas";
import {
  NO_FILTERS,
  hasCardFilters,
  type KanbanDue,
  type KanbanFilters,
  type KanbanGroup,
} from "../domain/kanban";
import { LabelChip, chartVar, type KanbanPerson } from "./board-kanban-card";
import { COLOR_NAMES } from "./board-kanban-stage";

const control = "min-h-11 xl:min-h-8";
const pick = cn(control, "gap-1.5 px-2.5 font-normal");
const DUE_NAMES: Record<KanbanDue, string> = {
  overdue: "Overdue",
  week: "This week",
};
const GROUP_NAMES: Record<KanbanGroup | "none", string> = {
  none: "None",
  assignee: "Assignee",
  label: "Label",
};
/** Avatars shown before "+n" (BR68). */
const PEOPLE_SHOWN = 4;

/**
 * The Kanban toolbar (BR68): Search, a people filter, Labels, Due, and
 * Group by. Filters are the viewer's own and live in the URL; managers
 * edit labels from the Labels menu (BR70).
 */
export function KanbanToolbar({
  filters,
  onFilters,
  people,
  labels,
  manage,
  phone,
  onEditLabels,
}: {
  filters: KanbanFilters;
  onFilters: (changes: Partial<KanbanFilters>) => void;
  people: readonly ({ id: string } & KanbanPerson)[];
  labels: readonly KanbanLabel[];
  manage: boolean;
  phone: boolean;
  onEditLabels: () => void;
}) {
  const shown = people.slice(0, PEOPLE_SHOWN);
  const rest = people.slice(PEOPLE_SHOWN);
  const togglePerson = (id: string) =>
    onFilters({ assignee: filters.assignee === id ? null : id });
  const chosenLabels = labels.filter((label) =>
    filters.labels.includes(label.id),
  );
  return (
    <div
      role="group"
      aria-label="Kanban filters"
      className="flex min-w-0 flex-wrap items-center gap-1.5"
    >
      <label className="relative block min-w-0 max-md:flex-1 md:w-48">
        <span className="sr-only">Search cards</span>
        <Search
          aria-hidden="true"
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
        />
        <Input
          type="search"
          maxLength={100}
          placeholder="Search cards"
          className={cn(control, "pl-8")}
          value={filters.search}
          onChange={(event) => onFilters({ search: event.currentTarget.value })}
        />
      </label>
      {/* Phones hide the other filters; a filtered link can still be cleared. */}
      {phone && hasCardFilters(filters) ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11 shrink-0"
          onClick={() => onFilters(NO_FILTERS)}
        >
          Clear filters
        </Button>
      ) : null}
      {!phone && people.length > 0 ? (
        <div
          role="group"
          aria-label="Filter by person"
          className="flex items-center pl-1"
        >
          {shown.map((person) => {
            const on = filters.assignee === person.id;
            return (
              <button
                key={person.id}
                type="button"
                aria-pressed={on}
                aria-label={person.name}
                title={person.name}
                className={cn(
                  "-ml-1.5 grid size-11 place-items-center rounded-full first:ml-0 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus)] xl:size-8",
                )}
                onClick={() => togglePerson(person.id)}
              >
                <PersonAvatar
                  name={person.name}
                  avatarUrl={person.avatarUrl}
                  className={cn(
                    "size-7 text-[10px] shadow-[0_0_0_2px_var(--background)]",
                    on &&
                      "shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--action)]",
                  )}
                />
              </button>
            );
          })}
          {rest.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    className={cn(
                      control,
                      "text-muted-foreground px-1.5 text-xs",
                    )}
                    aria-label={`${rest.length} more people`}
                  />
                }
              >
                +{rest.length}
              </DropdownMenuTrigger>
              <DropdownMenuContent className="slim-ui min-w-48">
                {rest.map((person) => (
                  <DropdownMenuItem
                    key={person.id}
                    role="menuitemradio"
                    aria-checked={filters.assignee === person.id}
                    className={control}
                    onClick={() => togglePerson(person.id)}
                  >
                    <Check
                      aria-hidden="true"
                      className={cn(
                        filters.assignee !== person.id && "invisible",
                      )}
                    />
                    {person.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      ) : null}
      {!phone ? (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button type="button" variant="outline" className={pick} />
              }
            >
              {chosenLabels.length === 0
                ? "Labels"
                : chosenLabels.length === 1
                  ? `Label: ${chosenLabels[0].name}`
                  : `Labels: ${chosenLabels.length}`}
              <ChevronDown
                aria-hidden="true"
                className="text-muted-foreground"
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="slim-ui min-w-52">
              {labels.length === 0 ? (
                <p className="text-muted-foreground px-2 py-1.5 text-sm">
                  No labels yet
                </p>
              ) : (
                labels.map((label) => {
                  const on = filters.labels.includes(label.id);
                  return (
                    <DropdownMenuItem
                      key={label.id}
                      role="menuitemcheckbox"
                      aria-checked={on}
                      closeOnClick={false}
                      className={control}
                      onClick={() =>
                        onFilters({
                          labels: on
                            ? filters.labels.filter((id) => id !== label.id)
                            : [...filters.labels, label.id],
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
                })
              )}
              {manage ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className={control} onClick={onEditLabels}>
                    Edit labels…
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
          <ChoiceMenu
            label={filters.due ? `Due: ${DUE_NAMES[filters.due]}` : "Due"}
            options={[
              ["any", "Any date"],
              ["overdue", DUE_NAMES.overdue],
              ["week", DUE_NAMES.week],
            ]}
            value={filters.due ?? "any"}
            onChange={(value) =>
              onFilters({ due: value === "any" ? null : (value as KanbanDue) })
            }
          />
          <span className="flex-1" />
          <ChoiceMenu
            label={
              <>
                <span className="text-muted-foreground">Group by:</span>
                <span className="font-medium">
                  {GROUP_NAMES[filters.group ?? "none"]}
                </span>
              </>
            }
            align="end"
            options={(["none", "assignee", "label"] as const).map((value) => [
              value,
              GROUP_NAMES[value],
            ])}
            value={filters.group ?? "none"}
            onChange={(value) =>
              onFilters({
                group: value === "none" ? null : (value as KanbanGroup),
              })
            }
          />
        </>
      ) : null}
    </div>
  );
}

function ChoiceMenu({
  label,
  options,
  value,
  align = "start",
  onChange,
}: {
  label: React.ReactNode;
  options: readonly (readonly [string, string])[];
  value: string;
  align?: "start" | "end";
  onChange: (value: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button type="button" variant="outline" className={pick} />}
      >
        {label}
        <ChevronDown aria-hidden="true" className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="slim-ui min-w-44">
        {options.map(([option, name]) => (
          <DropdownMenuItem
            key={option}
            role="menuitemradio"
            aria-checked={option === value}
            className={control}
            onClick={() => onChange(option)}
          >
            <Check
              aria-hidden="true"
              className={cn(option !== value && "invisible")}
            />
            {name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Edit labels… (managers, BR70): name, color, remove, and add. */
export function KanbanLabelsDialog({
  open,
  labels,
  onClose,
  onAdd,
  onChange,
  onRemove,
}: {
  open: boolean;
  labels: readonly KanbanLabel[];
  onClose: () => void;
  onAdd: (name: string, color: ChartColor) => Promise<void>;
  onChange: (
    label: KanbanLabel,
    changes: Partial<{ name: string; color: ChartColor }>,
  ) => Promise<void>;
  onRemove: (label: KanbanLabel) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const run = async (action: () => Promise<void>) => {
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
  };
  const nextColor = CHART_COLORS[labels.length % CHART_COLORS.length];
  return (
    <Dialog
      open={open}
      dismissible={!pending}
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogContent className={cn(dialogFrameContentClass, "max-w-lg")}>
        <DialogFrameHeader
          title={<DialogTitle>Labels</DialogTitle>}
          description={
            <p className="text-muted-foreground text-sm">
              Removing a label takes it off every card.
            </p>
          }
          closeLabel="Close labels"
          closeDisabled={pending}
          onClose={onClose}
        />
        <ul className="flex flex-col gap-1">
          {labels.map((label) => (
            <LabelRow
              key={`${label.id}:${label.revision}`}
              label={label}
              pending={pending}
              onChange={(changes) => run(() => onChange(label, changes))}
              onRemove={() => run(() => onRemove(label))}
            />
          ))}
        </ul>
        <form
          className="flex items-center gap-2"
          onSubmit={async (event) => {
            event.preventDefault();
            const next = name.trim();
            if (!next) return;
            if (await run(() => onAdd(next, nextColor))) setName("");
          }}
        >
          <Input
            aria-label="New label name"
            placeholder="New label"
            maxLength={40}
            value={name}
            disabled={pending}
            className={control}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          <Button
            type="submit"
            className={control}
            disabled={pending || !name.trim()}
          >
            Add label
          </Button>
        </form>
        {error ? (
          <p role="alert" className="text-danger-text text-sm">
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function LabelRow({
  label,
  pending,
  onChange,
  onRemove,
}: {
  label: KanbanLabel;
  pending: boolean;
  onChange: (
    changes: Partial<{ name: string; color: ChartColor }>,
  ) => Promise<boolean>;
  onRemove: () => Promise<boolean>;
}) {
  const [name, setName] = useState(label.name);
  const save = () => {
    const next = name.trim();
    if (!next || next === label.name) return setName(label.name);
    void onChange({ name: next });
  };
  return (
    <li className="flex min-h-11 flex-wrap items-center gap-2 xl:min-h-10">
      <Input
        aria-label={`Name of ${label.name}`}
        value={name}
        maxLength={40}
        disabled={pending}
        className={cn(control, "w-40")}
        onChange={(event) => setName(event.currentTarget.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            save();
          }
        }}
      />
      <fieldset className="flex items-center gap-1">
        <legend className="sr-only">Color of {label.name}</legend>
        {CHART_COLORS.map((color) => (
          <label
            key={color}
            title={COLOR_NAMES[color]}
            className="grid size-11 cursor-pointer place-items-center xl:size-6"
          >
            <input
              type="radio"
              name={`label-color-${label.id}`}
              className="peer sr-only"
              aria-label={COLOR_NAMES[color]}
              checked={label.color === color}
              disabled={pending}
              onChange={() => void onChange({ color })}
            />
            <span
              aria-hidden="true"
              className={cn(
                "size-[18px] rounded-full peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--focus)]",
                label.color === color &&
                  "shadow-[0_0_0_2px_var(--popover),0_0_0_4px_var(--ink)]",
              )}
              style={{ background: chartVar(color) }}
            />
          </label>
        ))}
      </fieldset>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={`Remove ${label.name}`}
        className="ml-auto size-11 xl:size-8"
        disabled={pending}
        onClick={() => void onRemove()}
      >
        <Trash2 aria-hidden="true" />
      </Button>
    </li>
  );
}

/** Phones (BR71): one stage at a time, picked from a scrolling segmented row. */
export function StageSwitcher({
  stages,
  current,
  onSelect,
  addStage,
}: {
  stages: readonly {
    id: string;
    name: string;
    color: string | null;
    count: string;
    over: boolean;
    label: string;
  }[];
  current: string | null;
  onSelect: (id: string) => void;
  /** Managers add a stage from the end of the row. */
  addStage?: ReactNode;
}) {
  const row = useRef<HTMLElement>(null);
  // The current stage's chip stays in view as the stage changes (a swipe).
  useEffect(() => {
    row.current
      ?.querySelector<HTMLElement>('[aria-current="true"]')
      ?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }, [current]);
  return (
    <nav
      ref={row}
      aria-label="Stages"
      className="bg-muted flex gap-0.5 overflow-x-auto rounded-md p-[3px]"
    >
      {stages.map((stage) => (
        <button
          key={stage.id}
          type="button"
          aria-current={stage.id === current ? "true" : undefined}
          aria-label={`${stage.name}, ${stage.label}`}
          className={cn(
            "text-muted-foreground inline-flex h-11 flex-none items-center gap-1.5 rounded-[calc(var(--radius)-2px)] px-3 whitespace-nowrap",
            stage.id === current &&
              "text-foreground bg-[var(--surface-raised)] font-medium shadow-[0_0_0_1px_var(--rule)]",
          )}
          onClick={() => onSelect(stage.id)}
        >
          <span
            aria-hidden="true"
            className="size-2 rounded-full"
            style={{ background: chartVar(stage.color) }}
          />
          {stage.name}
          <span
            className={cn(
              "tabular-nums",
              stage.over && "text-warn-text font-semibold",
            )}
          >
            {stage.count}
          </span>
        </button>
      ))}
      {addStage}
    </nav>
  );
}
