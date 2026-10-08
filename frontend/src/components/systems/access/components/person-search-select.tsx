"use client";

import { useState } from "react";
import { SearchSelect } from "@/components/ui/search-select";
import { usePeopleSearch } from "../hooks/use-people-search";
import { personName, personState, sponsorOptions } from "../helpers/people";
import type { AccessDirectoryUser } from "../state/api";

/** Sponsors use the same bounded people source as the member and event pickers. */
export function SponsorSearchSelect({
  id,
  value,
  disabled,
  error,
  onChange,
}: {
  id: string;
  value: string;
  disabled?: boolean;
  error?: string;
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
    <div className="space-y-1">
      <SearchSelect
        id={id}
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
