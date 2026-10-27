import { expect, test } from "@playwright/test";

import type { AccessSecurityEvent } from "../../../src/components/systems/access/adapters/security-events-api";
import {
  eventLabels,
  securityEventSentence,
  type PersonNames,
} from "../../../src/components/systems/access/helpers/security-event-sentences";

// Each emitted security event type has an Event type filter label and one
// sentence built only from recorded facts. A success states the effect; any
// other outcome names the action and says it was attempted, only partly
// completed, denied or failed, so the feed never claims unfinished work. A
// missing or malformed fact is left out instead of guessed, and an unknown
// type is "Other security event". The http journey "emitted event sentences
// use recorded facts without claiming unfinished work" keeps one filtered
// sentence with its server read, and "Events mixed nullable feed and details
// explain representative and partial outcomes without raw metadata" keeps the
// representative feed.

const mara = "00000000-0000-4000-8000-000000000001";
const jay = "00000000-0000-4000-8000-000000000002";
const historical = "00000000-0000-4000-8000-000000000099";
const operation = "00000000-0000-4000-8000-000000000900";
const unsafeEventCanary = "CONTROLLED_UNDISPLAYED_EVENT_METADATA";
const names: PersonNames = new Map([
  [mara, "Mara"],
  [jay, "Jay"],
]);

function event(patch: Partial<AccessSecurityEvent>): AccessSecurityEvent {
  return {
    id: "00000000-0000-4000-8000-000000000700",
    occurred_at: "2026-10-06T12:00:00Z",
    event_type: "identity.sign_in",
    outcome: "success",
    source: "identity",
    operation_id: operation,
    actor_id: mara,
    subject_id: mara,
    labels: {},
    fingerprint: null,
    reason: null,
    request_id: null,
    request_method: "POST",
    request_path: "/api/auth/login",
    metadata: { ip_address: "198.51.100.42" },
    ...patch,
  };
}

const typeRows: {
  type: string;
  label: string;
  patch?: Partial<AccessSecurityEvent>;
  success: string;
  unfinished: { outcome: AccessSecurityEvent["outcome"]; sentence: string };
}[] = [
  {
    type: "identity.sign_in",
    label: "Sign-in",
    success: "Mara's sign-in was accepted from 198.51.100.42.",
    unfinished: {
      outcome: "denied",
      sentence: "Sign-in for Mara was denied.",
    },
  },
  {
    type: "identity.sign_in_failure",
    label: "Sign-in failure",
    patch: { actor_id: null, subject_id: null },
    success: "Failed sign-in attempts were recorded from 198.51.100.42.",
    unfinished: {
      outcome: "failure",
      sentence: "Failed sign-in attempts were recorded from 198.51.100.42.",
    },
  },
  {
    type: "identity.lockout",
    label: "Sign-in lockout",
    patch: { actor_id: null, subject_id: null },
    success: "Sign-in was temporarily locked from 198.51.100.42.",
    unfinished: {
      outcome: "denied",
      sentence: "Sign-in was temporarily locked from 198.51.100.42.",
    },
  },
  {
    type: "identity.ip_blocked",
    label: "Address blocked",
    patch: { actor_id: null, subject_id: null },
    success: "Sign-in was blocked from 198.51.100.42.",
    unfinished: {
      outcome: "denied",
      sentence: "Sign-in was blocked from 198.51.100.42.",
    },
  },
  {
    type: "identity.password_change",
    label: "Password change",
    success: "Mara changed their password.",
    unfinished: {
      outcome: "failure",
      sentence: "Password change for Mara failed.",
    },
  },
  {
    type: "identity.email_change_request",
    label: "Email change request",
    success:
      "Mara's email change was requested; both addresses still require confirmation.",
    unfinished: {
      outcome: "attempt",
      sentence: "Email change request for Mara was attempted.",
    },
  },
  {
    type: "identity.email_change_confirmed",
    label: "Email change confirmed",
    success: "Mara's confirmed email was saved during protected sign-in.",
    unfinished: {
      outcome: "partial",
      sentence:
        "Confirmed email synchronization for Mara was only partly completed.",
    },
  },
  {
    type: "identity.recovery_request",
    label: "Recovery request",
    patch: { actor_id: null, subject_id: null },
    success: "A password recovery request was accepted.",
    unfinished: {
      outcome: "denied",
      sentence: "A password recovery request was denied.",
    },
  },
  {
    type: "identity.recovery_complete",
    label: "Recovery completion",
    success: "Mara completed password recovery.",
    unfinished: {
      outcome: "attempt",
      sentence: "Password recovery for Mara was attempted.",
    },
  },
  {
    type: "identity.mfa.enrolled",
    label: "Two-step verification enrollment",
    success: "Mara enrolled a two-step verification factor.",
    unfinished: {
      outcome: "failure",
      sentence: "Two-step verification enrollment for Mara failed.",
    },
  },
  {
    type: "identity.mfa.verified",
    label: "Two-step verification",
    success: "Mara completed two-step verification.",
    unfinished: {
      outcome: "denied",
      sentence: "Two-step verification for Mara was denied.",
    },
  },
  {
    type: "identity.mfa.removed",
    label: "Two-step verification removal",
    success: "Mara removed a two-step verification factor.",
    unfinished: {
      outcome: "attempt",
      sentence: "Two-step verification removal for Mara was attempted.",
    },
  },
  {
    type: "identity.mfa.cancelled",
    label: "Two-step verification setup cancellation",
    success: "Mara cancelled two-step verification setup.",
    unfinished: {
      outcome: "failure",
      sentence: "Two-step verification setup cancellation for Mara failed.",
    },
  },
  {
    type: "identity.mfa.removal_incomplete",
    label: "Incomplete two-step verification removal",
    success: "Incomplete two-step verification removal was recorded for Mara.",
    unfinished: {
      outcome: "partial",
      sentence:
        "Two-step verification removal for Mara was only partly completed.",
    },
  },
  {
    type: "identity.recovery",
    label: "Person recovery request",
    patch: { subject_id: jay },
    success: "Mara requested password recovery for Jay.",
    unfinished: {
      outcome: "denied",
      sentence: "Password recovery request by Mara for Jay was denied.",
    },
  },
  {
    type: "identity.mfa_reset",
    label: "Two-step verification reset",
    patch: { subject_id: jay },
    success: "Mara reset two-step verification for Jay.",
    unfinished: {
      outcome: "partial",
      sentence:
        "Two-step verification reset by Mara for Jay was only partly completed.",
    },
  },
  {
    type: "identity.session_revocation",
    label: "Session ending",
    patch: { subject_id: jay, labels: { scope: "others" } },
    success: "Mara ended Jay's other sessions.",
    unfinished: {
      outcome: "failure",
      sentence: "Session ending by Mara for Jay failed.",
    },
  },
  {
    type: "identity.local_admin_recovery",
    label: "Local administrator recovery",
    patch: { actor_id: null, subject_id: jay },
    success: "Local administrator recovery was requested for Jay.",
    unfinished: {
      outcome: "attempt",
      sentence: "Local administrator recovery for Jay was attempted.",
    },
  },
  {
    type: "identity.local_security_recovery",
    label: "Local security recovery",
    patch: { actor_id: null, subject_id: jay },
    success: "Local security recovery completed for Jay.",
    unfinished: {
      outcome: "partial",
      sentence: "Local security recovery for Jay was only partly completed.",
    },
  },
  {
    type: "user.invitation",
    label: "Invitation",
    patch: { subject_id: jay },
    success: "Mara invited Jay.",
    unfinished: {
      outcome: "denied",
      sentence: "An invitation from Mara to Jay was denied.",
    },
  },
  {
    type: "user.invitation_resend",
    label: "Invitation resend",
    patch: { subject_id: jay },
    success: "Mara resent an invitation for Jay.",
    unfinished: {
      outcome: "failure",
      sentence: "Invitation resend by Mara for Jay failed.",
    },
  },
  {
    type: "user.invitation_revocation",
    label: "Invitation revocation",
    patch: { subject_id: jay },
    success: "Mara revoked Jay's invitation.",
    unfinished: {
      outcome: "attempt",
      sentence: "Invitation revocation by Mara for Jay was attempted.",
    },
  },
  {
    type: "user.invitation_acceptance",
    label: "Invitation acceptance",
    patch: { actor_id: jay, subject_id: jay },
    success: "Jay accepted an invitation.",
    unfinished: {
      outcome: "denied",
      sentence: "Invitation acceptance by Jay was denied.",
    },
  },
  {
    type: "user.authentication_activation",
    label: "Sign-in enabled",
    patch: { subject_id: jay },
    success: "Mara enabled sign-in for Jay.",
    unfinished: {
      outcome: "failure",
      sentence: "Enabling sign-in by Mara for Jay failed.",
    },
  },
  {
    type: "user.authentication_disable",
    label: "Sign-in disabled",
    patch: { subject_id: jay },
    success: "Mara disabled sign-in for Jay.",
    unfinished: {
      outcome: "partial",
      sentence: "Disabling sign-in by Mara for Jay was only partly completed.",
    },
  },
  {
    type: "user.authentication_restore",
    label: "Sign-in restored",
    patch: { subject_id: jay },
    success: "Mara restored sign-in for Jay.",
    unfinished: {
      outcome: "attempt",
      sentence: "Restoring sign-in by Mara for Jay was attempted.",
    },
  },
  {
    type: "workspace.security_policy_change",
    label: "Account policy change",
    patch: { subject_id: null },
    success: "Mara changed the account security policy.",
    unfinished: {
      outcome: "denied",
      sentence: "Account security policy change by Mara was denied.",
    },
  },
  {
    type: "security.retention",
    label: "Session history cleanup",
    patch: {
      actor_id: null,
      subject_id: null,
      metadata: { deleted_sessions: 4, retention_days: 30 },
    },
    success: "Session history cleanup removed 4 session records.",
    unfinished: {
      outcome: "failure",
      sentence: "Session history cleanup failed.",
    },
  },
  {
    type: "backup.export.download",
    label: "Backup export download",
    patch: { subject_id: operation, metadata: { size_bytes: 200 } },
    success: "Backup export download was authorized for Mara.",
    unfinished: {
      outcome: "attempt",
      sentence: "Backup export download by Mara was attempted.",
    },
  },
  {
    type: "file.download",
    label: "File download",
    patch: { subject_id: null, metadata: { file_id: operation } },
    success: "File download was authorized for Mara.",
    unfinished: {
      outcome: "attempt",
      sentence: "File download by Mara was attempted.",
    },
  },
  {
    type: "records.export.authorized",
    label: "Record export authorization",
    patch: {
      subject_id: operation,
      metadata: { format: "xlsx", row_count: 120, column_count: 3 },
    },
    success: "Mara was authorized to export 120 records as Excel.",
    unfinished: {
      outcome: "denied",
      sentence: "Record export by Mara was denied.",
    },
  },
  {
    type: "records.aggregate_snapshot.authorized",
    label: "Record summary authorization",
    patch: { subject_id: operation, metadata: { bucket_count: 7 } },
    success: "Mara was authorized to read a record summary with 7 groups.",
    unfinished: {
      outcome: "failure",
      sentence: "Record summary by Mara failed.",
    },
  },
  {
    type: "records.aggregate_snapshots.authorized",
    label: "Record summaries authorization",
    patch: {
      subject_id: null,
      metadata: { query_count: 2, bucket_count: 7, module_ids: [operation] },
    },
    success: "Mara was authorized to read 2 record summaries with 7 groups.",
    unfinished: {
      outcome: "partial",
      sentence: "Record summaries by Mara was only partly completed.",
    },
  },
  {
    type: "lifecycle.record_purge",
    label: "Record deleted forever",
    patch: {
      subject_id: operation,
      metadata: { trigger_history_rows_removed: 3 },
    },
    success: "Mara deleted a record forever.",
    unfinished: {
      outcome: "failure",
      sentence: "Delete forever by Mara failed.",
    },
  },
  {
    type: "job.retry",
    label: "Job retry",
    patch: { subject_id: operation, metadata: { kind: "backup" } },
    success: "Mara queued a retry for a backup job.",
    unfinished: {
      outcome: "denied",
      sentence: "Job retry by Mara was denied.",
    },
  },
];

test("every emitted security event type is an Event type filter label", () => {
  expect(Object.keys(eventLabels)).toEqual(typeRows.map((row) => row.type));
});

for (const row of typeRows)
  test(`security event ${row.type}: label, recorded and unfinished sentences`, () => {
    expect(eventLabels[row.type]).toBe(row.label);
    expect(
      securityEventSentence(
        event({ ...row.patch, event_type: row.type }),
        names,
      ),
    ).toBe(row.success);
    expect(
      securityEventSentence(
        event({
          ...row.patch,
          event_type: row.type,
          outcome: row.unfinished.outcome,
        }),
        names,
      ),
    ).toBe(row.unfinished.sentence);
  });

const factRows: {
  name: string;
  patch: Partial<AccessSecurityEvent>;
  sentence: string;
}[] = [
  {
    name: "an IPv6 address is shown",
    patch: { metadata: { ip_address: "2001:db8::1" } },
    sentence: "Mara's sign-in was accepted from 2001:db8::1.",
  },
  {
    name: "a missing address is unknown",
    patch: { metadata: {} },
    sentence: "Mara's sign-in was accepted from an unknown address.",
  },
  {
    name: "a malformed address is unknown",
    patch: {
      event_type: "identity.ip_blocked",
      metadata: { ip_address: "198.51.100.300" },
    },
    sentence: "Sign-in was blocked from an unknown address.",
  },
  {
    name: "a person outside the directory is unknown",
    patch: { actor_id: historical, subject_id: historical },
    sentence: "Unknown person's sign-in was accepted from 198.51.100.42.",
  },
  {
    name: "a person-only event without a subject names the actor",
    patch: {
      event_type: "user.invitation_acceptance",
      actor_id: jay,
      subject_id: null,
    },
    sentence: "Jay accepted an invitation.",
  },
  {
    name: "a session ending of one session",
    patch: {
      event_type: "identity.session_revocation",
      subject_id: jay,
      labels: { scope: "one" },
    },
    sentence: "Mara ended a session for Jay.",
  },
  {
    name: "a session ending of all sessions",
    patch: {
      event_type: "identity.session_revocation",
      subject_id: jay,
      labels: { scope: "all" },
    },
    sentence: "Mara ended all sessions for Jay.",
  },
  {
    name: "a session ending without a known scope",
    patch: {
      event_type: "identity.session_revocation",
      subject_id: jay,
      labels: { scope: "constructor" },
    },
    sentence: "Mara ended sessions for Jay.",
  },
  {
    name: "a retention of one session",
    patch: {
      event_type: "security.retention",
      metadata: { deleted_sessions: 1 },
    },
    sentence: "Session history cleanup removed 1 session record.",
  },
  {
    name: "a retention of no sessions",
    patch: {
      event_type: "security.retention",
      metadata: { deleted_sessions: 0 },
    },
    sentence: "Session history cleanup removed 0 session records.",
  },
  {
    name: "a retention without a count",
    patch: { event_type: "security.retention", metadata: {} },
    sentence: "Session history cleanup removed session records.",
  },
  {
    name: "a retention with a negative count",
    patch: {
      event_type: "security.retention",
      metadata: { deleted_sessions: -1 },
    },
    sentence: "Session history cleanup removed session records.",
  },
  {
    name: "a retention with a fractional count",
    patch: {
      event_type: "security.retention",
      metadata: { deleted_sessions: 1.5 },
    },
    sentence: "Session history cleanup removed session records.",
  },
  {
    name: "a retention with a count beyond safe integers",
    patch: {
      event_type: "security.retention",
      metadata: { deleted_sessions: 9_007_199_254_740_992 },
    },
    sentence: "Session history cleanup removed session records.",
  },
  {
    name: "a retention with a text count",
    patch: {
      event_type: "security.retention",
      metadata: { deleted_sessions: "4" },
    },
    sentence: "Session history cleanup removed session records.",
  },
  {
    name: "an export of one record as CSV",
    patch: {
      event_type: "records.export.authorized",
      metadata: { format: "csv", row_count: 1 },
    },
    sentence: "Mara was authorized to export 1 record as CSV.",
  },
  {
    name: "an export without a format",
    patch: {
      event_type: "records.export.authorized",
      metadata: { row_count: 3 },
    },
    sentence: "Mara was authorized to export 3 records.",
  },
  {
    name: "an export with malformed facts",
    patch: {
      actor_id: null,
      subject_id: null,
      event_type: "records.export.authorized",
      metadata: {
        row_count: true,
        format: "constructor",
        module_name: "CONTROLLED_UNDISPLAYED_EVENT_METADATA",
      },
    },
    sentence: "Unknown person was authorized to export records.",
  },
  {
    name: "a snapshot with one bucket",
    patch: {
      event_type: "records.aggregate_snapshot.authorized",
      metadata: { bucket_count: 1 },
    },
    sentence: "Mara was authorized to read a record summary with 1 group.",
  },
  {
    name: "a snapshot without a bucket count",
    patch: {
      event_type: "records.aggregate_snapshot.authorized",
      metadata: {},
    },
    sentence: "Mara was authorized to read a record summary.",
  },
  {
    name: "one snapshot with one bucket",
    patch: {
      event_type: "records.aggregate_snapshots.authorized",
      metadata: { query_count: 1, bucket_count: 1 },
    },
    sentence: "Mara was authorized to read 1 record summary with 1 group.",
  },
  {
    name: "snapshots with malformed counts",
    patch: {
      id: "00000000-0000-4000-8000-000000000705",
      occurred_at: "2026-10-06T07:00:00Z",
      actor_id: null,
      subject_id: null,
      event_type: "records.aggregate_snapshots.authorized",
      metadata: {
        bucket_count: -1,
        query_count: "2",
        module_ids: [unsafeEventCanary],
      },
    },
    sentence: "Unknown person was authorized to read record summaries.",
  },
  {
    name: "a report run retry",
    patch: { event_type: "job.retry", metadata: { kind: "report-run" } },
    sentence: "Mara queued a retry for a report run job.",
  },
  {
    name: "a post publication retry",
    patch: { event_type: "job.retry", metadata: { kind: "post-publish" } },
    sentence: "Mara queued a retry for a post publication job.",
  },
  {
    name: "an event reminder retry",
    patch: { event_type: "job.retry", metadata: { kind: "event-reminder" } },
    sentence: "Mara queued a retry for an event reminder job.",
  },
  {
    name: "a retry of an unknown kind",
    patch: { event_type: "job.retry", metadata: { kind: "export" } },
    sentence: "Mara queued a retry for a job.",
  },
  {
    name: "a retry with a prototype-like kind",
    patch: {
      id: "00000000-0000-4000-8000-000000000706",
      occurred_at: "2026-10-06T06:00:00Z",
      actor_id: null,
      subject_id: null,
      event_type: "job.retry",
      metadata: { kind: "__proto__", result_id: unsafeEventCanary },
    },
    sentence: "Unknown person queued a retry for a job.",
  },
  {
    name: "an attempted recovery completion without people",
    patch: {
      actor_id: null,
      subject_id: null,
      event_type: "identity.recovery_complete",
      outcome: "attempt",
      metadata: {},
    },
    sentence: "Password recovery for Unknown person was attempted.",
  },
  {
    name: "a failed password change without people",
    patch: {
      id: "00000000-0000-4000-8000-000000000701",
      occurred_at: "2026-10-06T11:00:00Z",
      actor_id: null,
      subject_id: null,
      event_type: "identity.password_change",
      outcome: "failure",
      metadata: {},
    },
    sentence: "Password change for Unknown person failed.",
  },
  {
    name: "a denied invitation without people",
    patch: {
      actor_id: null,
      subject_id: null,
      event_type: "user.invitation",
      outcome: "denied",
      metadata: {},
    },
    sentence: "An invitation from Unknown person to Unknown person was denied.",
  },
  {
    name: "a partial two-step verification reset without people",
    patch: {
      id: "00000000-0000-4000-8000-000000000703",
      occurred_at: "2026-10-06T09:00:00Z",
      actor_id: null,
      subject_id: null,
      event_type: "identity.mfa_reset",
      outcome: "partial",
      metadata: {},
    },
    sentence:
      "Two-step verification reset by Unknown person for Unknown person was only partly completed.",
  },
  {
    name: "an unknown type",
    patch: { event_type: "internal.controlled_check" },
    sentence: "Other security event",
  },
  {
    name: "a prototype-like type",
    patch: { event_type: "__proto__" },
    sentence: "Other security event",
  },
];

for (const row of factRows)
  test(`security event sentence: ${row.name}`, () => {
    expect(securityEventSentence(event(row.patch), names)).toBe(row.sentence);
  });

// Keep the original email-stage bodies and sentence patterns separate from
// the generic named type rows.
for (const row of [
  {
    stage: "provider_accepted",
    event: {
      id: "00000000-0000-4000-8000-000000000700",
      occurred_at: "2026-10-06T12:00:00Z",
      event_type: "identity.email_change_request",
      outcome: "success",
      source: "identity.email_change",
      operation_id: operation,
      actor_id: mara,
      subject_id: mara,
      labels: {},
      fingerprint: null,
      reason: null,
      request_id: null,
      request_method: "POST",
      request_path: "/api/auth/login",
      metadata: { stage: "provider_accepted" },
    },
    sentence: /email change.*requested/i,
  },
  {
    stage: "local_admission",
    event: {
      id: "00000000-0000-4000-8000-000000000701",
      occurred_at: "2026-10-06T11:00:00Z",
      event_type: "identity.email_change_confirmed",
      outcome: "success",
      source: "identity.email_change",
      operation_id: operation,
      actor_id: mara,
      subject_id: mara,
      labels: {},
      fingerprint: null,
      reason: null,
      request_id: null,
      request_method: "POST",
      request_path: "/api/auth/login",
      metadata: { stage: "local_admission" },
    },
    sentence: /confirmed email.*(?:saved|synchronized)/i,
  },
] as const)
  test(`security event email stage: ${row.stage}`, () => {
    expect(securityEventSentence(row.event, new Map([[mara, "Mara"]]))).toMatch(
      row.sentence,
    );
  });
