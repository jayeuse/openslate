"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useUserPreferences } from "@/components/theme-provider";
import { SearchSelect } from "@/components/ui/search-select";
import { Select, SelectItem } from "@/components/ui/select";
import {
  ORGANIZATION_TIMEZONE,
  personalTimezoneOptions,
} from "../domain/regional";
import { SettingsRow, SettingsSection } from "./rows";

/** The row label names the field; the select keeps its full name. */
const hiddenFieldLabel = "[&_[data-slot=field-label]]:sr-only";
const narrowSelect = "min-w-0 md:max-w-70";

type Regional = NonNullable<ReturnType<typeof useUserPreferences>["regional"]>;

/**
 * Regional (PD10): the personal timezone as the Manage searchable select,
 * with the organization's timezone first, and the date, time and week
 * formats. Each choice saves at once.
 */
export function RegionalSection({
  status,
  organizationZone,
  onChange,
}: {
  status: ReactNode;
  organizationZone: string | null;
  onChange: () => void;
}) {
  const preference = useUserPreferences();
  const saved = preference.regional?.timezone ?? null;
  // One reference instant per visit, so offsets do not shift while open.
  const [reference] = useState(() => new Date());
  // About 400 zones, each formatted once; rebuild only when an input changes.
  const options = useMemo(
    () => personalTimezoneOptions(organizationZone, saved, reference),
    [organizationZone, saved, reference],
  );
  return (
    <SettingsSection id="regional" title="Regional" end={status}>
      <SettingsRow label="Timezone" htmlFor="profile-timezone">
        <div className={`${hiddenFieldLabel} md:max-w-[35rem]`}>
          <SearchSelect
            id="profile-timezone"
            popupClassName="slim-ui"
            label="Timezone"
            searchPlaceholder="Search timezones"
            value={saved ?? ORGANIZATION_TIMEZONE}
            disabled={preference.disabled}
            options={options}
            onValueChange={(value) => {
              const timezone = value === ORGANIZATION_TIMEZONE ? null : value;
              if (timezone === saved) return;
              onChange();
              preference.setRegional({ timezone });
            }}
          />
        </div>
      </SettingsRow>
      <RegionalSelect
        id="profile-date-format"
        label="Date format"
        value={preference.regional?.date_format}
        disabled={preference.disabled}
        onValueChange={(value) => {
          onChange();
          preference.setRegional({
            date_format: value as Regional["date_format"],
          });
        }}
        options={[
          ["dmy", "Day / month / year"],
          ["mdy", "Month / day / year"],
          ["ymd", "Year - month - day"],
        ]}
      />
      <RegionalSelect
        id="profile-time-format"
        label="Time format"
        value={preference.regional?.time_format}
        disabled={preference.disabled}
        onValueChange={(value) => {
          onChange();
          preference.setRegional({
            time_format: value as Regional["time_format"],
          });
        }}
        options={[
          ["12h", "12-hour"],
          ["24h", "24-hour"],
        ]}
      />
      <RegionalSelect
        id="profile-week-start"
        label="Week starts"
        value={preference.regional?.week_start}
        disabled={preference.disabled}
        onValueChange={(value) => {
          onChange();
          preference.setRegional({
            week_start: value as Regional["week_start"],
          });
        }}
        options={[
          ["monday", "Monday"],
          ["sunday", "Sunday"],
        ]}
      />
    </SettingsSection>
  );
}

function RegionalSelect({
  id,
  label,
  value,
  disabled,
  onValueChange,
  options,
}: {
  id: string;
  label: string;
  value: string | undefined;
  disabled: boolean;
  onValueChange: (value: string) => void;
  options: [string, string][];
}) {
  return (
    <SettingsRow label={label} htmlFor={id}>
      <div className={narrowSelect}>
        <Select
          id={id}
          className="min-h-11"
          value={value ?? ""}
          disabled={disabled}
          onValueChange={onValueChange}
        >
          <SelectItem value="" disabled>
            Unavailable
          </SelectItem>
          <SelectItem value="organization">Organization default</SelectItem>
          {options.map(([option, text]) => (
            <SelectItem key={option} value={option}>
              {text}
            </SelectItem>
          ))}
        </Select>
      </div>
    </SettingsRow>
  );
}
