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
import { cn } from "@/lib/utils";

const modes = [
  ["light", "Light", Sun],
  ["dark", "Dark", Moon],
] as const;

export default function AppearancePage() {
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
    return () => query.removeEventListener("change", sync);
  }, []);

  function apply(next: Partial<AppearancePreferences>) {
    const values = { ...preferences, ...next };
    setPreferences(values);
    applyAppearancePreferences(values);
    persistAppearancePreferences(values);
  }
  return (
    <>
      <PageHeader
        title="Appearance"
        description="Choose light or dark, and how much the workspace moves. These settings apply to you on this device. The organization look is set in Manage, under Organization."
      />
      <div className="grid max-w-md gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Color mode</CardTitle>
          </CardHeader>
          <CardContent>
            <RadioGroup
              aria-label="Color mode"
              value={preferences.mode}
              onValueChange={(value) =>
                apply({ mode: value as AppearancePreferences["mode"] })
              }
              className="grid grid-cols-2 gap-3"
            >
              {modes.map(([id, label, Icon]) => (
                <RadioGroupItem
                  key={id}
                  value={id}
                  className={cn(
                    "h-auto w-full flex-col items-center gap-3 rounded-md border p-5 text-sm",
                    preferences.mode === id
                      ? "border-primary bg-action-tint text-action-text"
                      : "border-border text-foreground hover:bg-muted",
                  )}
                >
                  <Icon size={20} />
                  <span>{label}</span>
                  <Check
                    size={15}
                    aria-hidden="true"
                    className={
                      preferences.mode === id ? undefined : "invisible"
                    }
                  />
                </RadioGroupItem>
              ))}
            </RadioGroup>
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
                  Pages fade instead of sliding, and highlights and tabs move
                  without gliding.{" "}
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
