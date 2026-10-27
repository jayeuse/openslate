"use client";

import { useId, useState, type ReactNode } from "react";
import { useDraggable } from "@dnd-kit/core";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Plus,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  kanbanErrorMessage,
  type StageChanges,
} from "../adapters/board-kanban-api";
import {
  CHART_COLORS,
  type CardSort,
  type ChartColor,
  type KanbanStage,
} from "../adapters/board-kanban-schemas";
import { STARTER_STAGES, stageCount } from "../domain/kanban";
import { chartVar } from "./board-kanban-card";

/** The chart series by name: the name always stands beside the color (BR69). */
export const COLOR_NAMES: Record<ChartColor, string> = {
  "chart-1": "Blue",
  "chart-2": "Amber",
  "chart-3": "Green",
  "chart-4": "Purple",
  "chart-5": "Rose",
};
const SORT_NAMES: Record<CardSort, string> = {
  manual: "Manual",
  due: "Due date",
  newest: "Newest",
  title: "Title",
};

const headerClass =
  "flex h-11 w-full min-w-0 items-center gap-2 rounded-t-sm px-1.5 text-left text-sm shadow-[inset_0_-2px_0_var(--stage-color)] xl:h-8 data-[over]:shadow-[inset_0_-2px_0_var(--warn)]";

function HeaderFace({ stage, count }: { stage: KanbanStage; count: number }) {
  const shown = stageCount(count, stage.wipLimit);
  return (
    <>
      <span
        aria-hidden="true"
        className="size-[9px] shrink-0 rounded-full bg-[var(--stage-color)]"
      />
      <span className="min-w-0 truncate font-semibold">{stage.name}</span>
      <span
        className={cn(
          "text-muted-foreground ml-auto text-xs whitespace-nowrap tabular-nums",
          shown.over && "text-warn-text font-semibold",
        )}
      >
        {shown.text}
      </span>
    </>
  );
}

/**
 * A stage's header (BR61, BR67): the color dot, the name, and the count
 * with its WIP limit. Managers open the stage settings from it and drag it
 * to reorder the stages; everyone else reads it as text.
 */
export function StageHeader({
  stage,
  count,
  manage,
  canDrag,
  index,
  total,
  onChange,
  onMove,
  onArchive,
}: {
  stage: KanbanStage;
  count: number;
  manage: boolean;
  canDrag: boolean;
  index: number;
  total: number;
  onChange: (changes: StageChanges) => Promise<void>;
  onMove: (offset: -1 | 1) => void;
  onArchive: () => void;
}) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const { setNodeRef, listeners } = useDraggable({
    id: `stage:${stage.id}`,
    data: { type: "stage", stageId: stage.id },
    disabled: !manage || !canDrag,
  });
  const shown = stageCount(count, stage.wipLimit);
  if (!manage)
    return (
      <h3
        className={headerClass}
        data-over={shown.over ? "" : undefined}
        aria-label={`${stage.name}, ${shown.label}`}
      >
        <HeaderFace stage={stage} count={count} />
      </h3>
    );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            ref={setNodeRef}
            type="button"
            data-over={shown.over ? "" : undefined}
            aria-label={`${stage.name}, ${shown.label}. Stage settings`}
            className={cn(
              headerClass,
              "group/stage hover:bg-[color-mix(in_oklab,var(--ink)_5%,transparent)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus)]",
              canDrag && "cursor-grab",
            )}
            {...listeners}
          />
        }
      >
        <HeaderFace stage={stage} count={count} />
        {/* The cue that the header opens its settings: on hover, focus,
            while open, and always on a touch screen, which has no hover. */}
        <ChevronDown
          aria-hidden="true"
          className="text-muted-foreground size-3.5 shrink-0 opacity-0 transition-opacity duration-(--motion-fast) group-hover/stage:opacity-100 group-focus-visible/stage:opacity-100 group-aria-expanded/stage:opacity-100 motion-reduce:transition-none pointer-coarse:opacity-100"
        />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-labelledby={`${titleId}-title`}
        className="slim-ui w-72 gap-1 p-1.5"
      >
        <StageSettings
          titleId={`${titleId}-title`}
          stage={stage}
          count={count}
          index={index}
          total={total}
          onChange={onChange}
          onMove={onMove}
          onArchive={() => {
            setOpen(false);
            onArchive();
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

function StageSettings({
  titleId,
  stage,
  count,
  index,
  total,
  onChange,
  onMove,
  onArchive,
}: {
  titleId: string;
  stage: KanbanStage;
  count: number;
  index: number;
  total: number;
  onChange: (changes: StageChanges) => Promise<void>;
  onMove: (offset: -1 | 1) => void;
  onArchive: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(stage.name);
  const [wip, setWip] = useState(stage.wipLimit ? String(stage.wipLimit) : "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async (changes: StageChanges) => {
    // A save in flight locks the fields, which blurs the one that was
    // focused: that blur is not a second edit (one PATCH per Enter).
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onChange(changes);
    } catch (failure) {
      setError(kanbanErrorMessage(failure));
    } finally {
      setSaving(false);
    }
  };
  const saveName = () => {
    const next = name.trim();
    if (!next || next === stage.name) return setName(stage.name);
    void save({ name: next });
  };
  const saveWip = () => {
    const value = wip.trim() === "" ? null : Number(wip);
    if (
      value !== null &&
      (!Number.isInteger(value) || value < 1 || value > 999)
    )
      return setError("Use a whole number from 1 to 999, or leave it empty.");
    if (value === stage.wipLimit) return;
    void save({ wipLimit: value });
  };
  const over = stage.wipLimit !== null && count > stage.wipLimit;
  const row =
    "grid grid-cols-[5.25rem_minmax(0,1fr)] items-center gap-2 px-2 py-0.5";
  const action =
    "min-h-11 w-full justify-start gap-2 px-2 font-normal xl:min-h-8";
  return (
    <>
      <PopoverTitle id={titleId} className="px-2 pt-1 text-sm font-semibold">
        {stage.name} stage
      </PopoverTitle>
      <div className={row}>
        <label htmlFor={`${id}-name`} className="text-muted-foreground text-xs">
          Name
        </label>
        <Input
          id={`${id}-name`}
          value={name}
          maxLength={60}
          disabled={saving}
          className="min-h-11 xl:h-8 xl:min-h-8"
          onChange={(event) => setName(event.currentTarget.value)}
          onBlur={saveName}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              saveName();
            }
          }}
        />
      </div>
      <fieldset className={row}>
        <legend className="sr-only">Stage color</legend>
        <span aria-hidden="true" className="text-muted-foreground text-xs">
          Color
        </span>
        <span className="flex flex-wrap items-center gap-1">
          {[...CHART_COLORS, null].map((color) => {
            const label = color ? COLOR_NAMES[color] : "No color";
            const checked = stage.color === color;
            return (
              <label
                key={color ?? "none"}
                title={label}
                className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-full xl:size-6"
              >
                <input
                  type="radio"
                  name={`${id}-color`}
                  className="peer sr-only"
                  aria-label={label}
                  checked={checked}
                  disabled={saving}
                  onChange={() => void save({ color })}
                />
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-[18px] rounded-full peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--focus)]",
                    checked &&
                      "shadow-[0_0_0_2px_var(--popover),0_0_0_4px_var(--ink)]",
                    !color && "shadow-[inset_0_0_0_1.5px_var(--ink-muted)]",
                  )}
                  style={color ? { background: chartVar(color) } : undefined}
                />
              </label>
            );
          })}
          <span className="text-muted-foreground ml-1 text-xs">
            {stage.color ? COLOR_NAMES[stage.color] : "None"}
          </span>
        </span>
      </fieldset>
      <div className={row}>
        <label htmlFor={`${id}-wip`} className="text-muted-foreground text-xs">
          WIP limit
        </label>
        <Input
          id={`${id}-wip`}
          type="number"
          inputMode="numeric"
          min={1}
          max={999}
          placeholder="None"
          value={wip}
          disabled={saving}
          aria-describedby={over ? `${id}-over` : undefined}
          className="min-h-11 tabular-nums xl:h-8 xl:min-h-8"
          onChange={(event) => setWip(event.currentTarget.value)}
          onBlur={saveWip}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              saveWip();
            }
          }}
        />
      </div>
      {over ? (
        <p
          id={`${id}-over`}
          className="text-warn-text pb-1 pl-[6.25rem] text-xs"
        >
          {count} cards · {count - (stage.wipLimit ?? 0)} over the limit
        </p>
      ) : null}
      <div className={row}>
        <label htmlFor={`${id}-sort`} className="text-muted-foreground text-xs">
          Sort cards
        </label>
        <NativeSelect
          id={`${id}-sort`}
          value={stage.cardSort}
          disabled={saving}
          className="min-h-11 xl:min-h-8"
          onChange={(event) =>
            void save({ cardSort: event.currentTarget.value as CardSort })
          }
        >
          {(Object.keys(SORT_NAMES) as CardSort[]).map((sort) => (
            <NativeSelectOption key={sort} value={sort}>
              {SORT_NAMES[sort]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {error ? (
        <p role="alert" className="text-danger-text px-2 text-xs">
          {error}
        </p>
      ) : null}
      <div className="bg-border mx-0 my-1 h-px" />
      <Button
        type="button"
        variant="ghost"
        className={action}
        disabled={index === 0}
        onClick={() => onMove(-1)}
      >
        <ArrowLeft aria-hidden="true" className="text-muted-foreground" />
        Move left
      </Button>
      <Button
        type="button"
        variant="ghost"
        className={action}
        disabled={index === total - 1}
        onClick={() => onMove(1)}
      >
        <ArrowRight aria-hidden="true" className="text-muted-foreground" />
        Move right
      </Button>
      <div className="bg-border my-1 h-px" />
      <Button
        type="button"
        variant="ghost"
        className={action}
        onClick={onArchive}
      >
        <Archive aria-hidden="true" className="text-muted-foreground" />
        Archive stage…
        <span className="text-muted-foreground ml-auto text-xs tabular-nums">
          {count} {count === 1 ? "card" : "cards"}
        </span>
      </Button>
    </>
  );
}

/**
 * Archive stage asks once (BR61): its cards move to a chosen stage, or are
 * archived with it.
 */
export function ArchiveStageDialog({
  stage,
  count,
  others,
  onCancel,
  onConfirm,
}: {
  stage: KanbanStage | null;
  count: number;
  others: readonly KanbanStage[];
  onCancel: () => void;
  onConfirm: (
    cards: "move" | "archive",
    target: string | null,
  ) => Promise<void>;
}) {
  const id = useId();
  const [choice, setChoice] = useState<"move" | "archive">("move");
  const [target, setTarget] = useState<string>("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canMove = others.length > 0;
  const mode = canMove ? choice : "archive";
  const targetId = target || others[0]?.id || null;
  const close = () => {
    if (pending) return;
    setChoice("move");
    setTarget("");
    setError(null);
    onCancel();
  };
  return (
    <AlertDialog
      open={stage !== null}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <AlertDialogContent className="slim-ui">
        <AlertDialogHeader>
          <AlertDialogTitle>Archive {stage?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {count === 0
              ? "The stage leaves the board."
              : `Its ${count} ${count === 1 ? "card" : "cards"} move to another stage, or are archived with it.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {count > 0 && canMove ? (
          <fieldset className="mt-3 flex flex-col gap-2 text-sm">
            <legend className="sr-only">Its cards</legend>
            <label className="flex min-h-11 items-center gap-2 xl:min-h-8">
              <input
                type="radio"
                name={`${id}-cards`}
                checked={mode === "move"}
                onChange={() => setChoice("move")}
              />
              Move them to
              <NativeSelect
                aria-label="Stage for its cards"
                value={targetId ?? ""}
                disabled={mode !== "move"}
                className="min-h-11 w-44 xl:min-h-8"
                onChange={(event) => setTarget(event.currentTarget.value)}
              >
                {others.map((other) => (
                  <NativeSelectOption key={other.id} value={other.id}>
                    {other.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </label>
            <label className="flex min-h-11 items-center gap-2 xl:min-h-8">
              <input
                type="radio"
                name={`${id}-cards`}
                checked={mode === "archive"}
                onChange={() => setChoice("archive")}
              />
              Archive them too
            </label>
          </fieldset>
        ) : null}
        {error ? (
          <p role="alert" className="text-danger-text mt-2 text-sm">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 xl:min-h-8"
            disabled={pending}
            onClick={close}
          >
            Cancel
          </Button>
          <Button
            type="button"
            className="min-h-11 xl:min-h-8"
            disabled={pending}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                await onConfirm(mode, mode === "move" ? targetId : null);
                setChoice("move");
                setTarget("");
              } catch (failure) {
                setError(kanbanErrorMessage(failure));
              } finally {
                setPending(false);
              }
            }}
          >
            {pending ? "Archiving…" : "Archive stage"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** "Add a stage" at the end of the board (BR61); Enter adds, Escape closes. */
export function AddStage({
  onAdd,
  className,
}: {
  onAdd: (name: string) => Promise<void>;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    const next = name.trim();
    if (!next || pending) return;
    setPending(true);
    setError(null);
    try {
      await onAdd(next);
      setName("");
      setOpen(false);
    } catch (failure) {
      setError(kanbanErrorMessage(failure));
    } finally {
      setPending(false);
    }
  };
  if (!open)
    return (
      <button
        type="button"
        className={cn(
          "text-muted-foreground hover:text-foreground flex h-11 items-center justify-center gap-1.5 self-start rounded-md border-[1.5px] border-dashed border-[var(--rule-strong)] bg-[color-mix(in_oklab,var(--card)_40%,transparent)] px-3 text-sm hover:border-[var(--ink-muted)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--focus)] xl:h-8",
          className,
        )}
        onClick={() => setOpen(true)}
      >
        <Plus aria-hidden="true" className="size-4" />
        Add a stage
      </button>
    );
  return (
    <div className={cn("flex flex-col gap-1 self-start", className)}>
      <Input
        autoFocus
        aria-label="Stage name"
        placeholder="Stage name"
        value={name}
        maxLength={60}
        disabled={pending}
        className="min-h-11 xl:h-8 xl:min-h-8"
        onChange={(event) => setName(event.currentTarget.value)}
        onBlur={() => {
          if (!name.trim() && !pending) setOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void add();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setOpen(false);
            setName("");
          }
        }}
      />
      {error ? (
        <p role="alert" className="text-danger-text text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A board with no stages (BR80). A manager sees the three stages they can
 * start with, drawn where they will stand; others see who adds them.
 */
export function KanbanSetup({
  manage,
  onStart,
  addStage,
}: {
  manage: boolean;
  onStart: () => Promise<void>;
  addStage: ReactNode;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!manage)
    return (
      <div className="grid h-full min-h-60 place-content-center gap-1 p-6 text-center">
        <p data-slot="empty-title" className="font-semibold">
          No stages yet
        </p>
        <p className="text-muted-foreground text-sm">
          Board managers add stages.
        </p>
      </div>
    );
  return (
    <div className="flex h-full min-h-60 flex-col gap-4 p-3">
      <div
        className="grid min-h-0 flex-1 grid-cols-[repeat(3,minmax(0,17rem))] gap-2.5"
        aria-hidden="true"
      >
        {STARTER_STAGES.map(({ name, color }) => (
          <div
            key={name}
            className="flex flex-col gap-2 rounded-md border-[1.5px] border-dashed border-[var(--rule-strong)] p-2"
          >
            <span
              className="text-muted-foreground flex h-8 items-center gap-2 border-b-2 px-1 text-sm font-semibold"
              style={{ borderColor: chartVar(color) }}
            >
              <span
                className="size-[9px] rounded-full"
                style={{ background: chartVar(color) }}
              />
              {name}
            </span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          className="min-h-11 xl:min-h-8"
          disabled={pending}
          onClick={async () => {
            setPending(true);
            setError(null);
            try {
              await onStart();
            } catch (failure) {
              setError(kanbanErrorMessage(failure));
            } finally {
              setPending(false);
            }
          }}
        >
          {pending ? "Adding stages…" : "Start with To do · Doing · Done"}
        </Button>
        {addStage}
        {error ? (
          <p role="alert" className="text-danger-text text-sm">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
