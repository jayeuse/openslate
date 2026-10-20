"use client";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useUserPreferences } from "@/components/theme-provider";
import { commsShortcutAction } from "@/lib/shortcuts";
import {
  useWorkspaceNavigationGuard,
  type WorkspaceNavigationGuard,
} from "@/components/workspace-navigation-guard";
import {
  AdminTools,
  mainToolViews,
  type ToolView,
} from "./components/admin-tools";
import { useWorkspaceDisplayRegion } from "@/components/use-display-region";
import {
  useCommsWorkspace,
  CommsWorkspaceProvider,
  useCommsWorkspaceView,
} from "./state/use-comms-workspace";
import { useCommsCommands } from "./state/runtime";
import { useCommsConversation } from "./state/use-comms-conversation";
import { useCommsPanelLayout } from "./state/use-comms-panel-layout";
import { useCommsPreferences } from "./state/use-comms-preferences";
import {
  createCommsNavigationActions,
  useCommsNavigationState,
} from "./state/use-comms-navigation";
import { createCommsConversationOperations } from "./state/use-comms-conversation-operations";
import { reportCommsError } from "./state/comms-feedback";
import { threadMessages } from "./domain/view-model";
import { CommsLayout, CommsSkeleton } from "./components/comms-layout";
import { ConversationList } from "./components/conversation-list";
import { ConversationHeader } from "./components/conversation-header";
import { ConversationView } from "./components/conversation-view";
import { RightPane } from "./components/right-pane";
import { CommsDialogs, useCommsDialogs } from "./components/comms-dialogs";
import { CommsDestinations } from "./components/comms-destinations";

function CommsScreen({
  resource,
}: {
  resource: ReturnType<typeof useCommsWorkspace>["commsResource"];
}) {
  // Start shared display metadata with the frame, not after history arrives.
  useWorkspaceDisplayRegion();
  const { channels, messages, threads } = useCommsWorkspaceView();
  const allMessages = [...messages, ...threads.flatMap(threadMessages)];
  const navigation = useCommsNavigationState(
    channels[0]?.id,
    allMessages,
    threads,
  );
  const conversation = useCommsConversation(navigation.selected);
  const { preferences, canView, canParticipate } = conversation;
  const { keyboardShortcuts, disabled: shortcutsDisabled } =
    useUserPreferences();
  const dialogs = useCommsDialogs(navigation);
  const patchPreferences = useCommsPreferences(preferences);
  const { run, isPending } = useCommsCommands();
  const toolGuard = useRef<WorkspaceNavigationGuard | null>(null);
  const registerGuard = useCallback(
    (guard: WorkspaceNavigationGuard | null) => {
      toolGuard.current = guard;
    },
    [],
  );
  const tool = navigation.query.get("tool") as ToolView;
  const mainTool = mainToolViews.includes(tool);
  const guardWorkspaceNavigation = useCallback<WorkspaceNavigationGuard>(
    (href, resume) => {
      if (!isPending()) return toolGuard.current?.(href, resume) ?? true;
      reportCommsError(
        "Finish the current OpenComms change before leaving this page.",
      );
      return false;
    },
    [isPending],
  );
  useWorkspaceNavigationGuard(guardWorkspaceNavigation);
  const currentThread = canView
    ? threads.find(
        (item) =>
          item.id === navigation.threadId &&
          item.conversation === navigation.selected,
      )
    : undefined;
  const openRecord = !currentThread && !!navigation.recordId;
  const layout = useCommsPanelLayout({
    preferences,
    hasThread: !mainTool && (!!currentThread || !!openRecord),
    membersVisible: !mainTool && !navigation.view && navigation.membersVisible,
  });
  const [clockNow, setClockNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClockNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  const actions = createCommsNavigationActions({
    state: navigation,
    preferences,
    clockNow,
    allMessages,
    threads,
    canParticipate,
    patchPreferences,
    setThreadDirectory: dialogs.setThreadDirectory,
  });
  const operations = createCommsConversationOperations({
    run,
    thread: currentThread,
    select: actions.select,
    setDirectError: dialogs.setDirectError,
    setNotice: reportCommsError,
    setDmOpen: dialogs.setDmOpen,
    setThreadId: navigation.setThreadId,
  });
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        keyboardShortcuts !== true ||
        shortcutsDisabled ||
        document.querySelector('[role="dialog"]')
      )
        return;
      const action = commsShortcutAction(event, preferences.shortcuts);
      if (action === "search") {
        event.preventDefault();
        const input = document.querySelector<HTMLInputElement>(
          '[aria-label="Search messages"]',
        );
        if (input && !input.getClientRects().length)
          document
            .querySelector<HTMLButtonElement>('[aria-controls="comms-details"]')
            ?.click();
        requestAnimationFrame(() => input?.focus());
      }
      if (action === "newMessage") {
        event.preventDefault();
        document
          .getElementById(
            `composer-${currentThread?.id ?? navigation.selected}`,
          )
          ?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    preferences.shortcuts,
    currentThread?.id,
    navigation.selected,
    keyboardShortcuts,
    shortcutsDisabled,
  ]);
  return (
    <CommsLayout
      resource={resource}
      layout={layout}
      navigation={navigation}
      patchPreferences={patchPreferences}
      tool={
        mainTool ? (
          <AdminTools
            key={tool}
            view={tool}
            embedded={{ registerGuard }}
            opener={dialogs.toolOpener}
            channelId={navigation.selected || undefined}
            onClose={navigation.closeTool}
          />
        ) : undefined
      }
      rightKind={currentThread ? "thread" : openRecord ? "record" : "members"}
      dialogOpen={
        !!navigation.query.get("tool") || !!dialogs.settings || !!dialogs.editor
      }
      list={
        <ConversationList
          conversation={conversation}
          navigation={navigation}
          dialogs={dialogs}
          select={actions.select}
          openThread={actions.openThread}
        />
      }
      conversation={
        navigation.view ? (
          <CommsDestinations
            navigation={navigation}
            select={actions.select}
            openThread={actions.openThread}
          />
        ) : (
          <ConversationView
            conversation={conversation}
            navigation={navigation}
            dialogs={dialogs}
            header={
              <ConversationHeader
                conversation={conversation}
                navigation={navigation}
                dialogs={dialogs}
                wide={layout.wide}
                jumpToMessage={actions.jumpToMessage}
              />
            }
            startThread={operations.startThread}
            startDirect={operations.startDirect}
            jumpToMessage={actions.jumpToMessage}
            beginReply={actions.beginReply}
            scrollToLatest={actions.scrollToLatest}
            hydrated={resource.hydrated}
            desktop={layout.desktop}
          />
        )
      }
      right={
        <RightPane
          navigation={navigation}
          conversation={conversation}
          dialogs={dialogs}
          currentThread={currentThread}
          operations={operations}
          jumpToMessage={actions.jumpToMessage}
          wide={layout.wide}
        />
      }
      dialogs={
        <CommsDialogs
          state={dialogs}
          navigation={navigation}
          select={actions.select}
          openThread={actions.openThread}
          fallbackOpener={layout.container}
        />
      }
    />
  );
}
function CommsWorkspace() {
  const { commsResource, workspace } = useCommsWorkspace();
  return (
    <CommsWorkspaceProvider value={workspace}>
      <CommsScreen resource={commsResource} />
    </CommsWorkspaceProvider>
  );
}
export default function SampleComms() {
  return (
    <Suspense fallback={<CommsSkeleton />}>
      <CommsWorkspace />
    </Suspense>
  );
}
