import type { SearchSelectOption } from "@/components/ui/search-select";
import { timezoneCatalog } from "@/lib/timezone-options";

/** The select value that stands for "no personal timezone" (saved as null). */
export const ORGANIZATION_TIMEZONE = "organization";

/**
 * The personal timezone choices (PD10): the organization's timezone first,
 * then every zone with its offset at `reference`. A saved zone that the
 * browser does not list stays choosable.
 */
export function personalTimezoneOptions(
  organizationZone: string | null,
  saved: string | null,
  reference: Date,
): SearchSelectOption[] {
  return [
    {
      value: ORGANIZATION_TIMEZONE,
      label: organizationZone
        ? `Organization timezone (${organizationZone})`
        : "Organization timezone",
    },
    ...timezoneCatalog(reference, saved),
  ];
}
