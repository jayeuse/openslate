"use client";

import { useEffect, useId, useState } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

export default function AppearancePage() {
  const preference = useUserPreferences();
  const [deviceReducesMotion, setDeviceReducesMotion] = useState(false);
  const motionLabelId = useId();
  const motionDescriptionId = useId();
  const keyboardLabelId = useId();
  const keyboardDescriptionId = useId();
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setDeviceReducesMotion(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  return (
    <>
      <PageHeader
        title="Appearance"
        description="Color, motion and convenience shortcuts follow your account. Text size and page spacing stay on this device. The organization look is set in Manage, under Organization."
      />
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
            <label className="grid gap-1.5 text-sm font-medium">
              Text size
              <select
                className="border-input bg-background min-h-11 w-full rounded-md border px-3 text-sm"
                value={preference.device.textSize}
                onChange={(event) =>
                  preference.setDevice({
                    textSize: event.target.value as DeviceTextSize,
                  })
                }
              >
                <option value="100">Default (100%)</option>
                <option value="112.5">Large (112.5%)</option>
                <option value="125">Larger (125%)</option>
              </select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Page spacing
              <select
                className="border-input bg-background min-h-11 w-full rounded-md border px-3 text-sm"
                value={preference.device.density}
                onChange={(event) =>
                  preference.setDevice({
                    density: event.target.value as PageDensity,
                  })
                }
              >
                <option value="default">Default</option>
                <option value="compact">Compact</option>
                <option value="spacious">Spacious</option>
              </select>
            </label>
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
                <p id={motionLabelId} className="text-sm font-medium">
                  Reduce motion
                </p>
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
                <p id={keyboardLabelId} className="text-sm font-medium">
                  Convenience shortcuts
                </p>
                <p
                  id={keyboardDescriptionId}
                  className="text-muted-foreground mt-1 text-sm"
                >
                  In the Sandbox, ? opens canvas help and 0 fits the canvas.
                  Buttons and essential editing keys always work.
                </p>
              </div>
              <Switch
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
