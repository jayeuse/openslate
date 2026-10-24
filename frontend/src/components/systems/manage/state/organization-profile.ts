import type {
  WorkspaceProfileField,
  WorkspaceProfileFormFields,
} from "../adapters/workspace-api";

/** The optional profile fields in their form order, with their labels. */
export const PROFILE_FIELDS: readonly {
  key: WorkspaceProfileField;
  label: string;
  /** Contact fields exist only in a read that carries contacts. */
  contact: boolean;
}[] = [
  { key: "legalName", label: "Legal name", contact: false },
  { key: "description", label: "Description", contact: false },
  { key: "contactEmail", label: "Contact email", contact: true },
  { key: "contactPhone", label: "Contact phone", contact: true },
  { key: "postalAddress", label: "Postal address", contact: true },
];

function shownFields(contactsVisible: boolean) {
  return PROFILE_FIELDS.filter((field) => contactsVisible || !field.contact);
}

const holdsText = (value: string | undefined) => Boolean(value?.trim());

/**
 * What the closed Profile block holds (MD4, the Advanced Last Rule): its
 * fields by name, each with a value marked "(set)", so nothing changes out of
 * sight.
 */
export function profileSummary(
  profile: WorkspaceProfileFormFields,
  contactsVisible: boolean,
): string {
  return shownFields(contactsVisible)
    .map(({ key, label }) =>
      holdsText(profile[key]) ? `${label} (set)` : label,
    )
    .join(", ");
}

/** Whether a reader has any profile value to see (MD5). */
export function profileHasValues(
  profile: WorkspaceProfileFormFields,
  contactsVisible: boolean,
): boolean {
  return shownFields(contactsVisible).some(({ key }) =>
    holdsText(profile[key]),
  );
}
