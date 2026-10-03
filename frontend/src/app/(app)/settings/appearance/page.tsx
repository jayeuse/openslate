"use client";

import { useEffect, useId, useState } from "react";
import { Check, Moon, Sun } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import {
  applyAppearancePreferences,
  DEFAULT_APPEARANCE_PREFERENCES,
  persistAppearancePreferences,
  readBrowserAppearancePreferences,
  type AppearancePreferences,
} from "@/lib/appearance-preferences";
import {
  useUserThemePreference,
  UserThemeStatus,
} from "@/components/theme-provider";
import { cn } from "@/lib/utils";

const modes = [
  ["light", "Light", Sun],
  ["dark", "Dark", Moon],
] as const;

export default function AppearancePage() {
  const theme = useUserThemePreference();
  const [preferences, setPreferences] = useState<AppearancePreferences>(
    DEFAULT_APPEARANCE_PREFERENCES,
  );
  // The device's own reduced-motion setting always applies; say so.
  const [deviceReducesMotion, setDeviceReducesMotion] = useState(false);
  const motionLabelId = useId();
  const motionDescriptionId = useId();

  useEffect(() => {
    setPreferences(readBrowserAppearancePreferences());
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setDeviceReducesMotion(query.matches);
    sync();
    query.addEventListener("change", sync);
    const syncStoredMotion = (event: StorageEvent) => {
      if (event.key === null || event.key === "openslate-motion")
        setPreferences(readBrowserAppearancePreferences());
    };
    window.addEventListener("storage", syncStoredMotion);
    return () => {
      query.removeEventListener("change", sync);
      window.removeEventListener("storage", syncStoredMotion);
    };
  }, []);

  function apply(next: Partial<AppearancePreferences>) {
    const values = {
      ...preferences,
      ...next,
      mode: theme.mode ?? readBrowserAppearancePreferences().mode,
    };
    setPreferences(values);
    applyAppearancePreferences({ ...values, mode: theme.mode ?? "light" });
    persistAppearancePreferences(values);
  }
  return (
    <>
      <PageHeader
        title="Appearance"
        description="Choose light or dark, and how much the workspace moves. Color mode saves to your account. Reduced motion applies on this device. The organization look is set in Manage, under Organization."
      />
      <div className="grid max-w-md gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Color mode</CardTitle>
          </CardHeader>
          <CardContent>
            <RadioGroup
              aria-label="Color mode"
              value={theme.mode ?? ""}
              disabled={theme.disabled}
              onValueChange={(value) =>
                theme.setMode(value === "dark" ? "dark" : "light")
              }
              className="grid grid-cols-2 gap-3"
            >
              {modes.map(([id, label, Icon]) => (
                <RadioGroupItem
                  key={id}
                  value={id}
                  className={cn(
                    "h-auto w-full flex-col items-center gap-3 rounded-md border p-5 text-sm",
                    theme.mode === id
                      ? "border-primary bg-action-tint text-action-text"
                      : "border-border text-foreground hover:bg-muted",
                  )}
                >
                  <Icon size={20} />
                  <span>{label}</span>
                  <Check
                    size={15}
                    aria-hidden="true"
                    className={theme.mode === id ? undefined : "invisible"}
                  />
                </RadioGroupItem>
              ))}
            </RadioGroup>
            <div className="mt-3">
              <UserThemeStatus />
            </div>
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
                  Highlights, tabs, and panels move at once instead of gliding,
                  and loading placeholders hold still.{" "}
                  {deviceReducesMotion
                    ? "Your device already asks for reduced motion, so OpenSlate reduces it either way."
                    : "When off, OpenSlate follows your device setting."}
                </p>
              </div>
              <Switch
                aria-labelledby={motionLabelId}
                aria-describedby={motionDescriptionId}
                checked={preferences.reduceMotion}
                onCheckedChange={(checked) => apply({ reduceMotion: checked })}
                className="mt-0.5"
              />
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
