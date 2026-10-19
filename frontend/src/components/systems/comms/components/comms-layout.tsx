"use client";
import { Activity, type CSSProperties, type ReactNode } from "react";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { LoadingRegion } from "@/components/ui/loading-region";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert } from "@/components/ui/alert";
import { Action } from "../../shared/components/ui";
import { ProfilePopoverProvider } from "./floating";
import { cn } from "@/lib/utils";
import type { useCommsPanelLayout } from "../state/use-comms-panel-layout";
import type { useCommsWorkspace } from "../state/use-comms-workspace";
import type { NavigationState } from "../state/use-comms-navigation";
import type { CommsPreferences } from "../domain/configuration";

export function CommsSkeleton({
  channelWidth = 240,
  memberWidth = 240,
  conversationFirst = false,
  members = true,
}: {
  channelWidth?: number;
  memberWidth?: number;
  conversationFirst?: boolean;
  members?: boolean;
}) {
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1"
      style={
        {
          "--comms-channel-width": `${channelWidth}px`,
          "--comms-member-width": `${memberWidth}px`,
        } as CSSProperties
      }
    >
      <div
        className={cn(
          "bg-muted/25 min-h-0 w-full shrink-0 flex-col border-r md:flex md:w-(--comms-channel-width)",
          conversationFirst ? "hidden" : "flex",
        )}
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b px-4">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="size-9" />
        </div>
        <div className="border-b px-4 py-2">
          <Skeleton className="h-4 w-48 max-w-full" />
        </div>
        <div className="p-3">
          <Skeleton className="h-10 w-full" />
        </div>
        <div className="flex flex-col px-2">
          <div className="flex min-h-11 items-center px-1">
            <Skeleton className="h-4 w-24" />
          </div>
          {["w-32", "w-24", "w-36", "w-28", "w-20"].map((width) => (
            <div key={width} className="flex min-h-11 items-center px-2">
              <Skeleton className={cn("h-4", width)} />
            </div>
          ))}
        </div>
      </div>
      <div className="bg-border hidden w-px shrink-0 md:block" />
      <div
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col",
          conversationFirst ? "flex" : "hidden md:flex",
        )}
      >
        <div className="flex min-h-14 shrink-0 items-center gap-1.5 border-b px-3 py-2">
          <Skeleton className="size-5" />
          <Skeleton className="h-5 w-40" />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-hidden px-2 py-4 sm:px-4">
          {["w-3/4", "w-1/2", "w-2/3", "w-2/5"].map((width) => (
            <div key={width} className="flex gap-3">
              <Skeleton className="size-9 shrink-0 rounded-full" />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className={cn("h-4", width)} />
              </div>
            </div>
          ))}
        </div>
        <div className="shrink-0 border-t p-3">
          <Skeleton className="h-20 w-full" />
        </div>
      </div>
      {members && (
        <>
          <div className="bg-border hidden w-px shrink-0 xl:block" />
          <div className="bg-muted/15 hidden min-h-0 shrink-0 flex-col gap-4 border-l p-4 xl:flex xl:w-(--comms-member-width)">
            <Skeleton className="h-4 w-24" />
            {["one", "two", "three", "four"].map((id) => (
              <div key={id} className="flex items-center gap-3">
                <Skeleton className="size-8 shrink-0 rounded-full" />
                <Skeleton className="h-4 w-28" />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

type Props = {
  resource: ReturnType<typeof useCommsWorkspace>["commsResource"];
  layout: ReturnType<typeof useCommsPanelLayout>;
  navigation: NavigationState;
  patchPreferences: (patch: Partial<CommsPreferences>) => Promise<void>;
  list: ReactNode;
  conversation: ReactNode;
  right: ReactNode;
  dialogs: ReactNode;
  rightKind: "thread" | "record" | "members";
  dialogOpen: boolean;
};
export function CommsLayout({
  resource,
  layout,
  navigation,
  patchPreferences,
  list,
  conversation,
  right,
  dialogs,
  rightKind,
  dialogOpen,
}: Props) {
  const {
    container,
    channelsPanel,
    rightPanel,
    desktop,
    wide,
    rightOpen,
    minimumChatWidth,
    channelMaximum,
    channelWidth,
    memberMaximum,
    memberWidth,
    threadMaximum,
    threadWidth,
  } = layout;
  const detail = rightKind !== "members";
  if (resource.status === "error" && !resource.hydrated)
    return (
      <section
        aria-label="OpenComms"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
      >
        <Alert role="alert" variant="destructive">
          {resource.error}
        </Alert>
        <Action type="button" variant="outline" onClick={resource.reload}>
          Try again
        </Action>
      </section>
    );
  return (
    <ProfilePopoverProvider>
      <div
        ref={container}
        className="bg-card relative flex min-h-0 flex-1 overflow-hidden"
      >
        <LoadingRegion
          loading={resource.status === "loading" && !resource.hydrated}
          label="Loading conversations"
          skeleton={
            <CommsSkeleton
              channelWidth={channelWidth}
              memberWidth={memberWidth}
              conversationFirst={navigation.mobileConversation}
              members={navigation.membersVisible}
            />
          }
          className="flex min-h-0 min-w-0 flex-1 *:flex *:min-h-0 *:min-w-0 *:flex-1"
        >
          {resource.hydrated && !resource.data && (
            <div className="bg-card absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 p-6">
              {resource.status === "error" ? (
                <>
                  <Alert role="alert" variant="destructive">
                    {resource.error}
                  </Alert>
                  <Action onClick={resource.reload}>Try again</Action>
                </>
              ) : (
                <p role="status">Verifying conversation access…</p>
              )}
            </div>
          )}
          <Activity mode={resource.data ? "visible" : "hidden"}>
            {(resource.refreshing || resource.error) && (
              <div className="bg-background/95 absolute inset-x-0 top-0 z-20 flex items-center gap-2 border-b px-4 py-2 text-xs backdrop-blur">
                <p role="status" className="text-muted-foreground flex-1">
                  {resource.refreshing
                    ? "Refreshing conversations…"
                    : `Showing the last saved conversations. ${resource.error}`}
                </p>
                {!resource.refreshing && (
                  <Action
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={resource.reload}
                  >
                    Retry
                  </Action>
                )}
              </div>
            )}
            {dialogs}
            <ResizablePanelGroup
              orientation="horizontal"
              onLayoutChanged={(_, meta) => {
                if (!meta.isUserInteraction) return;
                const channelPixels = channelsPanel.current?.getSize().inPixels;
                const rightPixels = rightPanel.current?.getSize().inPixels;
                patchPreferences({
                  ...(desktop && channelPixels
                    ? { channelWidth: Math.round(channelPixels) }
                    : {}),
                  ...(rightOpen && rightPixels
                    ? rightKind === "thread"
                      ? { threadWidth: Math.round(rightPixels) }
                      : { memberWidth: Math.round(rightPixels) }
                    : {}),
                });
              }}
            >
              {(desktop || !navigation.mobileConversation) && (
                <ResizablePanel
                  id="channels"
                  panelRef={channelsPanel}
                  defaultSize={desktop ? channelWidth : "100%"}
                  minSize={desktop ? 200 : 0}
                  maxSize={desktop ? channelMaximum : "100%"}
                  groupResizeBehavior={
                    desktop ? "preserve-pixel-size" : "preserve-relative-size"
                  }
                >
                  {list}
                </ResizablePanel>
              )}
              {desktop && <ResizableHandle aria-label="Resize channels" />}
              {(desktop || navigation.mobileConversation) && (
                <ResizablePanel
                  id="conversation"
                  minSize={desktop ? minimumChatWidth : 0}
                >
                  {conversation}
                </ResizablePanel>
              )}
              {rightOpen && (
                <>
                  <ResizableHandle
                    aria-label={`Resize ${rightKind}`}
                    onKeyDownCapture={(event) => {
                      if (event.key !== "Home" && event.key !== "End") return;
                      event.preventDefault();
                      event.stopPropagation();
                      const width =
                        event.key === "Home"
                          ? detail
                            ? 320
                            : 200
                          : detail
                            ? threadMaximum
                            : memberMaximum;
                      rightPanel.current?.resize(width);
                      patchPreferences(
                        detail
                          ? { threadWidth: width }
                          : { memberWidth: width },
                      );
                    }}
                  />
                  <ResizablePanel
                    key={rightKind}
                    id={rightKind}
                    panelRef={rightPanel}
                    defaultSize={detail ? threadWidth : memberWidth}
                    minSize={detail ? 320 : 200}
                    maxSize={detail ? threadMaximum : memberMaximum}
                    groupResizeBehavior="preserve-pixel-size"
                  >
                    <aside
                      id="comms-members"
                      aria-label={
                        rightKind === "thread"
                          ? "Thread panel"
                          : rightKind === "record"
                            ? "Record"
                            : "Channel members"
                      }
                      className="bg-muted/15 h-full min-h-0 overflow-hidden border-l"
                    >
                      {right}
                    </aside>
                  </ResizablePanel>
                </>
              )}
            </ResizablePanelGroup>
            <div className="xl:hidden">
              {!wide && !dialogOpen && (navigation.memberOpen || detail) && (
                <Dialog
                  open
                  onOpenChange={(open) => {
                    if (!open && rightKind === "thread")
                      navigation.setThreadId("");
                    else if (!open)
                      navigation.update({
                        conversation: navigation.selected,
                        panel: "none",
                        thread: null,
                        message: null,
                      });
                  }}
                >
                  <DialogContent
                    finalFocus={rightKind === "thread" ? false : undefined}
                    className={
                      detail
                        ? "h-[calc(100dvh-24px)] max-h-[calc(100dvh-24px)] max-w-lg overflow-hidden p-0"
                        : "h-[85dvh] max-w-md"
                    }
                  >
                    <DialogTitle className="sr-only">
                      {rightKind === "thread"
                        ? "Thread"
                        : rightKind === "record"
                          ? "Record"
                          : "Members"}
                    </DialogTitle>
                    <DialogDescription className="sr-only">
                      {rightKind === "thread"
                        ? "Replies to this message"
                        : rightKind === "record"
                          ? "A linked record and where it is mentioned"
                          : "People with access to this conversation"}
                    </DialogDescription>
                    {right}
                  </DialogContent>
                </Dialog>
              )}
            </div>
          </Activity>
        </LoadingRegion>
      </div>
    </ProfilePopoverProvider>
  );
}
