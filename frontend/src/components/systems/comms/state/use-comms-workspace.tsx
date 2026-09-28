"use client";

import { useEffect } from "react";
import {
  initialPeople,
  initialRoles,
  type Person,
  type Role,
} from "../../shared/data/sample-people";
import {
  INITIAL_RECORDS,
  type SampleRecord,
} from "../../shared/data/sample-data";
import { useSampleResource } from "../../shared/runtime/sample-async";
import {
  useSampleRuntime,
  useSampleState,
} from "../../shared/runtime/sample-state";
import {
  DEFAULT_PLATFORM_PREFERENCES,
  type CommsPlatformPreferences,
  useCommsConfiguration,
} from "./configuration-state";
import {
  messageFromCommsError,
  useCommsCommands,
  readCommsConfiguration,
} from "./runtime";
import {
  CATEGORIES,
  CHANNELS,
  MESSAGES,
  PEOPLE,
  type Category,
  type Channel,
  type Direct,
  type Message,
  type RecordThread,
  type Thread,
} from "../domain/model";
import {
  EXAMPLE_CATEGORIES,
  EXAMPLE_CHANNELS,
  EXAMPLE_DIRECTS,
  EXAMPLE_MESSAGES,
  EXAMPLE_PEOPLE,
  EXAMPLE_THREADS,
} from "../data/examples";

const COMMS_RESOURCE_KEYS = [
  "comms-configuration",
  "access-people",
  "access-roles",
  "commsCategories",
  "commsChannels",
  "commsMessages",
  "commsThreads",
  "commsDirects",
  "records",
  "commsRecordThreads",
  "platformAccount",
  "platformNotificationPreferences",
] as const;

export type SampleAccount = {
  language: string;
  theme: string;
  presence: string;
  passwordChanged: boolean;
  signedOut: boolean;
};

const INITIAL_ACCOUNT: SampleAccount = {
  language: "English",
  theme: "Light",
  presence: "Available",
  passwordChanged: false,
  signedOut: false,
};

export const INITIAL_DIRECTS: Direct[] = [
  { id: "sample-dm-alex", user: PEOPLE[0], read: false, blocked: false },
];

type CommsWorkspace = {
  configuration: ReturnType<typeof readCommsConfiguration>;
  people: Person[];
  roles: Role[];
  categories: Category[];
  channels: Channel[];
  messages: Message[];
  threads: Thread[];
  directs: Direct[];
  records: SampleRecord[];
  recordThreads: RecordThread[];
  account: SampleAccount;
  platformPreferences: CommsPlatformPreferences;
};

function appendExamples<T extends { id: string }>(
  current: T[],
  examples: T[],
): T[] {
  const existing = new Set(current.map((item) => item.id));
  return [...current, ...examples.filter((item) => !existing.has(item.id))];
}

export function useCommsWorkspace(onSeedError: (message: string) => void) {
  const [initialConfig] = useCommsConfiguration();
  const runtime = useSampleRuntime();
  const { run, isPending } = useCommsCommands();
  const commsResource = useSampleResource<CommsWorkspace>({
    keys: COMMS_RESOURCE_KEYS,
    queryKey: "comms-workspace",
    load: (signal) =>
      runtime.load(
        (draft) => ({
          configuration: readCommsConfiguration(draft),
          people: draft.read<Person[]>("access-people", initialPeople),
          roles: draft.read<Role[]>("access-roles", initialRoles),
          categories: draft.read<Category[]>("commsCategories", CATEGORIES),
          channels: draft.read<Channel[]>("commsChannels", CHANNELS),
          messages: draft.read<Message[]>("commsMessages", MESSAGES),
          threads: draft.read<Thread[]>("commsThreads", []),
          directs: draft.read<Direct[]>("commsDirects", INITIAL_DIRECTS),
          records: draft.read<SampleRecord[]>("records", INITIAL_RECORDS),
          recordThreads: draft.read<RecordThread[]>("commsRecordThreads", []),
          account: draft.read<SampleAccount>(
            "platformAccount",
            INITIAL_ACCOUNT,
          ),
          platformPreferences: draft.read(
            "platformNotificationPreferences",
            DEFAULT_PLATFORM_PREFERENCES,
          ),
        }),
        { keys: COMMS_RESOURCE_KEYS, signal },
      ),
  });
  const workspace: CommsWorkspace = commsResource.data ?? {
    configuration: initialConfig,
    people: initialPeople,
    roles: initialRoles,
    categories: CATEGORIES,
    channels: CHANNELS,
    messages: MESSAGES,
    threads: [],
    directs: INITIAL_DIRECTS,
    records: INITIAL_RECORDS,
    recordThreads: [],
    account: INITIAL_ACCOUNT,
    platformPreferences: DEFAULT_PLATFORM_PREFERENCES,
  };
  const [examplesLoaded] = useSampleState("commsExamplesLoaded", false);

  useEffect(() => {
    if (examplesLoaded) return;
    void run(
      "seed-examples",
      (draft) => {
        if (draft.read("commsExamplesLoaded", false)) return false;
        const currentCategories = draft.read<Category[]>(
          "commsCategories",
          CATEGORIES,
        );
        const currentChannels = draft.read<Channel[]>(
          "commsChannels",
          CHANNELS,
        );
        const currentDirects = draft.read<Direct[]>(
          "commsDirects",
          INITIAL_DIRECTS,
        );
        const currentMessages = draft.read<Message[]>(
          "commsMessages",
          MESSAGES,
        );
        const categoryIds = new Set(
          [...currentCategories, ...EXAMPLE_CATEGORIES].map((item) => item.id),
        );
        const newChannels = EXAMPLE_CHANNELS.filter((item) =>
          categoryIds.has(item.categoryId),
        );
        const conversationIds = new Set(
          [
            ...currentChannels,
            ...newChannels,
            ...currentDirects,
            ...EXAMPLE_DIRECTS,
          ].map((item) => item.id),
        );
        const newMessages = EXAMPLE_MESSAGES.filter((item) =>
          conversationIds.has(item.conversation),
        );
        const messageIds = new Set(
          [...currentMessages, ...newMessages].map((item) => item.id),
        );
        draft.update<Person[]>("access-people", initialPeople, (items) =>
          appendExamples(items, EXAMPLE_PEOPLE),
        );
        draft.update<Category[]>("commsCategories", CATEGORIES, (items) =>
          appendExamples(items, EXAMPLE_CATEGORIES),
        );
        draft.update<Channel[]>("commsChannels", CHANNELS, (items) =>
          appendExamples(items, newChannels),
        );
        draft.update<Direct[]>("commsDirects", INITIAL_DIRECTS, (items) =>
          appendExamples(items, EXAMPLE_DIRECTS),
        );
        draft.update<Message[]>("commsMessages", MESSAGES, (items) =>
          appendExamples(items, newMessages),
        );
        draft.update<Thread[]>("commsThreads", [], (items) =>
          appendExamples(
            items,
            EXAMPLE_THREADS.filter((item) => messageIds.has(item.messageId)),
          ),
        );
        draft.update("commsExamplesLoaded", false, true);
        return true;
      },
      [
        "access-people",
        "commsCategories",
        "commsChannels",
        "commsDirects",
        "commsMessages",
        "commsThreads",
        "commsExamplesLoaded",
      ],
    ).catch((error: unknown) => {
      onSeedError(
        messageFromCommsError(error, "Conversations could not be loaded."),
      );
    });
  }, [examplesLoaded, onSeedError, run]);

  return { commsResource, workspace, run, isPending };
}
