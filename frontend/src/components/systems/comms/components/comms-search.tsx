"use client";

import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import {
  Dialog,
  DialogCloseButton,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadingRegion } from "@/components/ui/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import { searchRequestSchema } from "../contract/schemas";
import type { SearchHit, SearchRequest } from "../contract/types";
import { useCommsClient } from "../state/client-context";
import { useCommsRead } from "../state/runtime";
import { useCommsWorkspaceView } from "../state/use-comms-workspace";
import type { NavigationState } from "../state/use-comms-navigation";
import { CommsSearchResults } from "./comms-search-results";

type Filters = {
  who: string;
  where: string;
  on: string;
  after: string;
  before: string;
  has: string;
  is: string;
};
type Chip = "Who" | "What" | "When" | "Where" | "Has" | "Is";

export default function CommsSearch({
  open,
  onOpenChange,
  query,
  onQueryChange,
  returnFocus,
  navigation,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (value: string) => void;
  returnFocus: () => HTMLElement | false;
  navigation: NavigationState;
}) {
  const binding = useCommsClient();
  const workspace = useCommsWorkspaceView();
  const metadata =
    workspace.client === binding.client &&
    !binding.error &&
    !binding.scope?.isRefused()
      ? workspace
      : undefined;
  const rooms =
    metadata?.bootstrap?.conversations.map(({ conversation }) => ({
      id: conversation.id,
      name:
        conversation.kind === "channel"
          ? conversation.name
          : (metadata.directs.find((row) => row.id === conversation.id)?.user ??
            "Private conversation"),
    })) ?? [];
  const people = metadata?.people ?? [];
  const current = rooms.find((room) => room.id === navigation.selected);
  const defaults = (): Filters => ({
    who: "",
    where: current ? "current" : "all",
    on: "",
    after: "",
    before: "",
    has: "",
    is: "",
  });
  const [filters, setFilters] = useState<Filters>(defaults);
  const [editor, setEditor] = useState<Chip | null>(null);
  const [request, setRequest] = useState<SearchRequest | null>(null);
  const [validation, setValidation] = useState("");
  const [target, setTarget] = useState<{
    conversation: string;
    message: string;
  }>();
  const id = useId();
  const criteria = searchRequestSchema.safeParse({
    q: query,
    from: filters.who || undefined,
    in:
      filters.where === "current"
        ? current?.id
        : filters.where === "all"
          ? undefined
          : filters.where,
    on: filters.on || undefined,
    after: filters.after || undefined,
    before: filters.before || undefined,
    has: filters.has || undefined,
    is: filters.is || undefined,
    limit: 25,
    offset: 0,
  });
  // Both query entries share these normalized criteria; pagination is not a filter.
  const activeRequest =
    request &&
    criteria.success &&
    JSON.stringify({ ...request, offset: 0 }) === JSON.stringify(criteria.data)
      ? request
      : null;
  const key = activeRequest
    ? `search:${JSON.stringify(activeRequest)}`
    : "search:idle";
  const results = useCommsRead(
    key,
    (client, signal) => client.search(activeRequest ?? {}, { signal }),
    open && !!activeRequest,
  );
  const data = activeRequest && !results.error ? results.data : undefined;

  function change(key: keyof Filters, value: string) {
    setFilters((previous) => ({ ...previous, [key]: value }));
    setRequest(null);
    setValidation("");
  }
  function submit() {
    if (!criteria.success) {
      setValidation(
        "Check the filters. Choose an After date before the Before date.",
      );
      setRequest(null);
      return;
    }
    setValidation("");
    if (JSON.stringify(request) === JSON.stringify(criteria.data))
      results.reload();
    else setRequest(criteria.data);
  }

  // A slow history read must receive its highlight after the article materializes,
  // not consume the highlight's lifetime while only a loading region is visible.
  const selected = navigation.selected,
    messageId = navigation.messageId;
  const setHighlightedId = navigation.setHighlightedId;
  useEffect(() => {
    if (
      !target ||
      selected !== target.conversation ||
      messageId !== target.message
    )
      return;
    let clear: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => reveal());
    const deadline = setTimeout(() => {
      observer.disconnect();
      setTarget(undefined);
    }, 10_000);
    function reveal() {
      const article = document.getElementById(target!.message);
      if (clear || !article?.getClientRects().length) return;
      observer.disconnect();
      clearTimeout(deadline);
      setHighlightedId(target!.message);
      clear = setTimeout(() => {
        setHighlightedId((value) => (value === target!.message ? "" : value));
        setTarget(undefined);
      }, 2500);
    }
    observer.observe(document.body, { childList: true, subtree: true });
    reveal();
    return () => {
      observer.disconnect();
      clearTimeout(deadline);
      if (clear) clearTimeout(clear);
    };
  }, [target, selected, messageId, setHighlightedId]);

  function openHit(hit: SearchHit) {
    const thread = hit.parent_id
      ? metadata?.threads.find(
          (row) =>
            row.messageId === hit.parent_id &&
            row.conversation === hit.conversation_id,
        )
      : undefined;
    setTarget({ conversation: hit.conversation_id, message: hit.message_id });
    navigation.setSearch("");
    navigation.navigate(hit.conversation_id, {
      message: hit.message_id,
      thread: thread?.id ?? null,
      panel: hit.parent_id ? "thread" : null,
    });
    onOpenChange(false);
  }

  const labels: Record<Chip, string> = {
    Who: filters.who
      ? (people.find((person) => person.id === filters.who)?.name ??
        "Selected person")
      : "Anyone",
    What: query ? Array.from(query).slice(0, 32).join("") : "Any words",
    When:
      filters.on ||
      (filters.after || filters.before ? "Date range" : "Any date"),
    Where:
      filters.where === "all"
        ? "All readable conversations"
        : filters.where === "current"
          ? "Current conversation"
          : (rooms.find((room) => room.id === filters.where)?.name ??
            "Selected conversation"),
    Has: filters.has || "Anything",
    Is: filters.is || "Any message",
  };
  const chips: Chip[] = ["Who", "What", "When", "Where", "Has", "Is"];
  const control = "min-h-11 sm:min-h-10";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        initialFocus={() => document.getElementById(`${id}-what`)}
        finalFocus={returnFocus}
        className="flex max-h-[90dvh] max-w-2xl flex-col gap-4 p-4 sm:p-5"
      >
        <DialogCloseButton />
        <DialogHeader className="pr-10">
          <DialogTitle>Search messages</DialogTitle>
          <DialogDescription>
            Find a message, then open it in its conversation.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          className="flex flex-col gap-3"
        >
          <label htmlFor={`${id}-what`} className="text-sm font-medium">
            What
          </label>
          <div className="flex gap-2">
            <Input
              id={`${id}-what`}
              value={query}
              maxLength={4000}
              placeholder="Words or a phrase"
              onChange={(event) => {
                onQueryChange(event.target.value);
                setRequest(null);
                setValidation("");
              }}
              className={`${control} min-w-0 flex-1`}
            />
            <Button type="submit" className={control}>
              Search
            </Button>
          </div>
          <div
            role="group"
            aria-label="Search filters"
            className="flex flex-wrap gap-1.5"
          >
            {chips.map((chip) => (
              <Button
                key={chip}
                type="button"
                variant={editor === chip ? "secondary" : "outline"}
                aria-expanded={chip === "What" ? undefined : editor === chip}
                aria-controls={chip === "What" ? `${id}-what` : `${id}-filter`}
                onClick={() =>
                  chip === "What"
                    ? document.getElementById(`${id}-what`)?.focus()
                    : setEditor(editor === chip ? null : chip)
                }
                className="min-h-11 max-w-full px-2.5 text-xs sm:min-h-8"
              >
                <span className="truncate">
                  <span className="font-semibold">{chip}:</span> {labels[chip]}
                </span>
              </Button>
            ))}
          </div>
          {editor && editor !== "What" && (
            <div
              id={`${id}-filter`}
              className="bg-muted/40 flex flex-col gap-2 rounded-[var(--radius)] p-3"
            >
              {editor === "Who" && (
                <>
                  <label htmlFor={`${id}-who`} className="text-sm font-medium">
                    Who
                  </label>
                  <Select
                    id={`${id}-who`}
                    value={filters.who}
                    onValueChange={(value) => change("who", value)}
                    className={control}
                  >
                    <SelectItem value="">Anyone</SelectItem>
                    {people.map((person) => (
                      <SelectItem key={person.id} value={person.id}>
                        {person.name}
                      </SelectItem>
                    ))}
                    {filters.who &&
                      !people.some((person) => person.id === filters.who) && (
                        <SelectItem value={filters.who}>
                          Selected person
                        </SelectItem>
                      )}
                  </Select>
                </>
              )}
              {editor === "Where" && (
                <>
                  <label
                    htmlFor={`${id}-where`}
                    className="text-sm font-medium"
                  >
                    Where
                  </label>
                  <Select
                    id={`${id}-where`}
                    value={filters.where}
                    onValueChange={(value) => change("where", value)}
                    className={control}
                  >
                    <SelectItem value="current" disabled={!current}>
                      Current conversation
                    </SelectItem>
                    <SelectItem value="all">
                      All readable conversations
                    </SelectItem>
                    {rooms.map((room) => (
                      <SelectItem key={room.id} value={room.id}>
                        {room.name}
                      </SelectItem>
                    ))}
                  </Select>
                </>
              )}
              {editor === "When" && (
                <div className="grid gap-3 sm:grid-cols-3">
                  {(["on", "after", "before"] as const).map((field) => (
                    <label
                      key={field}
                      className="flex min-w-0 flex-col gap-2 text-sm font-medium"
                    >
                      {field[0].toUpperCase() + field.slice(1)}
                      <Input
                        type="date"
                        value={filters[field]}
                        onChange={(event) => change(field, event.target.value)}
                        className={`${control} min-w-0`}
                      />
                    </label>
                  ))}
                </div>
              )}
              {editor === "Has" && (
                <>
                  <label htmlFor={`${id}-has`} className="text-sm font-medium">
                    Has
                  </label>
                  <Select
                    id={`${id}-has`}
                    value={filters.has}
                    onValueChange={(value) => change("has", value)}
                    className={control}
                  >
                    <SelectItem value="">Anything</SelectItem>
                    <SelectItem value="file">File</SelectItem>
                    <SelectItem value="link">Link</SelectItem>
                    <SelectItem value="record">Record</SelectItem>
                  </Select>
                </>
              )}
              {editor === "Is" && (
                <>
                  <label htmlFor={`${id}-is`} className="text-sm font-medium">
                    Is
                  </label>
                  <Select
                    id={`${id}-is`}
                    value={filters.is}
                    onValueChange={(value) => change("is", value)}
                    className={control}
                  >
                    <SelectItem value="">Any message</SelectItem>
                    <SelectItem value="pinned">Pinned</SelectItem>
                    <SelectItem value="thread">Thread</SelectItem>
                  </Select>
                </>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-muted-foreground text-xs">{labels.Where}</p>
            <Button
              type="button"
              variant="ghost"
              className="min-h-11 px-2 text-xs sm:min-h-8"
              onClick={() => {
                setFilters(defaults());
                onQueryChange("");
                setRequest(null);
                setValidation("");
                setEditor(null);
              }}
            >
              Clear filters
            </Button>
          </div>
          {validation && (
            <p role="alert" className="text-destructive text-sm">
              {validation}
            </p>
          )}
        </form>
        <LoadingRegion
          loading={!!activeRequest && results.status === "loading"}
          label="Searching messages"
          skeleton={
            <div className="flex flex-col gap-4 py-3">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          }
        >
          {!activeRequest ? (
            <p className="text-muted-foreground py-6 text-sm">
              Choose filters, then search messages you can read.
            </p>
          ) : results.error ? (
            <div className="flex flex-col items-start gap-2 py-4">
              <p role="alert" className="text-destructive text-sm">
                Search could not be loaded. Try again.
              </p>
              <Button
                variant="outline"
                onClick={results.reload}
                className={control}
              >
                Retry search
              </Button>
            </div>
          ) : (
            data && (
              <CommsSearchResults
                page={data}
                refreshing={results.refreshing}
                onOpen={openHit}
                onPage={(offset) => setRequest({ ...activeRequest, offset })}
              />
            )
          )}
        </LoadingRegion>
      </DialogContent>
    </Dialog>
  );
}
