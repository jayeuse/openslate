import { initialPeople, type Person } from "../../shared/data/sample-people";
import {
  INITIAL_RECORDS,
  type SampleRecord,
} from "../../shared/data/sample-data";
import {
  MESSAGES,
  type Message,
  type SampleNotification,
} from "../../comms/domain/model";
import {
  normalizeCommsConfiguration,
  type CommsConfiguration,
} from "../../comms/domain/configuration";
import {
  INITIAL_PLATFORM_ACCOUNT,
  INITIAL_PLATFORM_PREFERENCES,
  PLATFORM_FILES,
  type PlatformAccount,
  type PlatformFile,
  type PlatformNotificationPreferences,
} from "../domain/model";

export const PLATFORM_OWNER_KEYS = [
  "access-people",
  "records",
  "commsMessages",
  "comms-configuration",
  "platformNotifications",
  "platformNotificationPreferences",
  "platformAccount",
] as const;

export type PlatformReader = <T>(key: string, initial: T) => T;

export type PlatformSnapshot = {
  people: Person[];
  records: SampleRecord[];
  messages: Message[];
  commsConfiguration: CommsConfiguration;
  notifications: SampleNotification[];
  preferences: PlatformNotificationPreferences;
  account: PlatformAccount;
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
    account: structuredClone(read("platformAccount", INITIAL_PLATFORM_ACCOUNT)),
    files: PLATFORM_FILES,
  };
}
