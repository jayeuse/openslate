"use client";

import { X } from "lucide-react";
import {
  Fragment,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Alert } from "@/components/ui/alert";
import {
  AdvancedSection,
  writeAdvancedOpen,
} from "@/components/ui/advanced-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { cn } from "@/lib/utils";

import type {
  SecuritySettingsChange,
  SecuritySettingsFormErrors,
  SecuritySettingsFormFields,
} from "../adapters/security-api";
import { advancedPolicySetCount } from "../helpers/security-policy";

type SecurityPolicyFormProps = {
  form: {
    dirty: boolean;
    /** A save just finished; the footer chip says so until the next edit. */
    justSaved: boolean;
    /** Save is running: its button shows "Saving…". */
    saving: boolean;
    saved: SecuritySettingsFormFields;
    current: SecuritySettingsFormFields;
    errors: SecuritySettingsFormErrors;
    changeSetting: SecuritySettingsChange;
    addAddress: () => void;
    addMyAddress: () => Promise<void>;
    addressNotice: string;
    saveSection: () => Promise<void>;
    clearDraft: () => void;
  };
  /**
   * What this administrator may change. The organization owner changes the
   * organization's settings; the installation owner also changes the
   * installation-wide password, session, retention, and sign-in rules.
   */
  editable: { organization: boolean; installation: boolean };
  /** Closes the dialog and keeps the draft for the next open. */
  onCancel: () => void;
};

const ADVANCED_STORAGE_KEY = "access.policy";
/** Fields inside Advanced: an error there opens the block. */
const ADVANCED_FIELDS = [
  "ips",
  "ipEntry",
  "minimumLength",
  "absoluteLifetime",
  "concurrentLimit",
  "sessionRetention",
  "eventRetention",
  "loginThreshold",
  "loginWindow",
  "loginCooldown",
] as const satisfies readonly (keyof SecuritySettingsFormFields)[];

const hideNumberSpinners =
  "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";
/**
 * Label-left rows (Access slim controls): from 768px a muted label column
 * and the control on the right; phones stack the label above.
 */
const rowClassName =
  "min-w-0 md:grid md:min-h-10 md:grid-cols-[13rem_minmax(0,1fr)] md:items-center md:gap-x-4 md:gap-y-1";
const rowLabelClassName = "md:text-muted-foreground";
const rowNoteClassName = "md:col-start-2";
const groupLegendClassName = "mb-2 text-sm font-medium";

function days(value: string) {
  return `${value} ${value === "1" ? "day" : "days"}`;
}
function minutes(value: string) {
  return `${value} ${value === "1" ? "minute" : "minutes"}`;
}
function onOff(value: boolean) {
  return value ? "On" : "Off";
}

/** The organization's two-step rule as words ("Required for members"). */
function twoStepWords(fields: SecuritySettingsFormFields) {
  const roles = [
    fields.requireMfaAdmin ? "administrators" : null,
    fields.requireMfaMember ? "members" : null,
    fields.requireMfaGuest ? "guests" : null,
  ].filter((role): role is string => role !== null);
  return roles.length ? `Required for ${roles.join(", ")}` : "Optional";
}

function installationRows(fields: SecuritySettingsFormFields) {
  return [
    ["Minimum password length", fields.minimumLength],
    ["Require uppercase and lowercase", onOff(fields.requireMixedCase)],
    ["Require a number", onOff(fields.requireNumber)],
    [
      "Total session lifetime",
      fields.absoluteLifetime === "Off"
        ? "Off"
        : minutes(fields.absoluteLifetime),
    ],
    [
      "Concurrent session limit",
      fields.concurrentLimit === "Off"
        ? "Off"
        : `Up to ${fields.concurrentLimit}`,
    ],
    ["Session retention", days(fields.sessionRetention)],
    ["Security event retention", days(fields.eventRetention)],
    ["Failed attempts before lockout", fields.loginThreshold],
    ["Attempt window", minutes(fields.loginWindow)],
    ["Lockout duration", minutes(fields.loginCooldown)],
  ] as const;
}

/**
 * Values the viewer cannot change, as text on the sunken fill (the
 * Read-Only Is Text Rule): never a disabled field.
 */
function ReadOnlyRows({
  rows,
}: {
  rows: readonly (readonly [string, string])[];
}) {
  return (
    <dl className="bg-muted grid min-w-0 grid-cols-1 gap-y-0.5 rounded-lg px-3 py-2.5 text-sm md:grid-cols-[13rem_minmax(0,1fr)] md:gap-x-4 md:gap-y-2">
      {rows.map(([label, value]) => (
        <Fragment key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="mb-2 min-w-0 wrap-anywhere tabular-nums last:mb-0 md:mb-0">
            {value}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

function PolicyGroup({
  legend,
  describedBy,
  children,
}: {
  legend: string;
  describedBy?: string;
  children: ReactNode;
}) {
  return (
    <fieldset className="min-w-0 space-y-2" aria-describedby={describedBy}>
      <legend className={groupLegendClassName}>{legend}</legend>
      {children}
    </fieldset>
  );
}

function CheckboxRow({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <Field className={rowClassName}>
      <FieldLabel
        htmlFor={id}
        className="flex min-h-11 items-center gap-3 font-normal md:col-start-2 xl:min-h-8"
      >
        <Checkbox
          id={id}
          checked={checked}
          onCheckedChange={(value) => onChange(value)}
        />
        <span>{label}</span>
      </FieldLabel>
    </Field>
  );
}

function SelectRow({
  id,
  label,
  value,
  options,
  onChange,
  error,
}: {
  id: string;
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  error?: string;
}) {
  return (
    <Field data-invalid={Boolean(error)} className={rowClassName}>
      <FieldLabel htmlFor={id} className={rowLabelClassName}>
        {label}
      </FieldLabel>
      <NativeSelect
        id={id}
        value={value}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        className="w-full md:w-48 [&_select]:min-h-11"
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <NativeSelectOption key={option} value={option}>
            {option}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <FieldError id={`${id}-error`} className={rowNoteClassName}>
        {error}
      </FieldError>
    </Field>
  );
}

export function SecurityPolicyForm({
  form,
  editable,
  onCancel,
}: SecurityPolicyFormProps) {
  const {
    dirty,
    justSaved,
    saving,
    saved,
    saveSection,
    current,
    errors,
    changeSetting,
    clearDraft,
    addAddress,
    addMyAddress,
    addressNotice,
  } = form;
  const readOnly = !editable.organization;

  // AdvancedSection keeps its own open state. An error inside a closed block
  // (a refused address list, an invalid number) opens it the way the viewer
  // would, by remembering it open and mounting it again, so the field the
  // error names is visible and can take focus.
  const advancedErrors = ADVANCED_FIELDS.filter((key) => errors[key]).join();
  const [advancedMount, setAdvancedMount] = useState(0);
  const advancedRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!advancedErrors) return;
    // The block's own state, not the remembered one: blocked storage reads
    // as closed, and a block the viewer opened must stay open.
    const toggle = advancedRef.current?.querySelector(
      '[data-slot="advanced-section"] > button',
    );
    if (toggle?.getAttribute("aria-expanded") === "true") return;
    writeAdvancedOpen(ADVANCED_STORAGE_KEY, true);
    setAdvancedMount((count) => count + 1);
  }, [advancedErrors]);

  const shorter = (key: "sessionRetention" | "eventRetention") =>
    current[key].trim() !== "" && Number(current[key]) < Number(saved[key]);
  const retentionShortened =
    shorter("sessionRetention") || shorter("eventRetention");

  function numberRow(
    key:
      | "minimumLength"
      | "absoluteLifetime"
      | "concurrentLimit"
      | "sessionRetention"
      | "eventRetention"
      | "mfaGrace"
      | "loginThreshold"
      | "loginWindow"
      | "loginCooldown",
    id: string,
    label: string,
    minimum: number,
    maximum: number,
    /** A hint under the field, or the id of a group hint it reads. */
    note?: { id: string; text?: ReactNode },
  ) {
    const error = errors[key];
    return (
      <Field data-invalid={Boolean(error)} className={rowClassName}>
        <FieldLabel htmlFor={id} className={rowLabelClassName}>
          {label}
        </FieldLabel>
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={minimum}
          max={maximum}
          step={1}
          className={cn("min-h-11 w-full md:w-28", hideNumberSpinners)}
          value={current[key]}
          aria-invalid={Boolean(error)}
          aria-describedby={
            [error ? `${id}-error` : null, note?.id]
              .filter(Boolean)
              .join(" ") || undefined
          }
          onChange={(event) => changeSetting(key, event.target.value)}
        />
        <FieldError id={`${id}-error`} className={rowNoteClassName}>
          {error}
        </FieldError>
        {note?.text ? (
          <p
            id={note.id}
            className={cn("text-muted-foreground text-sm", rowNoteClassName)}
          >
            {note.text}
          </p>
        ) : null}
      </Field>
    );
  }

  const ipRows = [
    [
      "IP allow list",
      current.ips.length ? current.ips.join(", ") : "All addresses",
    ],
  ] as const;

  return (
    <form
      noValidate
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        void saveSection();
      }}
    >
      {readOnly ? (
        <p className="text-muted-foreground text-sm">
          Only the organization owner can change these settings.
        </p>
      ) : !editable.installation ? (
        <p className="text-muted-foreground text-sm">
          Only the installation owner can change password, session, retention,
          and sign-in rules.
        </p>
      ) : null}

      {/* The common settings: who must use two-step, its grace, and the
          session timeout. */}
      {readOnly ? (
        <ReadOnlyRows
          rows={[
            ["Two-step verification", twoStepWords(current)],
            ["Enrollment grace", days(current.mfaGrace)],
            ["Session timeout", current.timeout],
          ]}
        />
      ) : (
        <div className="flex min-w-0 flex-col gap-3">
          <div
            role="group"
            aria-labelledby="mfa-required-label"
            aria-describedby="mfa-policy-description"
            className={rowClassName}
          >
            <span
              id="mfa-required-label"
              data-slot="field-label"
              className={cn("text-sm font-medium", rowLabelClassName)}
            >
              Two-step required
            </span>
            <div className="flex min-w-0 flex-wrap gap-x-5">
              {(
                [
                  ["requireMfaAdmin", "administrators", "Administrators"],
                  ["requireMfaMember", "members", "Members"],
                  ["requireMfaGuest", "guests", "Guests"],
                ] as const
              ).map(([key, role, label]) => (
                <Field key={key}>
                  <FieldLabel
                    htmlFor={`mfa-${role}`}
                    className="flex min-h-11 items-center gap-2 font-normal xl:min-h-8"
                  >
                    <Checkbox
                      id={`mfa-${role}`}
                      aria-label={`Require two-step verification for ${role}`}
                      checked={current[key]}
                      onCheckedChange={(value) => changeSetting(key, value)}
                    />
                    <span>{label}</span>
                  </FieldLabel>
                </Field>
              ))}
            </div>
            <p
              id="mfa-policy-description"
              className={cn("text-muted-foreground text-sm", rowNoteClassName)}
            >
              Choose which roles must set up an authenticator app. People who
              already use one still enter a code when they sign in.
            </p>
          </div>
          {numberRow(
            "mfaGrace",
            "mfa-grace",
            "Enrollment grace (days)",
            0,
            30,
            {
              id: "mfa-grace-description",
              text: "Newly required accounts can enroll during the grace period. Zero days requires enrollment immediately.",
            },
          )}
          {editable.installation ? (
            <SelectRow
              id="session-timeout"
              label="Session timeout"
              value={current.timeout}
              error={errors.timeout}
              options={["15 minutes", "30 minutes", "60 minutes", "8 hours"]}
              onChange={(value) =>
                changeSetting(
                  "timeout",
                  value as SecuritySettingsFormFields["timeout"],
                )
              }
            />
          ) : (
            <ReadOnlyRows rows={[["Session timeout", current.timeout]]} />
          )}
        </div>
      )}

      <div ref={advancedRef} className="contents">
        <AdvancedSection
          key={advancedMount}
          storageKey={ADVANCED_STORAGE_KEY}
          setCount={advancedPolicySetCount(current)}
        >
          {readOnly ? (
            <ReadOnlyRows rows={[...ipRows, ...installationRows(current)]} />
          ) : (
            <>
              <PolicyGroup
                legend="IP allow list"
                describedBy="ip-allow-list-description"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <p
                    id="ip-allow-list-description"
                    className="text-muted-foreground min-w-0 flex-1 basis-64 text-sm"
                  >
                    An empty list allows all addresses. Include your current
                    address to keep access. You can add up to 100 addresses or
                    ranges.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    onClick={() => void addMyAddress()}
                  >
                    Use my address
                  </Button>
                </div>
                {current.ips.length ? (
                  <ul
                    aria-label="Allowed addresses"
                    className="flex min-w-0 flex-wrap gap-2"
                  >
                    {Array.from(new Set(current.ips)).map((address) => (
                      <li key={address} className="max-w-full min-w-0">
                        <Badge
                          variant="outline"
                          className="max-w-full gap-1 rounded-md py-0 pr-0 pl-3 font-normal"
                        >
                          <span className="min-w-0 break-all">{address}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="min-h-11 min-w-11 shrink-0"
                            aria-label={`Remove ${address}`}
                            onClick={() =>
                              changeSetting(
                                "ips",
                                current.ips.filter(
                                  (value) => value !== address,
                                ),
                              )
                            }
                          >
                            <X aria-hidden="true" className="size-4" />
                          </Button>
                        </Badge>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground text-sm">
                    All addresses are allowed.
                  </p>
                )}
                {errors.ips ? (
                  <p role="alert" className="text-destructive text-sm">
                    {errors.ips}
                  </p>
                ) : null}
                <Field
                  data-invalid={Boolean(errors.ipEntry)}
                  className={rowClassName}
                >
                  <FieldLabel htmlFor="ip-entry" className={rowLabelClassName}>
                    IP address or CIDR
                  </FieldLabel>
                  <div className="flex min-w-0 flex-wrap gap-2">
                    <Input
                      id="ip-entry"
                      className="min-h-11 min-w-0 flex-1 basis-48"
                      value={current.ipEntry}
                      maxLength={64}
                      placeholder="192.0.2.0/24 or 2001:db8::/64"
                      aria-invalid={Boolean(errors.ipEntry)}
                      aria-describedby={
                        errors.ipEntry
                          ? "ip-entry-error ip-allow-list-description"
                          : "ip-allow-list-description"
                      }
                      onChange={(event) =>
                        changeSetting("ipEntry", event.target.value)
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          addAddress();
                        }
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11"
                      disabled={!current.ipEntry.trim()}
                      onClick={addAddress}
                    >
                      Add address
                    </Button>
                  </div>
                  <FieldError id="ip-entry-error" className={rowNoteClassName}>
                    {errors.ipEntry}
                  </FieldError>
                </Field>
                {addressNotice ? (
                  <p role="status" className="text-muted-foreground text-sm">
                    {addressNotice}
                  </p>
                ) : null}
              </PolicyGroup>

              {editable.installation ? (
                <>
                  <PolicyGroup
                    legend="Password requirements"
                    describedBy="password-rules-description"
                  >
                    {numberRow(
                      "minimumLength",
                      "password-minimum",
                      "Minimum password length",
                      12,
                      128,
                      { id: "password-rules-description" },
                    )}
                    <CheckboxRow
                      id="password-mixed-case"
                      label="Require uppercase and lowercase letters"
                      checked={current.requireMixedCase}
                      onChange={(value) =>
                        changeSetting("requireMixedCase", value)
                      }
                    />
                    <CheckboxRow
                      id="password-number"
                      label="Require a number"
                      checked={current.requireNumber}
                      onChange={(value) =>
                        changeSetting("requireNumber", value)
                      }
                    />
                    <p
                      id="password-rules-description"
                      className="text-muted-foreground text-sm"
                    >
                      Use 12–128 characters. Common passwords are rejected.
                      These rules apply when a password is next set or changed;
                      existing passwords stay unchanged.
                    </p>
                  </PolicyGroup>

                  <PolicyGroup legend="Session limits">
                    <SelectRow
                      id="session-absolute-mode"
                      label="Total session lifetime"
                      value={
                        current.absoluteLifetime === "Off" ? "Off" : "Limited"
                      }
                      options={["Off", "Limited"]}
                      onChange={(value) =>
                        changeSetting(
                          "absoluteLifetime",
                          value === "Off" ? "Off" : "",
                        )
                      }
                    />
                    {current.absoluteLifetime !== "Off" &&
                      numberRow(
                        "absoluteLifetime",
                        "session-absolute-minutes",
                        "Lifetime (minutes)",
                        1,
                        43200,
                      )}
                    <p className="text-muted-foreground text-sm">
                      Limit the total time from sign-in, even while the session
                      stays active.
                    </p>
                    <SelectRow
                      id="session-cap-mode"
                      label="Concurrent session limit"
                      value={
                        current.concurrentLimit === "Off" ? "Off" : "Limited"
                      }
                      options={["Off", "Limited"]}
                      onChange={(value) =>
                        changeSetting(
                          "concurrentLimit",
                          value === "Off" ? "Off" : "",
                        )
                      }
                    />
                    {current.concurrentLimit !== "Off" &&
                      numberRow(
                        "concurrentLimit",
                        "session-cap",
                        "Maximum sessions",
                        1,
                        100,
                      )}
                    <p className="text-muted-foreground text-sm">
                      Applies when sign-in completes.
                    </p>
                  </PolicyGroup>

                  <PolicyGroup
                    legend="Retention"
                    describedBy={
                      retentionShortened
                        ? "security-retention-description"
                        : undefined
                    }
                  >
                    {numberRow(
                      "sessionRetention",
                      "session-retention-days",
                      "Session retention (days)",
                      1,
                      3650,
                    )}
                    {numberRow(
                      "eventRetention",
                      "security-event-retention-days",
                      "Security event retention (days)",
                      1,
                      3650,
                    )}
                    {retentionShortened ? (
                      <Alert
                        id="security-retention-description"
                        variant="warning"
                        role="note"
                      >
                        Shortening a period can make older sessions or security
                        events eligible for deletion at the next cleanup.
                      </Alert>
                    ) : null}
                  </PolicyGroup>

                  <PolicyGroup
                    legend="Sign-in attempts"
                    describedBy="login-policy-description"
                  >
                    {numberRow(
                      "loginThreshold",
                      "login-threshold",
                      "Failed attempts before lockout",
                      1,
                      100,
                    )}
                    {numberRow(
                      "loginWindow",
                      "login-window",
                      "Attempt window (minutes)",
                      1,
                      1440,
                    )}
                    {numberRow(
                      "loginCooldown",
                      "login-cooldown",
                      "Lockout duration (minutes)",
                      1,
                      1440,
                    )}
                    <p
                      id="login-policy-description"
                      className="text-muted-foreground text-sm"
                    >
                      Too many failed attempts within the window temporarily
                      block further attempts. Existing lockouts keep their
                      remaining time.
                    </p>
                  </PolicyGroup>
                </>
              ) : (
                <ReadOnlyRows rows={installationRows(current)} />
              )}
            </>
          )}
        </AdvancedSection>
      </div>

      {/* The dialog body scrolls; the actions stay at its bottom edge.
          -bottom-5 also covers the dialog's padding so fields don't show
          below. Cancel first, Discard only with edits, the state as a chip. */}
      {readOnly ? null : (
        <div
          role="group"
          aria-label="Policy actions"
          className="bg-card sticky -bottom-5 z-10 -mx-5 -mb-5 flex flex-wrap items-center justify-end gap-2 border-t px-5 pt-3 pb-5"
        >
          <span role="status" className="mr-auto">
            {dirty ? (
              <Badge variant="warning">Unsaved changes</Badge>
            ) : justSaved ? (
              <Badge variant="success">Account policy saved</Badge>
            ) : (
              <Badge variant="outline">Saved</Badge>
            )}
          </span>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={onCancel}
          >
            Cancel
          </Button>
          {dirty ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => clearDraft()}
            >
              Discard changes
            </Button>
          ) : null}
          <Button
            type="submit"
            className="min-h-11"
            disabled={!dirty}
            pending={saving}
            pendingLabel="Saving…"
          >
            Save settings
          </Button>
        </div>
      )}
    </form>
  );
}
