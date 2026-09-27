import { initialPeople, type Person } from "../../shared/data/sample-people";
import {
  INITIAL_RECORDS,
  type SampleRecord,
} from "../../shared/data/sample-data";
import {
  MESSAGES,
  type Message,
  type RecordThread,
  type SampleNotification,
} from "../../comms/domain/model";
import {
  normalizeCommsConfiguration,
  type CommsConfiguration,
} from "../../comms/domain/configuration";
import {
  INITIAL_PLATFORM_ACCOUNT,
  INITIAL_PLATFORM_PREFERENCES,
  INITIAL_PLATFORM_SESSIONS,
  PLATFORM_FILES,
  type PlatformAccount,
  type PlatformFile,
  type PlatformNotificationPreferences,
  type PlatformSession,
} from "../domain/model";

export const PLATFORM_OWNER_KEYS = [
  "access-people",
  "records",
  "commsMessages",
  "comms-configuration",
  "platformNotifications",
  "platformNotificationPreferences",
  "platformFollowedRecords",
  "commsRecordThreads",
  "platformAccount",
  "platformSessions",
] as const;

export type PlatformReader = <T>(key: string, initial: T) => T;

export type PlatformSnapshot = {
  people: Person[];
  records: SampleRecord[];
  messages: Message[];
  commsConfiguration: CommsConfiguration;
  notifications: SampleNotification[];
  preferences: PlatformNotificationPreferences;
  followed: string[];
  recordThreads: RecordThread[];
  account: PlatformAccount;
  sessions: PlatformSession[];
  files: readonly PlatformFile[];
};

export function readPlatformSnapshot(read: PlatformReader): PlatformSnapshot {
  return {
    people: structuredClone(read("access-people", initialPeople)),
    records: structuredClone(read("records", INITIAL_RECORDS)),
    messages: structuredClone(read("commsMessages", MESSAGES)),
    commsConfiguration: normalizeCommsConfiguration(
      read<unknown>("comms-configuration", null),
    ),
    notifications: structuredClone(read("platformNotifications", [])),
    preferences: structuredClone(
      read("platformNotificationPreferences", INITIAL_PLATFORM_PREFERENCES),
    ),
    followed: structuredClone(read("platformFollowedRecords", [])),
    recordThreads: structuredClone(read("commsRecordThreads", [])),
    account: structuredClone(read("platformAccount", INITIAL_PLATFORM_ACCOUNT)),
    sessions: structuredClone(
      read("platformSessions", INITIAL_PLATFORM_SESSIONS),
    ),
    files: PLATFORM_FILES,
  };
}
