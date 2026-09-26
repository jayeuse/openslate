"use client";

import { useEffect, useState } from "react";
import { Check, Moon, Sun } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

  useEffect(() => {
    setPreferences(readBrowserAppearancePreferences());
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
        eyebrow="Settings"
        title="Appearance"
        description="Choose light or dark for your workspace. This setting applies to you on this device."
      />
      <div className="max-w-md">
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
      </div>
    </>
  );
}
