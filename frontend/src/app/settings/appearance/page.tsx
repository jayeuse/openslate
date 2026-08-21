"use client";

import { useState } from "react";
import { Check, Moon, Sun } from "lucide-react";
import { AppPage } from "@/components/app-page";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const accents = [
  { id: "cobalt", label: "Cobalt", color: "#2563eb" },
  { id: "indigo", label: "Indigo", color: "#4f46e5" },
  { id: "emerald", label: "Emerald", color: "#059669" },
  { id: "neutral", label: "Neutral", color: "#334155" },
];
export default function AppearancePage() {
  const [theme, setTheme] = useState("light");
  const [accent, setAccent] = useState("cobalt");
  const [density, setDensity] = useState("comfortable");
  const [radius, setRadius] = useState("subtle");
  function apply(next: {
    theme?: string;
    accent?: string;
    density?: string;
    radius?: string;
  }) {
    const values = {
      theme: next.theme ?? theme,
      accent: next.accent ?? accent,
      density: next.density ?? density,
      radius: next.radius ?? radius,
    };
    setTheme(values.theme);
    setAccent(values.accent);
    setDensity(values.density);
    setRadius(values.radius);
    document.documentElement.classList.toggle("dark", values.theme === "dark");
    document.documentElement.setAttribute("data-accent", values.accent);
    document.documentElement.setAttribute("data-density", values.density);
    document.documentElement.setAttribute("data-radius", values.radius);
    localStorage.setItem("openslate-theme", values.theme);
    localStorage.setItem("openslate-accent", values.accent);
    localStorage.setItem("openslate-density", values.density);
    localStorage.setItem("openslate-radius", values.radius);
  }
  return (
    <AppPage>
      <PageHeader
        eyebrow="Settings"
        title="Appearance"
        description="Tune the workspace without changing the information architecture."
      />
      <div className="grid max-w-4xl gap-5 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Theme</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3">
            {[
              ["light", "Light", Sun],
              ["dark", "Dark", Moon],
            ].map(([id, label, Icon]) => (
              <button
                key={String(id)}
                onClick={() => apply({ theme: String(id) })}
                className={cn(
                  "flex flex-col items-center gap-3 rounded-md border p-5 text-sm",
                  theme === id
                    ? "border-primary bg-accent text-accent-foreground"
                    : "border-border hover:bg-muted",
                )}
              >
                <Icon size={20} />
                <span>{String(label)}</span>
                {theme === id && <Check size={15} />}
              </button>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Accent</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3">
            {accents.map((item) => (
              <button
                key={item.id}
                onClick={() => apply({ accent: item.id })}
                className={cn(
                  "flex items-center gap-3 rounded-md border p-3 text-sm",
                  accent === item.id
                    ? "border-primary bg-accent"
                    : "border-border hover:bg-muted",
                )}
              >
                <span
                  className="size-5 rounded-full"
                  style={{ backgroundColor: item.color }}
                />
                {item.label}
                {accent === item.id && <Check className="ml-auto" size={15} />}
              </button>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Density</CardTitle>
          </CardHeader>
          <CardContent className="flex gap-2">
            {["comfortable", "compact"].map((item) => (
              <Button
                key={item}
                variant={density === item ? "default" : "outline"}
                onClick={() => apply({ density: item })}
              >
                {item[0].toUpperCase() + item.slice(1)}
              </Button>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Corner style</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {["square", "subtle", "rounded"].map((item) => (
              <Button
                key={item}
                variant={radius === item ? "default" : "outline"}
                onClick={() => apply({ radius: item })}
              >
                {item[0].toUpperCase() + item.slice(1)}
              </Button>
            ))}
          </CardContent>
        </Card>
      </div>
    </AppPage>
  );
}
