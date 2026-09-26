"use client";

import Link from "next/link";
import { Bell } from "lucide-react";
import { Action, Panel, Toggle } from "../../shared/components/ui";
import { SampleDataNote } from "@/components/sample-data-note";
import ConnectedReportNotifications from "./connected-report-notifications";
import type { SampleNotification } from "../../comms/domain/model";
import type { PlatformNotificationPreferences } from "../domain/model";

type NotificationsProps = {
  notifications: readonly SampleNotification[];
  preferences: PlatformNotificationPreferences;
  hasSelectedRecord: boolean;
  pendingSimulation: boolean;
  isPending: (key: string) => boolean;
  onMarkAllRead: () => void;
  onSimulateRecordUpdate: () => void;
  onToggleNotification: (notificationId: string) => void;
  onPreferenceChange: (patch: Partial<PlatformNotificationPreferences>) => void;
};

export default function Notifications({
  notifications,
  preferences,
  hasSelectedRecord,
  pendingSimulation,
  isPending,
  onMarkAllRead,
  onSimulateRecordUpdate,
  onToggleNotification,
  onPreferenceChange,
}: NotificationsProps) {
  return (
    <div className="space-y-5">
      <ConnectedReportNotifications />
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Panel title="Preview notifications">
          <SampleDataNote>
            Preview notifications are examples and are not delivered.
          </SampleDataNote>
          <div className="flex flex-wrap gap-2">
            <Action
              onClick={onMarkAllRead}
              disabled={
                !notifications.some((item) => !item.read) ||
                isPending("platform:notifications:read-all")
              }
            >
              Mark all as read
            </Action>
            <Action
              aria-describedby={
                hasSelectedRecord ? undefined : "record-update-unavailable"
              }
              onClick={onSimulateRecordUpdate}
              disabled={!hasSelectedRecord || pendingSimulation}
            >
              {pendingSimulation
                ? "Simulating update…"
                : "Simulate record update"}
            </Action>
          </div>
          {!hasSelectedRecord && (
            <p
              id="record-update-unavailable"
              className="text-muted-foreground text-sm"
            >
              Record update simulation is unavailable because this workspace has
              no records.
            </p>
          )}
          {!notifications.length && (
            <div className="py-12 text-center">
              <Bell className="text-muted-foreground mx-auto mb-3 size-7" />
              <p className="text-sm font-medium">You’re all caught up</p>
              <p className="text-muted-foreground mt-2 text-xs">
                Simulate an update or a thread reply to try notifications.
              </p>
            </div>
          )}
          {notifications.map((item) => (
            <article
              key={item.id}
              className={`space-y-3 rounded-lg border p-4 ${item.read ? "" : "bg-muted/40"}`}
            >
              <p className="text-sm font-medium">{item.title}</p>
              <div className="flex flex-wrap items-center gap-3">
                <Action
                  onClick={() => onToggleNotification(item.id)}
                  disabled={isPending(`platform:notification:${item.id}`)}
                >
                  Mark {item.read ? "unread" : "read"}
                </Action>
                {item.recordId ? (
                  <Link
                    className="inline-flex min-h-11 items-center text-sm underline underline-offset-4"
                    href={`/openview?record=${encodeURIComponent(item.recordId)}`}
                  >
                    Open linked record
                  </Link>
                ) : (
                  <Link
                    className="inline-flex min-h-11 items-center text-sm underline"
                    href={
                      item.channelId
                        ? `/comms?conversation=${encodeURIComponent(item.channelId)}${item.messageId ? `&message=${encodeURIComponent(item.messageId)}` : ""}`
                        : "/comms"
                    }
                  >
                    Open conversation
                  </Link>
                )}
              </div>
            </article>
          ))}
        </Panel>
        <Panel title="Preview preferences">
          <p className="text-muted-foreground text-sm">
            These settings affect the local notification preview only.
          </p>
          <Toggle
            control="switch"
            label="Thread reply notifications"
            checked={preferences.threads}
            disabled={isPending("platform:notification-preferences")}
            onCheckedChange={(checked) =>
              onPreferenceChange({ threads: checked })
            }
          />
          <Toggle
            control="switch"
            label="Record update notifications"
            checked={preferences.records}
            disabled={isPending("platform:notification-preferences")}
            onCheckedChange={(checked) =>
              onPreferenceChange({ records: checked })
            }
          />
          <Toggle
            control="switch"
            label="Daily digest"
            checked={preferences.digest}
            disabled={isPending("platform:notification-preferences")}
            onCheckedChange={(checked) =>
              onPreferenceChange({ digest: checked })
            }
          />
          <p className="text-muted-foreground text-xs">
            This preview sends no emails.
          </p>
        </Panel>
      </div>
    </div>
  );
}
