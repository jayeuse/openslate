"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Alert } from "@/components/ui/alert";
import type { AccessController } from "../state/controller";
import type { EditorIntent } from "../helpers/editor-helpers";
import type { AccessGroup } from "../domain/policy";
import { GroupEditor } from "./role-group-editors";
import {
  readAccessGroupDraft,
  type AccessGroupDraft,
} from "../state/draft-journal";
import { useVerifiedWorkspaceUserId } from "../../shared/runtime/workspace-identity";

export type GroupManagementControls = {
  createGroup(): void;
  editGroup(group: AccessGroup): void;
};

export type GroupManagementProps = {
  controller: AccessController;
  children: (controls: GroupManagementControls) => ReactNode;
  restoreEnabled?: boolean;
};

export function GroupManagement({
  controller,
  children,
  restoreEnabled = true,
}: GroupManagementProps) {
  const userId = useVerifiedWorkspaceUserId();
  const [draft, setDraft] = useState<AccessGroup | null>(null);
  const [draftIntent, setDraftIntent] = useState<EditorIntent>("edit");
  const [restoredValues, setRestoredValues] = useState<
    AccessGroupDraft["values"] | null
  >(null);
  const [restoredUncertain, setRestoredUncertain] = useState(false);
  const [journalIssue, setJournalIssue] = useState("");
  const restoredUserId = useRef<string | null>(null);
  const [groupEditorFocusTarget, setGroupEditorFocusTarget] = useState<
    string | null
  >(null);

  useEffect(() => {
    if (draft !== null || !groupEditorFocusTarget) return;
    const targetId = groupEditorFocusTarget;
    const frame = window.requestAnimationFrame(() => {
      const groupId = targetId.startsWith("group-edit-table-")
        ? targetId.slice("group-edit-table-".length)
        : null;
      const target =
        document.getElementById(targetId) ??
        (groupId
          ? document.getElementById("configure-subject-group:" + groupId)
          : null) ??
        document.getElementById("permissions-create-button");
      target?.focus();
      setGroupEditorFocusTarget(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [draft, groupEditorFocusTarget]);

  useEffect(() => {
    if (!restoreEnabled || restoredUserId.current === userId) return;
    restoredUserId.current = userId;
    const stored = readAccessGroupDraft(userId);
    if (stored.value) {
      setDraft(stored.value.baseline);
      setDraftIntent(stored.value.intent);
      setRestoredValues(stored.value.values);
    }
    setRestoredUncertain(stored.status === "uncertain");
    if (stored.status === "unavailable")
      setJournalIssue(
        "Browser draft storage is unavailable. Group changes may not survive reload.",
      );
    else if (stored.status === "invalid")
      setJournalIssue(
        "A saved group draft could not be safely restored. It was not applied.",
      );
  }, [restoreEnabled, userId]);

  function editGroup(group: AccessGroup) {
    if (restoredUncertain) return;
    setGroupEditorFocusTarget("group-edit-table-" + group.id);
    setRestoredValues(null);
    setDraftIntent("edit");
    setDraft({ ...group, memberIds: [...group.memberIds] });
  }

  function createGroup() {
    if (restoredUncertain) return;
    setGroupEditorFocusTarget("permissions-create-button");
    setRestoredValues(null);
    setDraftIntent("create");
    setDraft({
      id: "draft:group:" + crypto.randomUUID(),
      name: "",
      description: "",
      memberIds: [],
    });
  }

  return (
    <>
      {children({ createGroup, editGroup })}

      {journalIssue ? (
        <Alert role="alert" variant="warning">
          {journalIssue}
        </Alert>
      ) : null}

      <GroupEditor
        key={draft?.id ?? "closed-group"}
        controller={controller}
        draft={draft}
        intent={draftIntent}
        restoredValues={restoredValues}
        restoredUncertain={restoredUncertain}
        onClose={() => {
          setDraft(null);
          setRestoredValues(null);
          setRestoredUncertain(false);
        }}
      />
    </>
  );
}
