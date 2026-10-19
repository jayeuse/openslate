"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useWorkspaceNavigationGuard } from "@/components/workspace-navigation-guard";
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
  const { channels, messages, threads, records } = useCommsWorkspaceView();
  const allMessages = [...messages, ...threads.flatMap(threadMessages)];
  const navigation = useCommsNavigationState(
    channels[0]?.id,
    allMessages,
    threads,
  );
  const conversation = useCommsConversation(navigation.selected);
  const { preferences, canView, canParticipate } = conversation;
  const dialogs = useCommsDialogs(navigation);
  const patchPreferences = useCommsPreferences(preferences);
  const { run, isPending } = useCommsCommands();
  const guardWorkspaceNavigation = useCallback(() => {
    if (!isPending()) return true;
    reportCommsError(
      "Finish the current OpenComms change before leaving this page.",
    );
    return false;
  }, [isPending]);
  useWorkspaceNavigationGuard(guardWorkspaceNavigation);
  const currentThread = canView
    ? threads.find(
        (item) =>
          item.id === navigation.threadId &&
          item.conversation === navigation.selected,
      )
    : undefined;
  const openRecord =
    canView && !currentThread
      ? records.find((item) => item.id === navigation.recordId)
      : undefined;
  const layout = useCommsPanelLayout({
    preferences,
    hasThread: !!currentThread || !!openRecord,
    membersVisible: !navigation.view && navigation.membersVisible,
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
      const shortcut = [
        event.altKey ? "Alt" : "",
        event.ctrlKey ? "Ctrl" : "",
        event.metaKey ? "Meta" : "",
        event.shiftKey ? "Shift" : "",
        event.key.length === 1 ? event.key.toUpperCase() : event.key,
      ]
        .filter(Boolean)
        .join("+");
      const action = Object.entries(preferences.shortcuts).find(
        ([, value]) => value.toLowerCase() === shortcut.toLowerCase(),
      )?.[0];
      if (action === "search") {
        event.preventDefault();
        document
          .querySelector<HTMLInputElement>('[aria-label="Search messages"]')
          ?.focus();
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
  }, [preferences.shortcuts, currentThread?.id, navigation.selected]);
  return (
    <CommsLayout
      resource={resource}
      layout={layout}
      navigation={navigation}
      patchPreferences={patchPreferences}
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
