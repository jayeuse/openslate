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

const accents = [
  { id: "cobalt", label: "Cobalt", color: "#2563eb" },
  { id: "indigo", label: "Indigo", color: "#4f46e5" },
  { id: "emerald", label: "Emerald", color: "#059669" },
  { id: "neutral", label: "Neutral", color: "#334155" },
] as const;

const themes = [
  ["light", "Light", Sun],
  ["dark", "Dark", Moon],
] as const;

const densities = ["comfortable", "compact"] as const;
const radii = ["square", "subtle", "rounded"] as const;

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
        description="Choose how your workspace looks and feels."
      />
      <div className="grid max-w-4xl gap-5 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Theme</CardTitle>
          </CardHeader>
          <CardContent>
            <RadioGroup
              aria-label="Theme"
              value={preferences.theme}
              onValueChange={(value) =>
                apply({ theme: value as AppearancePreferences["theme"] })
              }
              className="grid grid-cols-2 gap-3"
            >
              {themes.map(([id, label, Icon]) => (
                <RadioGroupItem
                  key={id}
                  value={id}
                  className={cn(
                    "h-auto w-full flex-col items-center gap-3 rounded-md border p-5 text-sm",
                    preferences.theme === id
                      ? "border-primary bg-accent text-accent-foreground"
                      : "border-border hover:bg-muted",
                  )}
                >
                  <Icon size={20} />
                  <span>{label}</span>
                  {preferences.theme === id && <Check size={15} />}
                </RadioGroupItem>
              ))}
            </RadioGroup>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Accent</CardTitle>
          </CardHeader>
          <CardContent>
            <RadioGroup
              aria-label="Accent"
              value={preferences.accent}
              onValueChange={(value) =>
                apply({ accent: value as AppearancePreferences["accent"] })
              }
              className="grid grid-cols-2 gap-3"
            >
              {accents.map((item) => (
                <RadioGroupItem
                  key={item.id}
                  value={item.id}
                  className={cn(
                    "h-auto w-full items-center gap-3 rounded-md border p-3 text-sm",
                    preferences.accent === item.id
                      ? "border-primary bg-accent"
                      : "border-border hover:bg-muted",
                  )}
                >
                  <span
                    className="size-5 rounded-full"
                    style={{ backgroundColor: item.color }}
                  />
                  {item.label}
                  {preferences.accent === item.id && (
                    <Check className="ml-auto" size={15} />
                  )}
                </RadioGroupItem>
              ))}
            </RadioGroup>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Density</CardTitle>
          </CardHeader>
          <CardContent>
            <RadioGroup
              aria-label="Density"
              value={preferences.density}
              onValueChange={(value) =>
                apply({ density: value as AppearancePreferences["density"] })
              }
              className="flex flex-wrap gap-2"
            >
              {densities.map((item) => (
                <RadioGroupItem
                  key={item}
                  value={item}
                  className={cn(
                    "h-auto w-auto rounded-md border px-4 py-2 text-sm",
                    preferences.density === item
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input bg-card hover:bg-muted",
                  )}
                >
                  {item[0].toUpperCase() + item.slice(1)}
                </RadioGroupItem>
              ))}
            </RadioGroup>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Corner style</CardTitle>
          </CardHeader>
          <CardContent>
            <RadioGroup
              aria-label="Corner style"
              value={preferences.radius}
              onValueChange={(value) =>
                apply({ radius: value as AppearancePreferences["radius"] })
              }
              className="flex flex-wrap gap-2"
            >
              {radii.map((item) => (
                <RadioGroupItem
                  key={item}
                  value={item}
                  className={cn(
                    "h-auto w-auto rounded-md border px-4 py-2 text-sm",
                    preferences.radius === item
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input bg-card hover:bg-muted",
                  )}
                >
                  {item[0].toUpperCase() + item.slice(1)}
                </RadioGroupItem>
              ))}
            </RadioGroup>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
