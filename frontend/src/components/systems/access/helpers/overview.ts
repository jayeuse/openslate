import type {
  AccessGroup,
  AccessInvitationSettings,
  AccessInvitationSettingsPatch,
  AccessUser,
} from "../state/api-contracts";
import { groupsOf, personState } from "./people";

// Pure rules for the Access overview: the health counts and the invitation
// settings form. Each count matches the People or Groups view its card opens.

export type OverviewHealth = {
  /** Active administrators. One or none leaves nobody to step in. */
  administrators: number;
  /** Members and guests, not deleted, in no group: they have no access. */
  withoutGroup: number;
  groupsWithoutAccess: number;
  groupsWithoutMembers: number;
  /** Active or pending people whose access ends within 14 days. */
  guestsEndingSoon: number;
  /** Invitations sent and not accepted, not revoked. */
  pendingInvitations: number;
};

export function overviewHealth(
  users: readonly AccessUser[],
  groups: readonly AccessGroup[],
  now: number,
): OverviewHealth {
  const current = users
    .map((user) => ({ user, state: personState(user, now) }))
    .filter(({ state }) => state.id !== "deleted");
  return {
    administrators: current.filter(
      ({ user, state }) => user.role === "admin" && state.id === "active",
    ).length,
    withoutGroup: current.filter(
      ({ user }) =>
        user.role !== "admin" && groupsOf(user.id, groups).length === 0,
    ).length,
    groupsWithoutAccess: groups.filter((group) => group.access.length === 0)
      .length,
    groupsWithoutMembers: groups.filter(
      (group) => group.member_ids.length === 0,
    ).length,
    guestsEndingSoon: current.filter(({ state }) => state.expiresSoon).length,
    pendingInvitations: current.filter(({ state }) => state.id === "pending")
      .length,
  };
}

// Invitation settings

export const SETTINGS_DAYS_MIN = 1;
export const SETTINGS_DAYS_MAX = 365;

export type InvitationSettingsForm = {
  invitationExpiryDays: string;
  guestDurationDays: string;
};
export type InvitationSettingsErrors = Partial<
  Record<keyof InvitationSettingsForm, string>
>;

export function settingsFormFrom(
  settings: Pick<
    AccessInvitationSettings,
    "invitation_expiry_days" | "guest_duration_days"
  >,
): InvitationSettingsForm {
  return {
    invitationExpiryDays: String(settings.invitation_expiry_days),
    guestDurationDays: String(settings.guest_duration_days),
  };
}

function wholeDays(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const days = Number(value.trim());
  return days >= SETTINGS_DAYS_MIN && days <= SETTINGS_DAYS_MAX ? days : null;
}

function daysError(value: string): string | null {
  if (!value.trim()) return "Enter the number of days.";
  return wholeDays(value) === null
    ? `Enter a whole number from ${SETTINGS_DAYS_MIN} to ${SETTINGS_DAYS_MAX}.`
    : null;
}

export function invitationSettingsErrors(
  form: InvitationSettingsForm,
): InvitationSettingsErrors {
  const errors: InvitationSettingsErrors = {};
  const expiry = daysError(form.invitationExpiryDays);
  if (expiry) errors.invitationExpiryDays = expiry;
  const guest = daysError(form.guestDurationDays);
  if (guest) errors.guestDurationDays = guest;
  return errors;
}

/** The PATCH body for a valid form, or null when nothing changed. */
export function invitationSettingsPatch(
  saved: AccessInvitationSettings,
  form: InvitationSettingsForm,
): AccessInvitationSettingsPatch | null {
  const expiry = wholeDays(form.invitationExpiryDays);
  const guest = wholeDays(form.guestDurationDays);
  const patch: AccessInvitationSettingsPatch = { revision: saved.revision };
  if (expiry !== null && expiry !== saved.invitation_expiry_days)
    patch.invitation_expiry_days = expiry;
  if (guest !== null && guest !== saved.guest_duration_days)
    patch.guest_duration_days = guest;
  return Object.keys(patch).length > 1 ? patch : null;
}
