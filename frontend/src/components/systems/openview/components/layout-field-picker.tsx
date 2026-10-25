"use client";

import { filterRowClassName } from "@/components/systems/access/components/access-toolbar";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select } from "@/components/ui/select";

type PickerRow = {
  id: string;
  label: string;
  value: string | null | undefined;
  options: readonly { id: string; name: string }[];
  onChange: (fieldId: string | null) => void;
};

/**
 * The empty state of a layout that needs fields (OD8): Kanban, Calendar, and
 * Timeline ask for them where the records would be, instead of naming a
 * setting somewhere else. Without an eligible field the state says so.
 */
export function LayoutFieldPicker({
  title,
  missing,
  rows,
}: {
  title: string;
  /** Said when the module has no eligible field. */
  missing: string;
  rows: readonly PickerRow[];
}) {
  const choosable = rows.every((row) => row.options.length > 0);
  return (
    <Empty className="min-h-64 border">
      <EmptyHeader>
        <EmptyTitle>{choosable ? title : missing}</EmptyTitle>
        {choosable ? null : (
          <EmptyDescription>
            Add one in the Sandbox, or choose another layout.
          </EmptyDescription>
        )}
      </EmptyHeader>
      {choosable ? (
        <EmptyContent className="grid w-full max-w-sm gap-2 text-left">
          {rows.map((row) => (
            <Field key={row.id} className={filterRowClassName}>
              <FieldLabel htmlFor={row.id} className="md:text-muted-foreground">
                {row.label}
              </FieldLabel>
              <Select
                id={row.id}
                className="min-h-11 w-full"
                value={row.value ?? ""}
                onValueChange={(value) => row.onChange(value || null)}
              >
                <option value="">Choose a field</option>
                {row.options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </Select>
            </Field>
          ))}
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
