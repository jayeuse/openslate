"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  listOpenViewReportAudienceRoles,
  listOpenViewReportAudienceUsers,
  type OpenViewReportAudienceInput,
} from "../adapters/reports-api";

const PAGE_SIZE = 25;
type TargetKind = "role" | "user";
type Choice = { id: string; label: string };
type ListedChoices = {
  key: string;
  items: Choice[];
  nextOffset: number;
  hasMore: boolean;
};
type SelectedChoice = {
  key: string;
  status: "loading" | "available" | "unavailable" | "error";
  label?: string;
};

export type ReportAudienceSelectorProps = {
  audience: OpenViewReportAudienceInput;
  onChange: (audience: OpenViewReportAudienceInput) => void;
  disabled: boolean;
};

async function readChoices(
  kind: TargetKind,
  options: { search?: string; id?: string; offset: number; limit: number },
): Promise<{ items: Choice[]; count: number; hasMore: boolean }> {
  if (kind === "role") {
    const page = await listOpenViewReportAudienceRoles(options);
    return {
      items: page.items.map((item) => ({ id: item.id, label: item.role })),
      count: page.pagination.count,
      hasMore: page.pagination.hasMore,
    };
  }
  const page = await listOpenViewReportAudienceUsers(options);
  return {
    items: page.items.map((item) => ({ id: item.id, label: item.username })),
    count: page.pagination.count,
    hasMore: page.pagination.hasMore,
  };
}

export function ReportAudienceSelector({
  audience,
  onChange,
  disabled,
}: ReportAudienceSelectorProps) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [listed, setListed] = useState<ListedChoices>({
    key: "",
    items: [],
    nextOffset: 0,
    hasMore: false,
  });
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [selected, setSelected] = useState<SelectedChoice | null>(null);
  const [resolveRefresh, setResolveRefresh] = useState(0);

  const kind: TargetKind | null =
    audience.kind === "role" || audience.kind === "user" ? audience.kind : null;
  const selectedId =
    audience.kind === "role"
      ? audience.roleId
      : audience.kind === "user"
        ? audience.userId
        : "";
  const listKey = `${kind}:${search}`;
  const choices = listed.key === listKey ? listed.items : [];
  const hasMore = listed.key === listKey && listed.hasMore;
  const choicesLoading = loading || (listed.key !== listKey && !listError);
  const selectedKey = `${kind}:${selectedId}`;
  const selectedStatus =
    selectedId && selected?.key === selectedKey ? selected : null;

  useEffect(() => {
    if (!kind) return;
    let active = true;
    setLoading(true);
    setListError("");
    void readChoices(kind, {
      limit: PAGE_SIZE,
      offset,
      ...(search ? { search } : {}),
    })
      .then((page) => {
        if (!active) return;
        setListed((current) => ({
          key: listKey,
          items:
            offset === 0 || current.key !== listKey
              ? page.items
              : [
                  ...current.items,
                  ...page.items.filter(
                    (item) =>
                      !current.items.some(
                        (existing) => existing.id === item.id,
                      ),
                  ),
                ],
          nextOffset: offset + page.count,
          hasMore: page.hasMore,
        }));
      })
      .catch(() => {
        if (active)
          setListError("Audience choices could not be loaded. Try again.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [kind, listKey, offset, refresh, search]);

  useEffect(() => {
    if (!kind || !selectedId) return;
    let active = true;
    setSelected({ key: selectedKey, status: "loading" });
    void readChoices(kind, { id: selectedId, limit: 1, offset: 0 })
      .then((page) => {
        if (!active) return;
        const choice = page.items.find((item) => item.id === selectedId);
        setSelected(
          choice
            ? { key: selectedKey, status: "available", label: choice.label }
            : { key: selectedKey, status: "unavailable" },
        );
      })
      .catch(() => {
        if (active) setSelected({ key: selectedKey, status: "error" });
      });
    return () => {
      active = false;
    };
  }, [kind, resolveRefresh, selectedId, selectedKey]);

  function changeKind(value: string): void {
    setQuery("");
    setSearch("");
    setOffset(0);
    setListError("");
    setRefresh((current) => current + 1);
    if (value === "private" || value === "everyone") {
      onChange({ kind: value });
    } else if (value === "role") {
      onChange({ kind: "role", roleId: "" });
    } else if (value === "user") {
      onChange({ kind: "user", userId: "" });
    }
  }

  function changeTarget(id: string): void {
    if (kind === "role") onChange({ kind, roleId: id });
    if (kind === "user") onChange({ kind, userId: id });
  }

  function submitSearch(): void {
    if (disabled || loading) return;
    setSearch(query.trim());
    setOffset(0);
    setListError("");
    setRefresh((current) => current + 1);
  }

  const targetName = kind === "role" ? "role" : "user";
  const selectedIsListed = choices.some((choice) => choice.id === selectedId);
  const selectedLabel =
    selectedStatus?.status === "available"
      ? selectedStatus.label
      : selectedStatus?.status === "unavailable"
        ? `Saved ${targetName} is unavailable`
        : selectedStatus?.status === "error"
          ? `Selected ${targetName} could not be checked`
          : `Checking selected ${targetName}…`;

  return (
    <FieldSet>
      <FieldLegend>Audience</FieldLegend>
      <Field>
        <FieldLabel htmlFor="report-audience-kind">
          Who can open saved runs?
        </FieldLabel>
        <Select
          id="report-audience-kind"
          className="min-h-11"
          value={audience.kind}
          onValueChange={changeKind}
          disabled={disabled}
        >
          <option value="private">Private to me</option>
          <option value="everyone">Everyone with Records access</option>
          <option value="role">One role</option>
          <option value="user">One person</option>
        </Select>
        <FieldDescription>
          Report owners follow this audience too. Changing it may affect who can
          open saved runs.
        </FieldDescription>
      </Field>
      {kind ? (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <Field className="min-w-40 flex-1">
              <FieldLabel htmlFor="report-audience-search">
                Search {kind === "role" ? "roles" : "people"}
              </FieldLabel>
              <Input
                id="report-audience-search"
                className="min-h-11"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    submitSearch();
                  }
                }}
                maxLength={100}
                disabled={disabled}
              />
            </Field>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={disabled || loading}
              onClick={submitSearch}
            >
              Search
            </Button>
          </div>
          <Field>
            <FieldLabel htmlFor="report-audience-target">
              {kind === "role" ? "Role" : "Person"}
            </FieldLabel>
            <Select
              id="report-audience-target"
              className="min-h-11"
              value={selectedId}
              onValueChange={changeTarget}
              disabled={disabled}
              aria-invalid={!selectedId}
              aria-describedby={
                !selectedId ? "report-audience-target-help" : undefined
              }
            >
              <option value="">Choose a {targetName}</option>
              {selectedId && !selectedIsListed ? (
                <option value={selectedId}>{selectedLabel}</option>
              ) : null}
              {choices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
            </Select>
            {!selectedId ? (
              <FieldDescription id="report-audience-target-help">
                Choose a {targetName} before saving.
              </FieldDescription>
            ) : null}
          </Field>
          {selectedStatus?.status === "unavailable" ? (
            <Alert role="alert" variant="destructive">
              This saved {targetName} is no longer available. Choose another{" "}
              {targetName} before saving.
            </Alert>
          ) : null}
          {selectedStatus?.status === "error" ? (
            <Alert role="alert" variant="destructive">
              The selected {targetName} could not be checked.
              <Button
                type="button"
                variant="outline"
                className="ml-3 min-h-11"
                onClick={() => setResolveRefresh((current) => current + 1)}
              >
                Retry
              </Button>
            </Alert>
          ) : null}
          {listError ? (
            <Alert role="alert" variant="destructive">
              {listError}
              <Button
                type="button"
                variant="outline"
                className="ml-3 min-h-11"
                onClick={() => setRefresh((current) => current + 1)}
              >
                Retry
              </Button>
            </Alert>
          ) : null}
          {choicesLoading ? (
            <p role="status" className="text-muted-foreground text-sm">
              Loading audience choices…
            </p>
          ) : null}
          {!choicesLoading && !listError && choices.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No matching {kind === "role" ? "roles" : "people"}.
            </p>
          ) : null}
          {hasMore ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 self-start"
              disabled={disabled || loading}
              onClick={() => setOffset(listed.nextOffset)}
            >
              Load more {kind === "role" ? "roles" : "people"}
            </Button>
          ) : null}
        </>
      ) : null}
    </FieldSet>
  );
}
