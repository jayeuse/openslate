"use client";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardFooter } from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { Select, SelectItem } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type ManageSection,
  type ManageSettings,
  type ManageSnapshotDiff,
} from "../state/state";
export function SettingSelect({
  id,
  label,
  value,
  options,
  optionLabels,
  onChange,
  description,
  error,
}: {
  id: string;
  label: string;
  value: string;
  options: readonly string[];
  optionLabels?: Readonly<Record<string, string>>;
  onChange: (value: string) => void;
  description?: string;
  error?: string;
}) {
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;

  return (
    <Field data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        id={id}
        value={options.includes(value) ? value : ""}
        placeholder={
          options.includes(value) ? undefined : "Choose a valid option"
        }
        onValueChange={onChange}
        aria-describedby={
          [descriptionId, errorId].filter(Boolean).join(" ") || undefined
        }
        aria-invalid={Boolean(error)}
        className="min-h-11"
      >
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {optionLabels?.[option] ?? option}
          </SelectItem>
        ))}
      </Select>
      {description ? (
        <FieldDescription id={descriptionId} className="md:sr-only">
          {description}
        </FieldDescription>
      ) : null}
      <FieldError id={errorId}>{error}</FieldError>
    </Field>
  );
}

export function SettingInput({
  id,
  label,
  value,
  onChange,
  description,
  error,
  required = false,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  description?: string;
  error?: string | null;
  required?: boolean;
  placeholder?: string;
}) {
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ");

  return (
    <Field data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        value={value}
        required={required}
        placeholder={placeholder}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy || undefined}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-11"
      />
      {description ? (
        <FieldDescription id={descriptionId} className="md:sr-only">
          {description}
        </FieldDescription>
      ) : null}
      <FieldError id={errorId}>{error}</FieldError>
    </Field>
  );
}

export function SettingActions({
  dirty,
  onDiscard,
  onSave,
}: {
  dirty: boolean;
  onDiscard: () => void;
  onSave: () => void;
}) {
  return (
    <CardFooter className="flex flex-wrap justify-end gap-2 px-0 pt-4">
      {dirty ? (
        <Badge variant="warning">Unsaved changes</Badge>
      ) : (
        <Badge variant="outline">Saved</Badge>
      )}
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        onClick={onDiscard}
        disabled={!dirty}
      >
        Discard changes
      </Button>
      <Button
        type="button"
        className="min-h-11"
        onClick={onSave}
        disabled={!dirty}
      >
        Save settings
      </Button>
    </CardFooter>
  );
}

export function SectionHeading({
  title,
  description,
  dirty,
}: {
  title: string;
  description: string;
  dirty?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        <p className="text-muted-foreground mt-1 max-w-3xl text-sm md:sr-only">
          {description}
        </p>
      </div>
      {dirty ? <Badge variant="warning">Unsaved</Badge> : null}
    </div>
  );
}

export function SummaryItem({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b py-3 last:border-0">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="text-right text-sm font-medium">{value}</dd>
    </div>
  );
}

export function SettingsChanges({
  differences,
}: {
  differences: ManageSnapshotDiff[];
}) {
  const [page, setPage] = useState(1);
  if (!differences.length)
    return (
      <p className="text-muted-foreground py-3 text-sm">
        No saved settings will change.
      </p>
    );
  const pageCount = Math.ceil(differences.length / 5);
  const safePage = Math.min(page, pageCount);
  const visibleDifferences = differences.slice(
    (safePage - 1) * 5,
    safePage * 5,
  );
  return (
    <div className="mt-3 space-y-3">
      <Table aria-label="Settings changes">
        <TableHeader>
          <TableRow>
            <TableHead>Setting</TableHead>
            <TableHead>Current value</TableHead>
            <TableHead>Replacement</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visibleDifferences.map((difference) => (
            <TableRow key={difference.key}>
              <TableCell className="whitespace-normal">
                {difference.label}
              </TableCell>
              <TableCell className="wrap-anywhere whitespace-normal">
                {difference.before || "Not set"}
              </TableCell>
              <TableCell className="wrap-anywhere whitespace-normal">
                {difference.after || "Not set"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {pageCount > 1 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <p className="text-muted-foreground text-sm">
            Page {safePage} of {pageCount}
          </p>
          <Pagination
            aria-label="Settings change pages"
            className="mx-0 w-auto justify-start sm:justify-end"
          >
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  href="#settings-changes"
                  aria-disabled={safePage === 1}
                  tabIndex={safePage === 1 ? -1 : undefined}
                  className={
                    safePage === 1
                      ? "pointer-events-none opacity-50"
                      : undefined
                  }
                  onClick={(event) => {
                    event.preventDefault();
                    if (safePage > 1) setPage(safePage - 1);
                  }}
                />
              </PaginationItem>
              <PaginationItem>
                <PaginationLink
                  href="#settings-changes"
                  size="default"
                  isActive
                  aria-label={`Settings change page ${safePage} of ${pageCount}`}
                  onClick={(event) => event.preventDefault()}
                >
                  {safePage} / {pageCount}
                </PaginationLink>
              </PaginationItem>
              <PaginationItem>
                <PaginationNext
                  href="#settings-changes"
                  aria-disabled={safePage === pageCount}
                  tabIndex={safePage === pageCount ? -1 : undefined}
                  className={
                    safePage === pageCount
                      ? "pointer-events-none opacity-50"
                      : undefined
                  }
                  onClick={(event) => {
                    event.preventDefault();
                    if (safePage < pageCount) setPage(safePage + 1);
                  }}
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </div>
      ) : null}
    </div>
  );
}
export type SettingsPanelForm = {
  dirty: boolean;
  current: ManageSettings;
  errors: Partial<Record<keyof ManageSettings, string>>;
  changeSetting: (
    section: ManageSection,
    key: keyof ManageSettings,
    value: string,
  ) => void;
  saveSection: (section: ManageSection) => Promise<void>;
  clearDraft: (section: ManageSection) => void;
};
