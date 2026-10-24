"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectItem } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useUserPreferences } from "@/components/theme-provider";
import type { DeviceTextSize, PageDensity } from "@/lib/appearance-preferences";
import { cn } from "@/lib/utils";
import { RowNote, SettingsRow, SettingsSection } from "./rows";

const modes = [
  ["light", "Light", Sun],
  ["dark", "Dark", Moon],
  ["system", "System", Monitor],
] as const;

const narrowSelect = "min-w-0 md:max-w-70";

/**
 * Appearance (PD14): Color as a segmented radio group, Text size and Page
 * spacing (device choices), Motion and Keyboard shortcuts as switch rows
 * whose whole row is a 44px target on phones, and Start page. Each choice
 * saves at once.
 */
export function AppearanceSection({
  status,
  onChange,
}: {
  /** The shared preference status, when this group was changed last. */
  status: ReactNode;
  onChange: () => void;
}) {
  const preference = useUserPreferences();
  const [deviceReducesMotion, setDeviceReducesMotion] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setDeviceReducesMotion(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  return (
    <SettingsSection id="look" title="Appearance" end={status}>
      <SettingsRow label="Color">
        <RadioGroup
          aria-label="Color mode"
          value={preference.mode ?? ""}
          disabled={preference.disabled}
          onValueChange={(value) => {
            if (value === "light" || value === "dark" || value === "system") {
              onChange();
              preference.setMode(value);
            }
          }}
          className="bg-muted flex w-fit max-w-full gap-0.5 rounded-[var(--radius)] p-0.5"
        >
          {modes.map(([id, label, Icon]) => (
            <RadioGroupItem
              key={id}
              value={id}
              className={cn(
                "text-muted-foreground hover:text-foreground size-auto min-h-11 gap-1.5 rounded-md border-0 px-3 text-sm whitespace-nowrap xl:min-h-7",
                "data-checked:text-foreground data-checked:bg-card data-checked:font-medium data-checked:shadow-[0_0_0_1px_var(--rule)]",
              )}
            >
              <Icon aria-hidden="true" className="size-3.5" />
              {label}
            </RadioGroupItem>
          ))}
        </RadioGroup>
      </SettingsRow>
      <SettingsRow label="Text size" htmlFor="profile-text-size">
        <div className={narrowSelect}>
          <Select
            id="profile-text-size"
            className="min-h-11"
            value={preference.device.textSize}
            onValueChange={(value) => {
              onChange();
              preference.setDevice({ textSize: value as DeviceTextSize });
            }}
          >
            <SelectItem value="100">Default (100%)</SelectItem>
            <SelectItem value="112.5">Large (112.5%)</SelectItem>
            <SelectItem value="125">Larger (125%)</SelectItem>
          </Select>
        </div>
      </SettingsRow>
      <SettingsRow label="Page spacing" htmlFor="profile-density">
        <div className={narrowSelect}>
          <Select
            id="profile-density"
            className="min-h-11"
            aria-describedby="profile-density-note"
            value={preference.device.density}
            onValueChange={(value) => {
              onChange();
              preference.setDevice({ density: value as PageDensity });
            }}
          >
            <SelectItem value="default">Default</SelectItem>
            <SelectItem value="compact">Compact</SelectItem>
            <SelectItem value="spacious">Spacious</SelectItem>
          </Select>
        </div>
        <RowNote id="profile-density-note">
          Compact applies on wide screens with a mouse.
        </RowNote>
        {!preference.deviceStorageAvailable && (
          <p role="status" className="text-muted-foreground text-xs">
            Applied to this page only: this browser cannot keep it.
          </p>
        )}
      </SettingsRow>
      <SwitchRow
        id="profile-motion"
        row="Motion"
        label="Reduce motion"
        note={
          deviceReducesMotion ? "Your device already reduces motion." : null
        }
        checked={preference.motion === "reduce"}
        disabled={preference.disabled}
        onCheckedChange={(checked) => {
          onChange();
          preference.setMotion(checked ? "reduce" : "system");
        }}
      />
      <SwitchRow
        id="profile-shortcuts"
        row="Keyboard shortcuts"
        label="Use shortcuts"
        note={null}
        checked={preference.keyboardShortcuts === true}
        disabled={preference.disabled}
        onCheckedChange={(checked) => {
          onChange();
          preference.setKeyboardShortcuts(checked);
        }}
      />
      <SettingsRow label="Start page" htmlFor="profile-start-page">
        <div className={narrowSelect}>
          <Select
            id="profile-start-page"
            aria-label="Start page after sign-in"
            className="min-h-11"
            disabled={preference.disabled}
            value={preference.regional?.start_page ?? ""}
            onValueChange={(value) => {
              onChange();
              preference.setRegional({
                start_page: value as NonNullable<
                  typeof preference.regional
                >["start_page"],
              });
            }}
          >
            <SelectItem value="" disabled>
              Not loaded
            </SelectItem>
            <SelectItem value="automatic">Automatic</SelectItem>
            <SelectItem value="sandbox">Sandbox</SelectItem>
            <SelectItem value="boards">Boards</SelectItem>
            <SelectItem value="comms">OpenComms</SelectItem>
            <SelectItem value="access">Access</SelectItem>
            <SelectItem value="openview">OpenView</SelectItem>
            <SelectItem value="manage">Manage</SelectItem>
            <SelectItem value="platform">Platform</SelectItem>
          </Select>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

/** A switch with its label beside it; on phones the label row is 44px tall. */
function SwitchRow({
  id,
  row,
  label,
  note,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  row: string;
  label: string;
  note: string | null;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <SettingsRow label={row}>
      <div className="flex min-w-0 items-center gap-2.5">
        <Switch
          id={id}
          aria-labelledby={`${id}-label`}
          aria-describedby={note ? `${id}-note` : undefined}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onCheckedChange}
        />
        <label
          id={`${id}-label`}
          htmlFor={id}
          className="flex min-h-11 flex-1 cursor-pointer items-center text-sm xl:min-h-8"
        >
          {label}
        </label>
      </div>
      {note ? <RowNote id={`${id}-note`}>{note}</RowNote> : null}
    </SettingsRow>
  );
}
