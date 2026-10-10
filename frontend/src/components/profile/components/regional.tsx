"use client";

import { useEffect, useState } from "react";
import {
  useUserPreferences,
  UserPreferencesStatus,
} from "@/components/theme-provider";
import { isIanaTimezone } from "@/lib/date-time";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { Button } from "@/components/ui/button";

export default function Regional({
  onDirtyChange,
}: {
  onDirtyChange: (dirty: boolean) => void;
}) {
  const preference = useUserPreferences();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState("");
  const confirmed = preference.regional?.timezone ?? "";
  const timezone = draft ?? confirmed;
  const dirty = draft !== null && draft !== confirmed;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  return (
    <Card>
      <CardContent className="space-y-5 pt-6">
        <p className="text-muted-foreground max-w-prose text-sm">
          These choices format dates and times for you. Workspace day
          boundaries, reports and exports, schedules, and event timezones do not
          change.
        </p>
        <form
          className="space-y-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (preference.disabled || !dirty) return;
            if (!isIanaTimezone(timezone)) {
              setError("Enter a valid IANA timezone, such as Europe/London.");
              return;
            }
            setError("");
            preference.setRegional({ timezone });
          }}
        >
          <Field>
            <FieldLabel htmlFor="profile-timezone">Timezone</FieldLabel>
            <Input
              id="profile-timezone"
              value={timezone}
              disabled={preference.disabled}
              className="min-h-11"
              placeholder="Organization timezone"
              aria-invalid={Boolean(error)}
              aria-describedby="profile-timezone-hint"
              onChange={(event) => {
                setDraft(event.target.value);
                setError("");
              }}
            />
          </Field>
          <p
            id="profile-timezone-hint"
            className="text-muted-foreground text-sm"
          >
            Leave inheritance to the organization, or enter an IANA name for
            your personal display.
          </p>
          {error ? (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              className="min-h-11"
              disabled={preference.disabled || !dirty}
            >
              Save timezone
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={preference.disabled}
              onClick={() => {
                setDraft(null);
                setError("");
                preference.setRegional({ timezone: null });
              }}
            >
              Use organization timezone
            </Button>
          </div>
        </form>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field>
            <FieldLabel htmlFor="profile-date-format">Date format</FieldLabel>
            <Select
              id="profile-date-format"
              className="min-h-11"
              value={preference.regional?.date_format ?? ""}
              disabled={preference.disabled}
              onValueChange={(value) =>
                preference.setRegional({
                  date_format: value as NonNullable<
                    typeof preference.regional
                  >["date_format"],
                })
              }
            >
              <SelectItem value="" disabled>
                Unavailable
              </SelectItem>
              <SelectItem value="organization">Organization default</SelectItem>
              <SelectItem value="dmy">Day / month / year</SelectItem>
              <SelectItem value="mdy">Month / day / year</SelectItem>
              <SelectItem value="ymd">Year - month - day</SelectItem>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="profile-time-format">Time format</FieldLabel>
            <Select
              id="profile-time-format"
              className="min-h-11"
              value={preference.regional?.time_format ?? ""}
              disabled={preference.disabled}
              onValueChange={(value) =>
                preference.setRegional({
                  time_format: value as NonNullable<
                    typeof preference.regional
                  >["time_format"],
                })
              }
            >
              <SelectItem value="" disabled>
                Unavailable
              </SelectItem>
              <SelectItem value="organization">Organization default</SelectItem>
              <SelectItem value="12h">12-hour</SelectItem>
              <SelectItem value="24h">24-hour</SelectItem>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="profile-week-start">
              First day of the week
            </FieldLabel>
            <Select
              id="profile-week-start"
              className="min-h-11"
              value={preference.regional?.week_start ?? ""}
              disabled={preference.disabled}
              onValueChange={(value) =>
                preference.setRegional({
                  week_start: value as NonNullable<
                    typeof preference.regional
                  >["week_start"],
                })
              }
            >
              <SelectItem value="" disabled>
                Unavailable
              </SelectItem>
              <SelectItem value="organization">Organization default</SelectItem>
              <SelectItem value="monday">Monday</SelectItem>
              <SelectItem value="sunday">Sunday</SelectItem>
            </Select>
          </Field>
        </div>
        <UserPreferencesStatus />
      </CardContent>
    </Card>
  );
}
