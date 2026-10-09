"use client";

import { useEffect, useId, useState } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectItem } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  useUserPreferences,
  UserPreferencesStatus,
} from "@/components/theme-provider";
import type { DeviceTextSize, PageDensity } from "@/lib/appearance-preferences";
import { cn } from "@/lib/utils";

const modes = [
  ["light", "Light", Sun],
  ["dark", "Dark", Moon],
  ["system", "System", Monitor],
] as const;

const kbdClass =
  "border-border bg-muted text-foreground rounded-sm border px-1.5 py-0.5 font-mono text-xs";

export default function LookBehavior() {
  const preference = useUserPreferences();
  const [deviceReducesMotion, setDeviceReducesMotion] = useState(false);
  const motionLabelId = useId();
  const motionDescriptionId = useId();
  const keyboardLabelId = useId();
  const keyboardDescriptionId = useId();
  const motionSwitchId = useId();
  const keyboardSwitchId = useId();
  const textSizeId = useId();
  const densityId = useId();
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setDeviceReducesMotion(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  return (
    <>
      <div className="grid max-w-4xl gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Color</CardTitle>
          </CardHeader>
          <CardContent>
            <RadioGroup
              aria-label="Color mode"
              value={preference.mode ?? ""}
              disabled={preference.disabled}
              onValueChange={(value) => {
                if (value === "light" || value === "dark" || value === "system")
                  preference.setMode(value);
              }}
              className="grid grid-cols-3 gap-2"
            >
              {modes.map(([id, label, Icon]) => (
                <RadioGroupItem
                  key={id}
                  value={id}
                  className={cn(
                    "h-auto min-h-11 w-full flex-col items-center gap-2 rounded-md border p-3 text-sm",
                    preference.mode === id
                      ? "border-primary bg-action-tint text-action-text"
                      : "border-border text-foreground hover:bg-muted",
                  )}
                >
                  <Icon size={20} />
                  <span>{label}</span>
                  <Check
                    size={15}
                    aria-hidden="true"
                    className={preference.mode === id ? undefined : "invisible"}
                  />
                </RadioGroupItem>
              ))}
            </RadioGroup>
            <p className="text-muted-foreground mt-3 text-sm">
              System follows your device’s light or dark setting.
            </p>
            <div className="mt-3">
              <UserPreferencesStatus />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Text and display</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-1.5">
              <label htmlFor={textSizeId} className="text-sm font-medium">
                Text size
              </label>
              <Select
                id={textSizeId}
                className="min-h-11"
                value={preference.device.textSize}
                onValueChange={(value) =>
                  preference.setDevice({ textSize: value as DeviceTextSize })
                }
              >
                <SelectItem value="100">Default (100%)</SelectItem>
                <SelectItem value="112.5">Large (112.5%)</SelectItem>
                <SelectItem value="125">Larger (125%)</SelectItem>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <label htmlFor={densityId} className="text-sm font-medium">
                Page spacing
              </label>
              <Select
                id={densityId}
                className="min-h-11"
                value={preference.device.density}
                onValueChange={(value) =>
                  preference.setDevice({ density: value as PageDensity })
                }
              >
                <SelectItem value="default">Default</SelectItem>
                <SelectItem value="compact">Compact</SelectItem>
                <SelectItem value="spacious">Spacious</SelectItem>
              </Select>
            </div>
            <p className="text-muted-foreground text-sm">
              Compact applies on wide screens with a mouse or trackpad. Other
              screens use Default spacing. The Sandbox canvas keeps its own
              scale.
            </p>
            {!preference.deviceStorageAvailable && (
              <p role="status" className="text-muted-foreground text-sm">
                Applied for this page. Browser storage is unavailable, so these
                device choices may reset after a reload.
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Motion</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <label
                  id={motionLabelId}
                  htmlFor={motionSwitchId}
                  className="block text-sm font-medium"
                >
                  Reduce motion
                </label>
                <p
                  id={motionDescriptionId}
                  className="text-muted-foreground mt-1 text-sm"
                >
                  Highlights, tabs and panels move at once instead of gliding,
                  and loading placeholders hold still.{" "}
                  {deviceReducesMotion
                    ? "Your device already asks for reduced motion, so OpenSlate reduces it either way."
                    : "When off, OpenSlate follows your device setting."}
                </p>
              </div>
              <Switch
                id={motionSwitchId}
                aria-labelledby={motionLabelId}
                aria-describedby={motionDescriptionId}
                checked={preference.motion === "reduce"}
                disabled={preference.disabled}
                onCheckedChange={(checked) =>
                  preference.setMotion(checked ? "reduce" : "system")
                }
                className="mt-0.5"
              />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Keyboard</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <label
                  id={keyboardLabelId}
                  htmlFor={keyboardSwitchId}
                  className="block text-sm font-medium"
                >
                  Convenience shortcuts
                </label>
                <p
                  id={keyboardDescriptionId}
                  className="text-muted-foreground mt-1 text-sm"
                >
                  In the Sandbox, <kbd className={kbdClass}>?</kbd> opens canvas
                  help and <kbd className={kbdClass}>0</kbd> fits the canvas.
                  Buttons and essential editing keys always work.
                </p>
              </div>
              <Switch
                id={keyboardSwitchId}
                aria-labelledby={keyboardLabelId}
                aria-describedby={keyboardDescriptionId}
                checked={preference.keyboardShortcuts === true}
                disabled={preference.disabled}
                onCheckedChange={preference.setKeyboardShortcuts}
                className="mt-0.5"
              />
            </div>
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Start page</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <label
              htmlFor="profile-start-page"
              className="block text-sm font-medium"
            >
              Start page after sign-in
            </label>
            <Select
              id="profile-start-page"
              className="min-h-11"
              disabled={preference.disabled}
              value={preference.regional?.start_page ?? ""}
              onValueChange={(value) => {
                const start = value as NonNullable<
                  typeof preference.regional
                >["start_page"];
                preference.setRegional({ start_page: start });
              }}
            >
              <SelectItem value="" disabled>
                Preferences unavailable
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
            <p className="text-muted-foreground text-sm">
              Automatic opens OpenView, or Sandbox when nothing is published and
              you have access. If a saved page is unavailable to you, OpenSlate
              uses Automatic without changing your preference.
            </p>
          </CardContent>
        </Card>
        <section aria-label="Appearance preview" className="lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Live preview</CardTitle>
              <p className="text-muted-foreground text-sm">
                Read-only sample using your current appearance and the
                organization look.
              </p>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <div className="border-border grid gap-2 rounded-md border p-3">
                <p className="text-sm font-semibold">Equipment request</p>
                <p className="text-muted-foreground text-sm">
                  A clear title and supporting details.
                </p>
              </div>
              <dl className="divide-border divide-y text-sm">
                <div className="flex items-center justify-between gap-3 py-2">
                  <dt className="text-muted-foreground">Status</dt>
                  <dd className="bg-flow-tint text-flow-text rounded-md px-2 py-1">
                    Ready
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 py-2">
                  <dt className="text-muted-foreground">Reference</dt>
                  <dd className="tabular-nums">REQ-1042</dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        </section>
      </div>
    </>
  );
}
