"use client";

import {
  CalendarDays,
  Check,
  ChartGantt,
  ChevronDown,
  GalleryVerticalEnd,
  LayoutGrid,
  SquareKanban,
  Table2,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { OpenViewSavedView } from "../adapters/views-api";

type LiveRecordLayout = OpenViewSavedView["presentation"]["layout"];

const LAYOUTS: readonly {
  value: LiveRecordLayout;
  label: string;
  icon: LucideIcon;
}[] = [
  { value: "table", label: "Table", icon: Table2 },
  { value: "grid", label: "Grid", icon: LayoutGrid },
  { value: "gallery", label: "Gallery", icon: GalleryVerticalEnd },
  { value: "kanban", label: "Kanban", icon: SquareKanban },
  { value: "calendar", label: "Calendar", icon: CalendarDays },
  { value: "timeline", label: "Timeline", icon: ChartGantt },
];

/**
 * The layout of the module page's records (OD4): one control that names the
 * current layout, opening the six layouts with their icons and, under them,
 * the settings of the chosen layout.
 */
export function LayoutMenu({
  layout,
  disabled,
  onLayoutChange,
  onOpenSettings,
}: {
  layout: LiveRecordLayout;
  disabled: boolean;
  onLayoutChange: (layout: LiveRecordLayout) => void;
  onOpenSettings: () => void;
}) {
  const current = LAYOUTS.find((item) => item.value === layout) ?? LAYOUTS[0];
  const Icon = current.icon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            aria-label={`Layout: ${current.label}`}
          />
        }
      >
        <Icon aria-hidden="true" />
        {current.label}
        <ChevronDown aria-hidden="true" className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="slim-ui min-w-48">
        {/* Plain items marked as radios: the menu's radio parts would join
            the shared menu code every page loads. */}
        {LAYOUTS.map((item) => (
          <DropdownMenuItem
            key={item.value}
            role="menuitemradio"
            aria-checked={item.value === layout}
            className="min-h-11 xl:min-h-8"
            onClick={() => onLayoutChange(item.value)}
          >
            <item.icon aria-hidden="true" />
            {item.label}
            {item.value === layout ? (
              <Check aria-hidden="true" className="ml-auto" />
            ) : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="min-h-11 xl:min-h-8"
          onClick={onOpenSettings}
        >
          Layout settings…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
