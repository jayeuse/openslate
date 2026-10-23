"use client";

import { useState } from "react";
import { SearchSelect } from "@/components/ui/search-select";
import { cn } from "@/lib/utils";
import { usePeopleSearch } from "../hooks/use-people-search";
import { personName, personState, sponsorOptions } from "../helpers/people";
import type { AccessDirectoryUser } from "../state/api";
import { detailRowClassName } from "./people-fields";

/**
 * A label-left row for the search field (the sheet Details layout): the
 * shared field's own wrapper steps aside, so its label takes the 128px
 * muted column and the trigger and any error take the field column.
 */
const searchRowClassName = cn(
  detailRowClassName,
  "md:space-y-0 md:[&>*]:contents md:[&_[data-slot=field-label]]:text-muted-foreground md:[&_[role=alert]]:col-start-2",
);

/** Sponsors use the same bounded people source as the member and event pickers. */
export function SponsorSearchSelect({
  id,
  value,
  disabled,
  error,
  layout = "stacked",
  onChange,
}: {
  id: string;
  value: string;
  disabled?: boolean;
  error?: string;
  /** "row" puts the label in the sheet's label column from 768px. */
  layout?: "stacked" | "row";
  onChange: (value: string) => void;
}) {
  const [now] = useState(() => Date.now());
  const people = usePeopleSearch({ selectedIds: value ? [value] : [] });
  const users = people.items.filter(
    (person): person is AccessDirectoryUser => "is_deleted" in person,
  );
  const selected = people.selectedItems.find((person) => person.id === value);
  const active =
    selected &&
    "is_deleted" in selected &&
    selected.role !== "guest" &&
    personState(selected, now).id === "active";
  return (
    <div className={cn("space-y-1", layout === "row" && searchRowClassName)}>
      <SearchSelect
        id={id}
        popupClassName="access-ui"
        label="Sponsor"
        value={value}
        options={sponsorOptions(users, now)}
        selectedOption={
          selected
            ? {
                value,
                label: `${personName(selected)}${active ? "" : " (not active)"}`,
                disabled: !active,
              }
            : undefined
        }
        onValueChange={onChange}
        search={people.search}
        onSearchChange={people.onSearchChange}
        loading={people.loading || people.selectedLoading}
        error={people.error}
        validationError={error}
        onRetry={people.retry}
        hasMore={people.hasMore}
        onLoadMore={() => void people.loadMore()}
        loadingMore={people.loadingMore}
        disabled={disabled}
        placeholder="Choose a sponsor"
      />
    </div>
  );
}
