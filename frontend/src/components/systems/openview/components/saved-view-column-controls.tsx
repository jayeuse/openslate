"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import type {
  OpenViewDataSourceField,
  OpenViewPresentation,
} from "../adapters/views-api";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select } from "@/components/ui/select";

type ColumnLayout =
  "table" | "grid" | "gallery" | "kanban" | "calendar" | "timeline";
type ColumnPresentation = Pick<
  OpenViewPresentation,
  "pinnedFieldIds" | "density" | "cardSize" | "wrap"
>;

type SavedViewColumnControlsProps = {
  layout: ColumnLayout;
  fields: readonly OpenViewDataSourceField[];
  visibleFields: readonly OpenViewDataSourceField[];
  selectedVisibleFieldCount: number;
  visibleFieldIds: ReadonlySet<string>;
  pinnedFieldId: string | null;
  presentation: ColumnPresentation;
  onToggleVisibility: (fieldId: string, visible: boolean) => void;
  onTogglePinned: (fieldId: string, pinned: boolean) => void;
  onMove: (fieldId: string, direction: -1 | 1) => void;
  onDensityChange: (density: ColumnPresentation["density"]) => void;
  onCardSizeChange: (cardSize: ColumnPresentation["cardSize"]) => void;
  onWrapChange: (wrap: boolean) => void;
};

export function SavedViewColumnControls({
  layout,
  fields,
  visibleFields,
  selectedVisibleFieldCount,
  visibleFieldIds,
  pinnedFieldId,
  presentation,
  onToggleVisibility,
  onTogglePinned,
  onMove,
  onDensityChange,
  onCardSizeChange,
  onWrapChange,
}: SavedViewColumnControlsProps) {
  const isTable = layout === "table";
  const hasCardSettings = layout === "grid" || layout === "gallery";
  const pinnedIndex = pinnedFieldId
    ? visibleFields.findIndex((field) => field.id === pinnedFieldId)
    : -1;

  return (
    <section
      aria-labelledby="openview-presentation-fields-heading"
      className="flex min-w-0 flex-col gap-3"
    >
      <div>
        <h3
          data-slot="section-title"
          id="openview-presentation-fields-heading"
          className="font-medium"
        >
          {isTable
            ? "Visible columns and order"
            : hasCardSettings
              ? "Card detail fields"
              : "Record detail fields"}
        </h3>
        <p className="text-muted-foreground text-sm">
          {isTable
            ? "Choose the table columns and order. Keep one visible; a pinned column stays first while you scroll horizontally."
            : hasCardSettings
              ? "Choose the extra fields shown on cards and their order. The primary and secondary fields stay in the card heading."
              : "Choose the additional fields shown with each record. The primary and secondary fields stay in the record heading."}
        </p>
      </div>
      {fields.length ? (
        <div className="divide-y rounded-[var(--radius)] border">
          {fields.map((field) => {
            const visible = visibleFieldIds.has(field.id);
            const index = visibleFields.findIndex(
              (candidate) => candidate.id === field.id,
            );
            const isPinned = field.id === pinnedFieldId;
            const cannotMoveUp =
              isTable &&
              pinnedFieldId !== null &&
              pinnedIndex >= 0 &&
              !isPinned &&
              index - 1 === pinnedIndex;
            const cannotMoveDown =
              isTable &&
              pinnedIndex >= 0 &&
              (isPinned || index + 1 === pinnedIndex);

            return (
              <div
                key={field.id}
                className={`grid min-w-0 gap-2 px-3 py-2 sm:items-center ${isTable ? "sm:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_auto]" : "sm:grid-cols-[minmax(0,1fr)_auto]"}`}
              >
                <Field className="min-h-11 flex-row items-center gap-3">
                  <Checkbox
                    id={`openview-column-${field.id}`}
                    checked={visible}
                    disabled={
                      (isTable && visible && visibleFields.length <= 1) ||
                      (!visible && selectedVisibleFieldCount >= 20)
                    }
                    onCheckedChange={(checked) =>
                      onToggleVisibility(field.id, checked === true)
                    }
                  />
                  <FieldLabel
                    htmlFor={`openview-column-${field.id}`}
                    className="font-normal"
                  >
                    Show {field.name}
                  </FieldLabel>
                </Field>
                {isTable ? (
                  <Field className="min-h-11 flex-row items-center gap-3">
                    <Checkbox
                      id={`openview-pin-${field.id}`}
                      checked={presentation.pinnedFieldIds.includes(field.id)}
                      disabled={!visible}
                      onCheckedChange={(checked) =>
                        onTogglePinned(field.id, checked === true)
                      }
                    />
                    <FieldLabel
                      htmlFor={`openview-pin-${field.id}`}
                      className="font-normal"
                    >
                      Pin {field.name}
                    </FieldLabel>
                  </Field>
                ) : null}
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-11"
                    disabled={!visible || index <= 0 || cannotMoveUp}
                    aria-label={`Move ${field.name} up`}
                    onClick={() => onMove(field.id, -1)}
                  >
                    <ArrowUp aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-11"
                    disabled={
                      !visible ||
                      index === visibleFields.length - 1 ||
                      cannotMoveDown
                    }
                    aria-label={`Move ${field.name} down`}
                    onClick={() => onMove(field.id, 1)}
                  >
                    <ArrowDown aria-hidden="true" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p role="note" className="text-muted-foreground text-sm">
          Add fields to the view query before configuring its columns or card
          details.
        </p>
      )}

      {isTable || hasCardSettings ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {isTable ? (
            <Field className="w-full max-w-72">
              <FieldLabel htmlFor="openview-row-density">
                Row density
              </FieldLabel>
              <Select
                id="openview-row-density"
                className="min-h-11"
                value={presentation.density}
                onValueChange={(density) => {
                  if (density === "comfortable" || density === "compact")
                    onDensityChange(density);
                }}
              >
                <option value="comfortable">Comfortable</option>
                <option value="compact">Compact</option>
              </Select>
            </Field>
          ) : hasCardSettings ? (
            <Field className="w-full max-w-72">
              <FieldLabel htmlFor="openview-card-size">Card size</FieldLabel>
              <Select
                id="openview-card-size"
                className="min-h-11"
                value={presentation.cardSize}
                onValueChange={(cardSize) => {
                  if (cardSize === "comfortable" || cardSize === "compact")
                    onCardSizeChange(cardSize);
                }}
              >
                <option value="comfortable">Comfortable</option>
                <option value="compact">Compact</option>
              </Select>
            </Field>
          ) : null}
          {isTable || hasCardSettings ? (
            <Field className="min-h-11 flex-row items-center justify-between gap-3">
              <div className="flex flex-col gap-1">
                <FieldLabel htmlFor="openview-wrap-long-text">
                  Wrap long text
                </FieldLabel>
                <p
                  id="openview-wrap-long-text-help"
                  className="text-muted-foreground text-sm"
                >
                  Keep full values visible when space is tight.
                </p>
              </div>
              <Checkbox
                id="openview-wrap-long-text"
                aria-describedby="openview-wrap-long-text-help"
                checked={presentation.wrap}
                onCheckedChange={(checked) => onWrapChange(checked === true)}
              />
            </Field>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
