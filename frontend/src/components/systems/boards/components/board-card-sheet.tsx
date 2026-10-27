"use client";

import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ListChecks,
  MoreHorizontal,
  X,
} from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { WorkspaceRegion } from "@/lib/date-time";
import { reportDone, reportError } from "@/lib/feedback";
import { cn } from "@/lib/utils";
import type {
  CardSheet,
  KanbanCard,
  KanbanLabel,
  KanbanStage,
} from "../adapters/board-kanban-schemas";
import { cardLink, cardMetaLine } from "../domain/card-sheet";
import { cardName } from "../domain/kanban";
import { useCardSheet, type CardSheetModel } from "../hooks/use-card-sheet";
import {
  AssigneeRow,
  DateRow,
  DescriptionField,
  LabelsRow,
  type CardFieldContext,
} from "./board-card-fields";
import { CardActivityList, CardChecklist } from "./board-card-checklist";
import { chartVar, type KanbanPerson } from "./board-kanban-card";
import { RecordCardSheetBody } from "./board-record-card-sheet";
import { ServerBoardAttachments } from "./server-backed-board-attachments";
import { ServerBoardRecordLinks } from "./server-backed-board-record-links";

const control = "min-h-11 xl:min-h-8";
const tab = "min-h-11 shrink-0 xl:min-h-8";

export type KanbanCardSheetProps = {
  boardId: string;
  /** The card the address names (`card=<id>`), or null when none is open. */
  cardId: string | null;
  /** The card as the board drew it, when it did. */
  listed: KanbanCard | null;
  canWrite: boolean;
  stages: readonly KanbanStage[];
  labels: readonly KanbanLabel[];
  labelMap: ReadonlyMap<string, KanbanLabel>;
  people: ReadonlyMap<string, KanbanPerson>;
  region: WorkspaceRegion;
  today: string;
  /** A move from the sheet; it saves at once, with no toast. */
  onMove: (card: KanbanCard, stage: KanbanStage) => Promise<KanbanCard | null>;
  /** Archive card: no question; the board's Undo toast (Four Moments Rule). */
  onArchive: (card: KanbanCard) => void;
  onClose: () => void;
  /** The Gantt's "Add dates": the sheet opens on the card's first date field. */
  focusDates?: boolean;
};

const DATES_FIELD = "[data-card-dates]";

/**
 * A card's sheet (BR64): an objective opens a right sheet in the record
 * sheet grammar; a record card opens the shared record sheet with "On this
 * board" first. Writers edit and readers read; a card the viewer cannot
 * open says so, with no Retry for a refusal (Role states). Phones show it
 * full screen (BR71).
 */
export function KanbanCardSheet(props: KanbanCardSheetProps) {
  const { boardId, cardId, listed, onClose } = props;
  const model = useCardSheet({ boardId, cardId, listed });
  const [editing, setEditing] = useState(false);
  const state = model.state;
  return (
    <Sheet
      open={cardId !== null}
      dismissible={!editing}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        className="slim-ui flex w-full max-w-none flex-col gap-0 overflow-hidden p-0 sm:w-[min(92vw,40rem)]"
        initialFocus={() =>
          (props.focusDates
            ? document.querySelector<HTMLElement>(DATES_FIELD)
            : null) ?? true
        }
        finalFocus={() =>
          (cardId
            ? document.querySelector<HTMLElement>(
                `[data-kanban-focus="${CSS.escape(cardId)}"]`,
              )
            : null) ?? true
        }
      >
        {state.kind === "ready" ? (
          <ReadySheet
            {...props}
            model={model}
            sheet={state.sheet}
            onEditingChange={setEditing}
          />
        ) : (
          <>
            <header className="flex shrink-0 items-start gap-3 border-b p-5 pr-3">
              <div className="min-w-0 flex-1">
                <SheetTitle className="text-lg leading-tight font-semibold">
                  {state.kind === "unavailable"
                    ? "This card is not available."
                    : state.kind === "error"
                      ? "This card could not be loaded."
                      : "Opening card"}
                </SheetTitle>
                <SheetDescription className="text-muted-foreground mt-1 text-sm">
                  {state.kind === "unavailable"
                    ? "It may have been removed, or you may not have access."
                    : state.kind === "error"
                      ? "Check your connection, then try again."
                      : "Loading the card."}
                </SheetDescription>
              </div>
              <CloseCard onClose={onClose} />
            </header>
            <div className="p-5">
              {state.kind === "error" ? (
                <Button
                  type="button"
                  variant="outline"
                  className={control}
                  onClick={state.retry}
                >
                  Retry
                </Button>
              ) : state.kind === "loading" ? (
                <div className="flex flex-col gap-3">
                  <Skeleton className="h-8 w-2/3" />
                  <Skeleton className="h-24" />
                </div>
              ) : null}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function CloseCard({
  onClose,
  disabled = false,
}: {
  onClose: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-11 shrink-0"
      aria-label="Close card"
      disabled={disabled}
      onClick={onClose}
    >
      <X aria-hidden="true" />
    </Button>
  );
}

function ReadySheet({
  model,
  sheet,
  onEditingChange,
  ...props
}: KanbanCardSheetProps & {
  model: CardSheetModel;
  sheet: CardSheet;
  onEditingChange: (editing: boolean) => void;
}) {
  const { boardId, canWrite, stages, region, today, onClose } = props;
  const card = sheet.card;
  const context: CardFieldContext = { model, sheet, canWrite, region };
  const stage = stages.find((item) => item.id === card.stageId) ?? null;
  const [moving, setMoving] = useState(false);
  // A sheet that opened loading has no date field yet: focus it once ready.
  const focusedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!props.focusDates || focusedFor.current === card.id) return;
    focusedFor.current = card.id;
    document.querySelector<HTMLElement>(DATES_FIELD)?.focus();
  }, [props.focusDates, card.id]);
  const move = async (target: KanbanStage) => {
    if (target.id === card.stageId || moving) return;
    setMoving(true);
    try {
      if (await props.onMove(card, target)) model.moved(target.name);
    } finally {
      setMoving(false);
    }
  };
  const archive = () => {
    props.onArchive(card);
    onClose();
  };
  const copyLink = (
    <DropdownMenuItem
      className={control}
      onClick={() => {
        void navigator.clipboard
          .writeText(cardLink(window.location.origin, boardId, card.id))
          .then(
            () => reportDone("Link copied"),
            () => reportError("Could not copy the link"),
          );
      }}
    >
      Copy link
    </DropdownMenuItem>
  );
  const feedback = (
    <>
      {model.problem ? (
        <Alert role="alert" variant="destructive">
          {model.problem}
        </Alert>
      ) : null}
      {/* Empty, it takes no room but stays a live region. */}
      <p role="status" className="text-muted-foreground text-sm empty:sr-only">
        {model.notice}
      </p>
    </>
  );

  if (card.record && !card.record.locked)
    return (
      <RecordCardSheetBody
        boardId={boardId}
        record={card.record}
        context={context}
        stages={stages}
        labels={props.labels}
        labelMap={props.labelMap}
        people={props.people}
        region={region}
        moving={moving}
        copyLink={copyLink}
        feedback={feedback}
        onMove={(target) => void move(target)}
        onArchive={archive}
        onClose={onClose}
        onEditingChange={onEditingChange}
      />
    );

  const meta = cardMetaLine(card, stage?.name ?? null, region, today);
  return (
    <>
      {/* Phones put the actions on a row above the title, so it keeps
          the whole width (BR71). */}
      <header className="flex shrink-0 flex-wrap items-start gap-x-3 gap-y-1 border-b p-5 pr-3 sm:flex-nowrap">
        <div className="order-2 min-w-0 flex-1 basis-full sm:order-none sm:basis-auto">
          <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <ListChecks aria-hidden="true" className="size-3.5" />
            Objective
          </p>
          {canWrite ? (
            <>
              <SheetTitle className="sr-only">{cardName(card)}</SheetTitle>
              <TitleField context={context} />
            </>
          ) : (
            <SheetTitle className="mt-1 text-lg leading-tight font-semibold wrap-anywhere">
              {cardName(card)}
            </SheetTitle>
          )}
          <SheetDescription className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-1.5 text-sm">
            {stage ? (
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full"
                style={{ background: chartVar(stage.color) }}
              />
            ) : null}
            {/* One line of text: "Doing · Due Oct 30"; late is in warn. */}
            <span className="tabular-nums">
              {meta.stage}
              {meta.stage && meta.due ? " · " : ""}
              {meta.late ? (
                <span className="text-warn-text">{meta.due}</span>
              ) : (
                meta.due
              )}
            </span>
          </SheetDescription>
        </div>
        <div className="order-1 ml-auto flex shrink-0 items-center gap-1 sm:order-none sm:ml-0">
          {canWrite ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="outline"
                    className={cn(control, "gap-1.5")}
                    disabled={moving}
                  />
                }
              >
                Move to stage
                <ChevronDown aria-hidden="true" data-icon="inline-end" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="slim-ui min-w-48">
                {stages.map((item) => (
                  <DropdownMenuItem
                    key={item.id}
                    role="menuitemradio"
                    aria-checked={item.id === card.stageId}
                    className={control}
                    onClick={() => void move(item)}
                  >
                    <Check
                      aria-hidden="true"
                      className={cn(item.id !== card.stageId && "invisible")}
                    />
                    {item.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-11"
                  aria-label="More card actions"
                />
              }
            >
              <MoreHorizontal aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="slim-ui min-w-48">
              {copyLink}
              {canWrite ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className={control} onClick={archive}>
                    Archive card
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
          <CloseCard onClose={onClose} />
        </div>
      </header>
      <Tabs
        defaultValue="details"
        className="min-h-0 flex-1 gap-0"
        onValueChange={(value) => {
          if (canWrite && (value === "files" || value === "links"))
            model.loadVersions();
        }}
      >
        <div className="shrink-0 border-b px-5 py-3">
          <TabsList
            aria-label="Card sections"
            className="max-w-full flex-nowrap justify-start overflow-x-auto"
          >
            <TabsTrigger value="details" className={tab}>
              Details
            </TabsTrigger>
            <TabsTrigger value="files" className={tab}>
              Files
            </TabsTrigger>
            <TabsTrigger value="links" className={tab}>
              Linked records
            </TabsTrigger>
            <TabsTrigger value="activity" className={tab}>
              Activity
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent
          value="details"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-3"
        >
          <div className="flex flex-col gap-5">
            {feedback}
            <div>
              <AssigneeRow context={context} people={props.people} />
              <DateRow
                label="Start"
                field="start"
                value={card.startOn}
                context={context}
                onSave={(date) => model.save("start", { startOn: date })}
              />
              <DateRow
                label="Due"
                field="due"
                value={card.dueOn}
                context={context}
                onSave={(date) => model.save("due", { dueOn: date })}
              />
              <LabelsRow
                context={context}
                labels={props.labels}
                labelMap={props.labelMap}
              />
            </div>
            <DescriptionField context={context} />
            <CardChecklist context={context} />
          </div>
        </TabsContent>
        <TabsContent
          value="files"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-3"
        >
          {canWrite ? (
            model.versions ? (
              <ServerBoardAttachments
                access="edit"
                target={{ kind: "card", boardId, contentId: card.id }}
                versions={model.versions}
                refreshVersions={model.refreshVersions}
                onBusyChange={() => undefined}
              />
            ) : (
              <p className="text-muted-foreground text-sm">Loading files…</p>
            )
          ) : (
            <ServerBoardAttachments
              access="read"
              target={{ kind: "card", boardId, contentId: card.id }}
            />
          )}
        </TabsContent>
        <TabsContent
          value="links"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-3"
        >
          {canWrite ? (
            model.versions ? (
              <ServerBoardRecordLinks
                access="edit"
                target={{ kind: "card", boardId, contentId: card.id }}
                versions={model.versions}
                refreshVersions={model.refreshVersions}
              />
            ) : (
              <p className="text-muted-foreground text-sm">
                Loading linked records…
              </p>
            )
          ) : (
            <ServerBoardRecordLinks
              access="read"
              target={{ kind: "card", boardId, contentId: card.id }}
            />
          )}
        </TabsContent>
        <TabsContent
          value="activity"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-3"
        >
          <CardActivityList
            boardId={boardId}
            cardId={card.id}
            region={region}
          />
        </TabsContent>
      </Tabs>
    </>
  );
}

/**
 * The objective's title, edited in place; it keeps the revision it began
 * from, and an empty title puts the saved one back.
 */
function TitleField({ context }: { context: CardFieldContext }) {
  const card = context.sheet.card;
  const saved = card.title ?? "";
  const [draft, setDraft] = useState<{ text: string; revision: number } | null>(
    null,
  );
  const commit = () => {
    if (!draft) return;
    const text = draft.text.trim();
    if (!text || text === saved) return setDraft(null);
    void context.model
      .save("title", { title: text }, draft.revision)
      .finally(() => setDraft(null));
  };
  return (
    <Input
      aria-label="Card title"
      maxLength={200}
      className="hover:border-input -mx-2 mt-0.5 h-auto min-h-11 border-transparent bg-transparent px-2 py-1 text-lg leading-tight font-semibold shadow-none xl:min-h-9"
      value={draft?.text ?? saved}
      disabled={context.model.saving === "title"}
      onChange={(event) => {
        const text = event.currentTarget.value;
        setDraft((current) => ({
          text,
          revision: current?.revision ?? card.revision,
        }));
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
        if (event.key === "Escape" && draft) {
          event.preventDefault();
          event.stopPropagation();
          setDraft(null);
        }
      }}
    />
  );
}
