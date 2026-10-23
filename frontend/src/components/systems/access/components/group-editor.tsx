"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Alert } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { Field, FieldLabel } from "@/components/ui/field";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useVerifiedWorkspaceUserId } from "@/components/systems/shared/runtime/workspace-identity";

import { afterAccessGroupChange } from "../adapters/access-queries";
import type { ConflictChoice, FieldConflict } from "../helpers/editor-helpers";
import {
  accessConflicts,
  accessSummary,
  detailsConflicts,
  detailsOf,
  detailsPatch,
  groupErrorMessage,
  groupNameError,
  mergeMembers,
  resolveAccess,
  resolveDetails,
  sameAccess,
  sameDetails,
  sameMembers,
  summaryLabel,
  type GroupDetails,
} from "../helpers/groups";
import { isUnansweredRequest, personName } from "../helpers/people";
import {
  deleteAccessGroup,
  getAccessGroup,
  replaceAccessGroupAccess,
  replaceAccessGroupMembers,
  updateAccessGroup,
  type AccessGroup,
  type AccessGroupAccessEntry,
  type AccessVersioned,
} from "../state/api";
import { accessDraftJournalGeneration } from "../state/draft-journal-storage";
import {
  useAccessDraftRegistration,
  useAccessVerifying,
  verifyingReason,
} from "../state/draft-navigation";
import {
  beginGroupSubmission,
  clearGroupDraft,
  discardGroupDraft,
  finishGroupSubmission,
  groupSubmissionNeedsReload,
  readGroupDraft,
  writeGroupDraft,
  type GroupSection,
  type StoredGroupDraft,
} from "../state/group-draft";
import {
  ActionError,
  ConflictDialog,
  UncertainDraftWarning,
  type DraftReviewValues,
} from "./editor-conflicts";
import { AccessSummary, GroupAccessEditor } from "./group-access-editor";
import { usePeopleSearch } from "../hooks/use-people-search";
import {
  useAccessCatalog,
  catalogDepartments,
  catalogModules,
} from "../hooks/use-access-catalog";
import { GroupMemberPicker } from "./group-member-picker";
import {
  detailLabelClassName,
  detailRowClassName,
  TextField,
} from "./people-fields";

type Edit<Value> = { baseline: Value; draft: Value };
type Edits = {
  details: Edit<GroupDetails> | null;
  members: Edit<string[]> | null;
  access: Edit<AccessGroupAccessEntry[]> | null;
};
type SectionValue = {
  details: GroupDetails;
  members: string[];
  access: AccessGroupAccessEntry[];
};
type Conflict = {
  section: "details" | "access";
  fresh: AccessVersioned<AccessGroup>;
  conflicts: FieldConflict[];
  choices: Record<string, ConflictChoice | undefined>;
};

const noEdits: Edits = { details: null, members: null, access: null };

function valueOf<S extends GroupSection>(
  group: AccessGroup,
  section: S,
): SectionValue[S] {
  const values: SectionValue = {
    details: detailsOf(group),
    members: group.member_ids,
    // Journal and command values contain IDs/levels, while reads also name
    // departments/modules. Keep every explicit row and omit display metadata.
    access: group.access.map(({ department_id, module_id, level }) => ({
      department_id,
      module_id,
      level,
    })),
  };
  return values[section];
}

function same<S extends GroupSection>(
  section: S,
  left: SectionValue[S],
  right: SectionValue[S],
): boolean {
  if (section === "details")
    return sameDetails(left as GroupDetails, right as GroupDetails);
  if (section === "members")
    return sameMembers(left as string[], right as string[]);
  return sameAccess(
    left as AccessGroupAccessEntry[],
    right as AccessGroupAccessEntry[],
  );
}

const savedCopy: Record<GroupSection, string> = {
  details: "Details saved",
  members: "Members saved",
  access: "Access saved",
};

export type GroupEditorTab = GroupSection;

/**
 * The editor of one group. It owns the drafts of its three sections: unsaved
 * changes live in the tab's journal, a save re-reads the group and asks
 * about levels or fields someone else changed, and a save that got no
 * answer is held for review instead of being sent again. A manager changes
 * members only.
 */
export function GroupEditor({
  group,
  mode,
  listFresh,
  tab,
  onTabChange,
  onDeleted,
}: {
  group: AccessGroup;
  mode: "admin" | "manager";
  /** The list holds a read that finished after any earlier save. */
  listFresh: boolean;
  tab: GroupEditorTab;
  onTabChange: (tab: GroupEditorTab) => void;
  onDeleted: () => void;
}) {
  const id = useId();
  const client = useQueryClient();
  const signedInId = useVerifiedWorkspaceUserId();
  const admin = mode === "admin";
  const [stored] = useState(() => readGroupDraft(signedInId, group.id));
  const ownRecord = stored.value;
  const [edits, setEdits] = useState<Edits>(() =>
    ownRecord && stored.status === "ready"
      ? {
          details: admin ? ownRecord.details : null,
          members: ownRecord.members,
          access: admin ? ownRecord.access : null,
        }
      : noEdits,
  );
  const [uncertain, setUncertain] = useState<StoredGroupDraft | null>(() =>
    ownRecord && stored.status === "uncertain" ? ownRecord : null,
  );
  const [journalIssue, setJournalIssue] = useState(() =>
    stored.status === "invalid"
      ? "A saved draft could not be restored safely, so it was not used."
      : "",
  );
  const [latest, setLatest] = useState<AccessGroup | null>(null);
  const [errors, setErrors] = useState<Partial<Record<GroupSection, string>>>(
    {},
  );
  const [nameError, setNameError] = useState<string | null>(null);
  const [pending, setPending] = useState<GroupSection | "delete" | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  // Advances when the person discards the drafts; a save that answers
  // afterwards writes nothing back.
  const discarded = useRef(0);
  // A save that answers after the editor closed (Back, a section switch)
  // keeps its draft in the journal for the return.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A save answers with the new group before the list is read again.
  const shown =
    latest && latest.id === group.id && latest.revision > group.revision
      ? latest
      : group;
  const peopleSearch = usePeopleSearch({
    source: admin ? "users" : "candidates",
    selectedIds: [
      ...(edits.members?.draft ?? shown.member_ids),
      ...(uncertain?.members?.draft ?? []),
    ],
  });
  const catalogEntries = [
    ...shown.access,
    ...(edits.access?.draft ?? []),
    ...(edits.access?.baseline ?? []),
  ];
  const departmentSearch = useAccessCatalog({
    kind: "departments",
    selectedIds: catalogEntries.map((entry) => entry.department_id),
    enabled: admin && (tab === "access" || edits.access !== null),
  });
  const moduleSearch = useAccessCatalog({
    kind: "modules",
    listEnabled: false,
    selectedIds: catalogEntries.flatMap((entry) =>
      entry.module_id ? [entry.module_id] : [],
    ),
    enabled: admin && (tab === "access" || edits.access !== null),
  });
  const departments = catalogDepartments(departmentSearch.combined);
  const modules = catalogModules(moduleSearch.combined);
  const dirty = Boolean(edits.details || edits.members || edits.access);
  const verifying = useAccessVerifying();
  const locked = uncertain !== null || pending !== null;

  const persist = useCallback(
    (next: Edits) => {
      const kept = next.details || next.members || next.access;
      if (!kept) {
        clearGroupDraft(signedInId, group.id);
        return;
      }
      if (
        !writeGroupDraft(signedInId, {
          groupId: group.id,
          ...next,
          sending: null,
        })
      )
        setJournalIssue(
          "This browser cannot keep your draft, so unsaved changes will be lost if the page reloads.",
        );
    },
    [group.id, signedInId],
  );

  const discard = useCallback(() => {
    if (!discardGroupDraft(signedInId, group.id)) return false;
    discarded.current += 1;
    setEdits(noEdits);
    setErrors({});
    setNameError(null);
    return true;
  }, [signedInId, group.id]);
  useAccessDraftRegistration("group-editor", {
    dirty: dirty && !uncertain,
    discard,
    pending: pending !== null,
  });

  function commitEdits(next: Edits) {
    setEdits(next);
    persist(next);
  }

  function update<S extends GroupSection>(section: S, draft: SectionValue[S]) {
    if (locked) return;
    const current = edits[section] as Edit<SectionValue[S]> | null;
    const baseline = current?.baseline ?? valueOf(shown, section);
    setErrors((value) => ({ ...value, [section]: "" }));
    if (section === "details") setNameError(null);
    commitEdits({
      ...edits,
      [section]: same(section, draft, baseline) ? null : { baseline, draft },
    });
  }

  function discardSection(section: GroupSection) {
    commitEdits({ ...edits, [section]: null });
    setErrors((value) => ({ ...value, [section]: "" }));
    if (section === "details") setNameError(null);
  }

  function request<S extends GroupSection>(
    section: S,
    fresh: AccessVersioned<AccessGroup>,
    value: SectionValue[S],
  ): Promise<AccessVersioned<AccessGroup>> {
    const etag = fresh.etag;
    if (section === "details")
      return updateAccessGroup(group.id, {
        ...detailsPatch(detailsOf(fresh.data), value as GroupDetails),
        etag,
      });
    if (section === "members")
      return replaceAccessGroupMembers(group.id, {
        member_ids: value as string[],
        etag,
      });
    return replaceAccessGroupAccess(group.id, {
      access: value as AccessGroupAccessEntry[],
      etag,
    });
  }

  function unchanged<S extends GroupSection>(
    section: S,
    saved: SectionValue[S],
    resolved: SectionValue[S],
  ): boolean {
    if (section === "details")
      return (
        Object.keys(
          detailsPatch(saved as GroupDetails, resolved as GroupDetails),
        ).length === 0
      );
    return same(section, saved, resolved);
  }

  async function send<S extends GroupSection>(
    section: S,
    others: Edits,
    fresh: AccessVersioned<AccessGroup>,
    resolved: SectionValue[S],
    retry: boolean,
  ): Promise<void> {
    const saved = valueOf(fresh.data, section);
    if (unchanged(section, saved, resolved)) {
      commitEdits({ ...others, [section]: null });
      setLatest(fresh.data);
      toast.add({ title: "Already up to date", type: "info" });
      void afterAccessGroupChange(client);
      return;
    }
    const edit = { baseline: saved, draft: resolved };
    const withEdit: Edits = { ...others, [section]: edit };
    const record: StoredGroupDraft = {
      groupId: group.id,
      ...withEdit,
      sending: section,
    };
    const journaled = beginGroupSubmission(signedInId, record);
    const run = discarded.current;
    const journal = accessDraftJournalGeneration();
    // A discard, a sign-out or an organization switch since the save began
    // wins; otherwise the drafts go back to the journal.
    const keepsJournal = () =>
      discarded.current === run && accessDraftJournalGeneration() === journal;
    let result: AccessVersioned<AccessGroup>;
    try {
      result = await request(section, fresh, resolved);
    } catch (caught) {
      if (isUnansweredRequest(caught)) {
        // The journal keeps the unanswered save for review on return.
        if (discarded.current !== run || !mounted.current) return;
        if (journaled) {
          setEdits(noEdits);
          setUncertain(record);
        } else {
          // Without a journal there is nothing to hold; keep the draft and
          // ask for a check before another save.
          setEdits(withEdit);
          setErrors((value) => ({
            ...value,
            [section]:
              "The save got no answer, so it may have completed. Check this group before you save again.",
          }));
        }
        void afterAccessGroupChange(client);
        return;
      }
      finishGroupSubmission(signedInId, group.id, true);
      if (!keepsJournal()) return;
      if (!mounted.current) {
        persist(withEdit);
        return;
      }
      commitEdits(withEdit);
      if (caught instanceof ApiError && caught.status === 412 && retry) {
        // Someone changed this group between the read and the save.
        await review(section, withEdit, edit, false);
        return;
      }
      setErrors((value) => ({
        ...value,
        [section]: groupErrorMessage(
          caught,
          "The changes could not be saved. Try again.",
        ),
      }));
      void afterAccessGroupChange(client);
      return;
    }
    finishGroupSubmission(signedInId, group.id, true);
    if (!keepsJournal()) return;
    if (!mounted.current) {
      // The other sections' drafts stay for the return.
      persist({ ...others, [section]: null });
      return;
    }
    commitEdits({ ...others, [section]: null });
    setLatest(result.data);
    toast.add({ title: savedCopy[section], type: "success" });
    void afterAccessGroupChange(client);
  }

  /** Re-read the group, then save or ask about values both sides changed. */
  async function review<S extends GroupSection>(
    section: S,
    others: Edits,
    edit: Edit<SectionValue[S]>,
    retry: boolean,
  ): Promise<void> {
    const fresh = await getAccessGroup(group.id);
    if (section === "details") {
      const current = detailsOf(fresh.data);
      const target = edit as Edit<GroupDetails>;
      const conflicts = detailsConflicts(
        current,
        target.baseline,
        target.draft,
      );
      if (conflicts.length) {
        setConflict({ section: "details", fresh, conflicts, choices: {} });
        return;
      }
      await send(
        "details",
        others,
        fresh,
        resolveDetails(current, target.baseline, target.draft, {}),
        retry,
      );
      return;
    }
    if (section === "members") {
      const target = edit as Edit<string[]>;
      await send(
        "members",
        others,
        fresh,
        mergeMembers(fresh.data.member_ids, target.baseline, target.draft),
        retry,
      );
      return;
    }
    const target = edit as Edit<AccessGroupAccessEntry[]>;
    const conflicts = accessConflicts(
      fresh.data.access,
      target.baseline,
      target.draft,
      departments,
      modules,
    );
    if (conflicts.length) {
      setConflict({ section: "access", fresh, conflicts, choices: {} });
      return;
    }
    await send(
      "access",
      others,
      fresh,
      resolveAccess(fresh.data.access, target.baseline, target.draft, {}),
      retry,
    );
  }

  async function save(section: GroupSection) {
    const edit = edits[section];
    if (!edit || locked || verifying) return;
    if (section === "details") {
      const found = groupNameError((edit.draft as GroupDetails).name);
      setNameError(found);
      if (found) return;
    }
    setPending(section);
    setErrors((value) => ({ ...value, [section]: "" }));
    try {
      await review(
        section,
        edits,
        edit as Edit<SectionValue[typeof section]>,
        true,
      );
    } catch (caught) {
      setErrors((value) => ({
        ...value,
        [section]: groupErrorMessage(
          caught,
          "The changes could not be saved. Try again.",
        ),
      }));
    } finally {
      setPending(null);
    }
  }

  async function continueAfterConflict() {
    if (!conflict) return;
    const { section, fresh, choices } = conflict;
    setConflict(null);
    setPending(section);
    try {
      if (section === "details" && edits.details)
        await send(
          "details",
          edits,
          fresh,
          resolveDetails(
            detailsOf(fresh.data),
            edits.details.baseline,
            edits.details.draft,
            choices,
          ),
          false,
        );
      if (section === "access" && edits.access)
        await send(
          "access",
          edits,
          fresh,
          resolveAccess(
            fresh.data.access,
            edits.access.baseline,
            edits.access.draft,
            choices,
          ),
          false,
        );
    } catch (caught) {
      setErrors((value) => ({
        ...value,
        [section]: groupErrorMessage(
          caught,
          "The changes could not be saved. Try again.",
        ),
      }));
    } finally {
      setPending(null);
    }
  }

  async function confirmDelete() {
    if (pending) return;
    setPending("delete");
    setDeleteError("");
    try {
      const fresh = await getAccessGroup(group.id);
      if (fresh.data.member_ids.length) {
        setLatest(fresh.data);
        setDeleteError(
          "Someone added members to this group. Remove them before you delete it.",
        );
        return;
      }
      await deleteAccessGroup(group.id, { etag: fresh.etag });
      clearGroupDraft(signedInId, group.id);
      setEdits(noEdits);
      setDeleting(false);
      toast.add({ title: `${fresh.data.name} is deleted`, type: "success" });
      void afterAccessGroupChange(client);
      onDeleted();
    } catch (caught) {
      setDeleteError(
        groupErrorMessage(caught, "The group could not be deleted. Try again."),
      );
      void afterAccessGroupChange(client);
    } finally {
      setPending(null);
    }
  }

  function memberNames(memberIds: readonly string[]) {
    const names = new Map(
      peopleSearch.selectedItems.map((item) => [item.id, personName(item)]),
    );
    return memberIds
      .map((memberId) => ({
        id: memberId,
        label: names.get(memberId) ?? "Unavailable person",
      }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }

  function reviewValues(
    section: GroupSection,
    record: Pick<StoredGroupDraft, "details" | "members" | "access"> | null,
  ): DraftReviewValues {
    const details =
      section === "details" && record?.details
        ? record.details.draft
        : detailsOf(shown);
    const members =
      section === "members" && record?.members
        ? record.members.draft
        : shown.member_ids;
    const access =
      section === "access" && record?.access
        ? record.access.draft
        : shown.access;
    return {
      name: details.name,
      description: details.description,
      entries:
        section === "access"
          ? accessSummary(access, departments, modules).map((item) => ({
              id: item.departmentId,
              label: summaryLabel(item),
            }))
          : memberNames(members),
    };
  }

  if (uncertain) {
    const section = uncertain.sending ?? "details";
    return (
      <div className="flex flex-col gap-4 p-5">
        {journalIssue ? (
          <Alert variant="warning" role="status">
            {journalIssue}
          </Alert>
        ) : null}
        {section === "members" && peopleSearch.selectedLoading ? (
          <p role="status" className="text-muted-foreground text-sm">
            Loading member names…
          </p>
        ) : null}
        {section === "members" && peopleSearch.error ? (
          <Alert variant="destructive" className="space-y-3">
            <p>{peopleSearch.error}</p>
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => void peopleSearch.retry()}
            >
              Retry member names
            </Button>
          </Alert>
        ) : null}
        <UncertainDraftWarning
          subject="group"
          currentSummary="Compare your saved change with this group now. If it is not there, discard it and make the change again."
          savedValues={reviewValues(section, uncertain)}
          currentValues={reviewValues(section, null)}
          entriesLabel={section === "access" ? "Access" : "Members"}
          canResolve={
            listFresh &&
            !groupSubmissionNeedsReload(signedInId, group.id) &&
            (section !== "members" ||
              (!peopleSearch.error && !peopleSearch.selectedLoading))
          }
          pending={pending !== null}
          onResolve={() => {
            if (!finishGroupSubmission(signedInId, group.id, false)) {
              setJournalIssue(
                "The saved change could not be cleared from this browser. Try again.",
              );
              return;
            }
            // The other sections' drafts come back; the reviewed one is gone.
            const kept: Edits = {
              details: section === "details" ? null : uncertain.details,
              members: section === "members" ? null : uncertain.members,
              access: section === "access" ? null : uncertain.access,
            };
            setUncertain(null);
            commitEdits(kept);
          }}
        />
      </div>
    );
  }

  const details = edits.details?.draft ?? detailsOf(shown);
  const members = edits.members?.draft ?? shown.member_ids;
  const access = edits.access?.draft ?? shown.access;
  const tabs: { value: GroupSection; label: string }[] = [
    { value: "details", label: "Details" },
    { value: "members", label: "Members" },
    { value: "access", label: "Access" },
  ];

  function footer(section: GroupSection, label: string) {
    const changed = Boolean(edits[section]);
    // Members and Access can outgrow the sheet, so their save stays in reach.
    const sticky = section !== "details";
    return (
      <>
        <ActionError message={errors[section] ?? ""} />
        <div
          className={cn(
            "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
            sticky && "bg-card sticky bottom-0 -mx-5 -mb-5 border-t px-5 py-3",
          )}
        >
          {changed ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              disabled={pending !== null}
              onClick={() => discardSection(section)}
            >
              Discard changes
            </Button>
          ) : null}
          <DisabledReason reason={verifying ? verifyingReason : null}>
            <Button
              type="submit"
              className="min-h-11"
              disabled={!changed || pending !== null}
            >
              {pending === section ? "Saving…" : label}
            </Button>
          </DisabledReason>
        </div>
      </>
    );
  }

  function submit(section: GroupSection) {
    return (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void save(section);
    };
  }

  return (
    <>
      {journalIssue ? (
        <Alert variant="warning" role="status" className="m-5 mb-0 shrink-0">
          {journalIssue}
        </Alert>
      ) : null}
      <Tabs
        value={tab}
        onValueChange={(value) => {
          if (value === "details" || value === "members" || value === "access")
            onTabChange(value);
        }}
        className="min-h-0 flex-1 gap-0"
      >
        <div className="shrink-0 border-b px-5 py-3">
          <TabsList
            aria-label="Group"
            className="grid w-full grid-cols-3 sm:w-fit"
          >
            {tabs.map((item) => (
              <TabsTrigger
                key={item.value}
                className="min-h-11 xl:min-h-8"
                value={item.value}
              >
                {item.label}
                {edits[item.value] ? (
                  <>
                    <span
                      aria-hidden="true"
                      className="bg-warn ml-1 size-1.5 shrink-0 rounded-full"
                    />
                    <span className="sr-only">, unsaved changes</span>
                  </>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <TabsContent
          value="details"
          className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain p-5"
        >
          {admin ? (
            <div className="flex flex-col gap-6">
              <form
                noValidate
                aria-label="Details"
                className="flex flex-col gap-4"
                onSubmit={submit("details")}
              >
                <TextField
                  layout="row"
                  id={`${id}-name`}
                  label="Name"
                  autoComplete="off"
                  maxLength={200}
                  value={details.name}
                  disabled={locked}
                  error={nameError}
                  onChange={(name) => update("details", { ...details, name })}
                />
                <Field
                  className={cn(
                    "min-w-0",
                    detailRowClassName,
                    "md:items-start",
                  )}
                >
                  <FieldLabel
                    htmlFor={`${id}-description`}
                    className={cn(detailLabelClassName, "md:pt-2")}
                  >
                    Description
                  </FieldLabel>
                  <Textarea
                    id={`${id}-description`}
                    maxLength={2000}
                    rows={3}
                    value={details.description}
                    disabled={locked}
                    onChange={(event) =>
                      update("details", {
                        ...details,
                        description: event.target.value,
                      })
                    }
                  />
                </Field>
                {footer("details", "Save details")}
              </form>
              <section
                aria-labelledby={`${id}-delete`}
                className="space-y-2 border-t pt-5"
              >
                <h3 id={`${id}-delete`} className="font-semibold">
                  Delete group
                </h3>
                <p className="text-muted-foreground text-sm">
                  {shown.member_ids.length
                    ? "Remove every member first. A group with members cannot be deleted."
                    : "The group and its access settings are removed."}
                </p>
                {shown.member_ids.length ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 w-full sm:w-auto"
                    onClick={() => onTabChange("members")}
                  >
                    Go to Members
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 w-full sm:w-auto"
                    disabled={pending !== null}
                    onClick={() => {
                      setDeleteError("");
                      setDeleting(true);
                    }}
                  >
                    Delete group
                  </Button>
                )}
              </section>
            </div>
          ) : (
            <div className="space-y-4 text-sm">
              <dl className="space-y-4">
                <div>
                  <dt className="text-muted-foreground">Name</dt>
                  <dd className="mt-1 break-words">{shown.name}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Description</dt>
                  <dd className="mt-1 break-words whitespace-pre-wrap">
                    {shown.description || "None"}
                  </dd>
                </div>
              </dl>
              <p className="text-muted-foreground">
                Only administrators can rename a group or change its access.
              </p>
            </div>
          )}
        </TabsContent>

        <TabsContent
          value="members"
          className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain p-5"
        >
          <form
            noValidate
            aria-label="Members"
            className="flex flex-col gap-4"
            onSubmit={submit("members")}
          >
            <p className="text-muted-foreground text-sm">
              Members get the access this group gives. Guests can only read.
            </p>
            <GroupMemberPicker
              source={admin ? "users" : "candidates"}
              peopleSearch={peopleSearch}
              selected={members}
              disabled={locked}
              onChange={(memberIds) => update("members", memberIds)}
            />
            {footer("members", "Save members")}
          </form>
        </TabsContent>

        <TabsContent
          value="access"
          className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain p-5"
        >
          {admin ? (
            <form
              noValidate
              aria-label="Access"
              className="flex flex-col gap-4"
              onSubmit={submit("access")}
            >
              <p className="text-muted-foreground text-sm">
                Choose a level for each department. Open a department to give
                one of its modules its own level.
              </p>
              <GroupAccessEditor
                entries={access}
                departmentSearch={departmentSearch}
                departments={departments}
                modules={modules}
                disabled={locked}
                onChange={(entries) => update("access", entries)}
              />
              <section
                aria-labelledby={`${id}-summary`}
                aria-live="polite"
                className="bg-muted/40 space-y-2 rounded-lg border p-3"
              >
                <h3 id={`${id}-summary`} className="text-sm font-semibold">
                  This group gives
                </h3>
                <AccessSummary
                  entries={access}
                  departments={departments}
                  modules={modules}
                  empty="No access yet. Members see nothing until you choose a level."
                />
              </section>
              {footer("access", "Save access")}
            </form>
          ) : (
            <section aria-labelledby={`${id}-summary`} className="space-y-2">
              <h3 id={`${id}-summary`} className="text-sm font-semibold">
                This group gives
              </h3>
              <AccessSummary
                entries={shown.access}
                departments={departments}
                modules={modules}
                empty="No access."
              />
              <p className="text-muted-foreground text-sm">
                Only administrators can change a group&apos;s access.
              </p>
            </section>
          )}
        </TabsContent>
      </Tabs>

      <ConflictDialog
        open={conflict !== null}
        title="This group changed"
        conflicts={conflict?.conflicts ?? []}
        choices={conflict?.choices ?? {}}
        onChoice={(field, choice) =>
          setConflict((value) =>
            value
              ? { ...value, choices: { ...value.choices, [field]: choice } }
              : value,
          )
        }
        onCancel={() => setConflict(null)}
        onContinue={() => void continueAfterConflict()}
      />

      <AlertDialog
        open={deleting}
        onOpenChange={(open) => !open && pending === null && setDeleting(false)}
      >
        <AlertDialogContent className="access-ui">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {shown.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The group and its access settings are removed. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ActionError message={deleteError} />
          <AlertDialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              disabled={pending !== null}
              onClick={() => setDeleting(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              className="min-h-11"
              disabled={pending !== null}
              onClick={() => void confirmDelete()}
            >
              {pending === "delete" ? "Deleting…" : "Delete"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
