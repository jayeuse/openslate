import {
  getModuleDefinition,
  OPENVIEW_SAMPLE_SNAPSHOT_DATE,
  OPENVIEW_SAMPLE_TIMEZONE,
  type OpenViewModuleId,
  type OpenViewRow,
  type OpenViewValue,
} from "../domain/model";

export {
  OPENVIEW_SAMPLE_SNAPSHOT_DATE,
  OPENVIEW_SAMPLE_TIMEZONE,
} from "../domain/model";

export type OpenViewLaneMode = "status" | "priority" | "category";

export type OpenViewOperationalProfile = {
  moduleId: OpenViewModuleId;
  statusField: string;
  ownerField: string;
  priorityField: string;
  startField: string;
  endField: string;
  deadlineField: string;
  progressField: string;
  laneOrder: readonly string[];
  laneMode: OpenViewLaneMode;
  dateMeaning: string;
};

export type OpenViewTimingState =
  "blocked" | "overdue" | "late-plan" | "due-soon" | "on-track" | "unscheduled";

export type OpenViewOperationalFacts = {
  rowId: string;
  moduleId: OpenViewModuleId;
  status: string;
  owner: string;
  priority: string;
  start: string;
  end: string;
  deadline: string;
  progress: number | null;
  timingState: OpenViewTimingState;
  attentionReason: string | null;
  attentionRank: number;
  diagnostics: string[];
  isComplete: boolean;
  dateMeaning: string;
};

export type OpenViewScheduleItem = {
  id: string;
  rowId: string;
  moduleId: OpenViewModuleId;
  label: string;
  status: string;
  owner: string;
  priority: string;
  type: "task" | "milestone" | "unscheduled";
  start: string | null;
  end: string | null;
  deadline: string | null;
  progress: number | null;
  timingState: OpenViewTimingState;
  attentionReason: string | null;
  attentionRank: number;
  diagnostics: string[];
  dateMeaning: string;
};

export type OpenViewOperationalLane = {
  label: string;
  rows: OpenViewRow[];
  facts: OpenViewOperationalFacts[];
  count: number;
  configured: boolean;
};

export type OpenViewOperationalGroup = {
  label: string;
  count: number;
};

export type OpenViewAttentionItem = {
  rowId: string;
  label: string;
  timingState: OpenViewTimingState;
  attentionReason: string | null;
  attentionRank: number;
  owner: string;
  priority: string;
  deadline: string;
};

export type OpenViewOperationalDiagnostic = {
  rowId: string;
  messages: string[];
};

export type OpenViewOperationalSummary = {
  moduleId: OpenViewModuleId;
  snapshotDate: string;
  timezone: string;
  total: number;
  scheduled: number;
  unscheduled: number;
  blocked: number;
  overdue: number;
  latePlan: number;
  dueSoon: number;
  onTrack: number;
  complete: number;
  needsAttention: number;
  unassigned: number;
  highPriority: number;
  byStatus: OpenViewOperationalGroup[];
  byOwner: OpenViewOperationalGroup[];
  byPriority: OpenViewOperationalGroup[];
  attention: OpenViewAttentionItem[];
  diagnostics: OpenViewOperationalDiagnostic[];
};

export const OPENVIEW_OPERATIONAL_PROFILES: Record<
  OpenViewModuleId,
  OpenViewOperationalProfile
> = {
  "service-requests": {
    moduleId: "service-requests",
    statusField: "status",
    ownerField: "assignee",
    priorityField: "priority",
    startField: "startDate",
    endField: "endDate",
    deadlineField: "dueDate",
    progressField: "progress",
    laneOrder: ["Open", "Scheduled", "In progress", "Completed", "On hold"],
    laneMode: "status",
    dateMeaning: "Planned service window and customer due date",
  },
  equipment: {
    moduleId: "equipment",
    statusField: "status",
    ownerField: "owner",
    priorityField: "priority",
    startField: "startDate",
    endField: "endDate",
    deadlineField: "deadline",
    progressField: "progress",
    laneOrder: ["Inspection due", "Out for repair", "In service"],
    laneMode: "status",
    dateMeaning: "Planned maintenance window and service deadline",
  },
  customers: {
    moduleId: "customers",
    statusField: "status",
    ownerField: "owner",
    priorityField: "priority",
    startField: "startDate",
    endField: "endDate",
    deadlineField: "deadline",
    progressField: "progress",
    laneOrder: ["Review", "On hold", "Active"],
    laneMode: "status",
    dateMeaning: "Account review window and follow-up deadline",
  },
};

export function getOpenViewOperationalProfile(
  moduleId: OpenViewModuleId,
): OpenViewOperationalProfile {
  return OPENVIEW_OPERATIONAL_PROFILES[moduleId];
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAYS_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

function textValue(row: OpenViewRow, field: string): string {
  const value = row.values[field];
  return value === undefined ? "" : String(value);
}

function validDate(value: OpenViewValue | undefined): string | null {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10) === value ? value : null;
}

function addDays(value: string, amount: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  return new Date(date.getTime() + amount * DAYS_IN_MILLISECONDS)
    .toISOString()
    .slice(0, 10);
}

function progressValue(value: OpenViewValue | undefined): number | null {
  if (typeof value === "number")
    return Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100
    ? parsed
    : null;
}

function isExplicitlyBlocked(status: string): boolean {
  const normalized = status.toLocaleLowerCase();
  return normalized.includes("hold") || normalized.includes("repair");
}

function isComplete(status: string, progress: number | null): boolean {
  const normalized = status.toLocaleLowerCase();
  return (
    normalized === "completed" ||
    normalized === "complete" ||
    normalized === "closed" ||
    progress === 100
  );
}

function attentionReason(
  state: OpenViewTimingState,
  status: string,
): string | null {
  if (state === "blocked")
    return `${status || "This item"} requires a resolution before work can continue.`;
  if (state === "overdue") return "The deadline passed before the snapshot.";
  if (state === "late-plan") return "The planned end is after the deadline.";
  if (state === "due-soon")
    return "The deadline is within the next seven days.";
  if (state === "unscheduled") return "Schedule dates are missing or invalid.";
  return null;
}

function timingRank(state: OpenViewTimingState): number {
  if (state === "blocked") return 1;
  if (state === "overdue") return 2;
  if (state === "late-plan") return 3;
  if (state === "due-soon") return 4;
  if (state === "unscheduled") return 5;
  return 0;
}

function dateDiagnostics(
  startValue: string,
  endValue: string,
  deadlineValue: string,
  progressRaw: OpenViewValue | undefined,
  start: string | null,
  end: string | null,
  deadline: string | null,
): string[] {
  const diagnostics: string[] = [];
  if (startValue && !start) diagnostics.push("Start date is invalid.");
  if (!startValue) diagnostics.push("Start date is missing.");
  if (endValue && !end) diagnostics.push("End date is invalid.");
  if (!endValue) diagnostics.push("End date is missing.");
  if (deadlineValue && !deadline) diagnostics.push("Deadline is invalid.");
  if (!deadlineValue) diagnostics.push("Deadline is missing.");
  if (start && end && start > end)
    diagnostics.push("Start date must be on or before end date.");
  if (
    progressRaw !== undefined &&
    progressRaw !== "" &&
    progressValue(progressRaw) === null
  )
    diagnostics.push("Progress must be an integer from 0 to 100.");
  return diagnostics;
}

export function getOpenViewOperationalFacts(
  row: OpenViewRow,
  anchorDate = OPENVIEW_SAMPLE_SNAPSHOT_DATE,
): OpenViewOperationalFacts {
  const profile = getOpenViewOperationalProfile(row.moduleId);
  const status = textValue(row, profile.statusField);
  const owner = textValue(row, profile.ownerField);
  const priority = textValue(row, profile.priorityField);
  const startValue = textValue(row, profile.startField);
  const endValue = textValue(row, profile.endField);
  const deadlineValue = textValue(row, profile.deadlineField);
  const start = validDate(row.values[profile.startField]);
  const end = validDate(row.values[profile.endField]);
  const deadline = validDate(row.values[profile.deadlineField]);
  const progressRaw = row.values[profile.progressField];
  const progress = progressValue(progressRaw);
  const diagnostics = dateDiagnostics(
    startValue,
    endValue,
    deadlineValue,
    progressRaw,
    start,
    end,
    deadline,
  );
  const anchor = validDate(anchorDate) ?? OPENVIEW_SAMPLE_SNAPSHOT_DATE;
  const complete = isComplete(status, progress);
  let timingState: OpenViewTimingState;
  if (isExplicitlyBlocked(status)) timingState = "blocked";
  else if (!start || !end || !deadline || start > end)
    timingState = "unscheduled";
  else if (!complete && deadline < anchor) timingState = "overdue";
  else if (end > deadline) timingState = "late-plan";
  else if (!complete && deadline <= addDays(anchor, 7))
    timingState = "due-soon";
  else timingState = "on-track";
  return {
    rowId: row.id,
    moduleId: row.moduleId,
    status,
    owner,
    priority,
    start: startValue,
    end: endValue,
    deadline: deadlineValue,
    progress,
    timingState,
    attentionReason: attentionReason(timingState, status),
    attentionRank: timingRank(timingState),
    diagnostics,
    isComplete: complete,
    dateMeaning: profile.dateMeaning,
  };
}

export function normalizeOpenViewScheduleItems(
  rows: OpenViewRow[],
  moduleId: OpenViewModuleId,
  anchorDate = OPENVIEW_SAMPLE_SNAPSHOT_DATE,
): OpenViewScheduleItem[] {
  const moduleDefinition = getModuleDefinition(moduleId);
  return rows
    .filter((row) => row.moduleId === moduleId)
    .map((row) => {
      const facts = getOpenViewOperationalFacts(row, anchorDate);
      const start = validDate(facts.start);
      const end = validDate(facts.end);
      const validSpan = Boolean(start && end && start <= end);
      const scheduled = validSpan;
      return {
        id: row.id,
        rowId: row.id,
        moduleId,
        label: textValue(row, moduleDefinition.primaryField),
        status: facts.status,
        owner: facts.owner,
        priority: facts.priority,
        type: scheduled
          ? start === end
            ? "milestone"
            : "task"
          : "unscheduled",
        start: scheduled ? start : null,
        end: scheduled ? end : null,
        deadline: validDate(facts.deadline),
        progress: facts.progress,
        timingState: facts.timingState,
        attentionReason: facts.attentionReason,
        attentionRank: facts.attentionRank,
        diagnostics: facts.diagnostics,
        dateMeaning: facts.dateMeaning,
      };
    });
}

function countGroups(
  values: string[],
  laneOrder: readonly string[] = [],
): OpenViewOperationalGroup[] {
  const counts = new Map<string, number>();
  for (const value of values)
    counts.set(
      value || "Unassigned",
      (counts.get(value || "Unassigned") ?? 0) + 1,
    );
  return [...counts.entries()]
    .sort((left, right) => {
      const leftLane = laneOrder.indexOf(left[0]);
      const rightLane = laneOrder.indexOf(right[0]);
      if (leftLane !== -1 || rightLane !== -1)
        return (
          (leftLane === -1 ? Number.MAX_SAFE_INTEGER : leftLane) -
          (rightLane === -1 ? Number.MAX_SAFE_INTEGER : rightLane)
        );
      return right[1] - left[1] || left[0].localeCompare(right[0]);
    })
    .map(([label, count]) => ({ label, count }));
}

export function getOpenViewLanes(
  rows: OpenViewRow[],
  moduleId: OpenViewModuleId,
  anchorDate = OPENVIEW_SAMPLE_SNAPSHOT_DATE,
): OpenViewOperationalLane[] {
  const profile = getOpenViewOperationalProfile(moduleId);
  const groups = new Map<string, OpenViewRow[]>();
  const laneField =
    profile.laneMode === "priority"
      ? profile.priorityField
      : profile.statusField;
  for (const row of rows.filter(
    (candidate) => candidate.moduleId === moduleId,
  )) {
    const label = textValue(row, laneField) || "Unspecified";
    groups.set(label, [...(groups.get(label) ?? []), row]);
  }
  const labels = [
    ...profile.laneOrder,
    ...[...groups.keys()].filter((label) => !profile.laneOrder.includes(label)),
  ];
  return labels.map((label) => {
    const laneRows = groups.get(label) ?? [];
    return {
      label,
      rows: laneRows,
      facts: laneRows.map((row) =>
        getOpenViewOperationalFacts(row, anchorDate),
      ),
      count: laneRows.length,
      configured: profile.laneOrder.includes(label),
    };
  });
}

export function summarizeOpenViewOperationalRows(
  rows: OpenViewRow[],
  moduleId: OpenViewModuleId,
  anchorDate = OPENVIEW_SAMPLE_SNAPSHOT_DATE,
): OpenViewOperationalSummary {
  const visibleRows = rows.filter((row) => row.moduleId === moduleId);
  const facts = visibleRows.map((row) =>
    getOpenViewOperationalFacts(row, anchorDate),
  );
  const scheduleItems = normalizeOpenViewScheduleItems(
    visibleRows,
    moduleId,
    anchorDate,
  );
  const moduleDefinition = getModuleDefinition(moduleId);
  const byStatus = countGroups(
    facts.map((fact) => fact.status),
    getOpenViewOperationalProfile(moduleId).laneOrder,
  );
  const byOwner = countGroups(facts.map((fact) => fact.owner));
  const byPriority = countGroups(facts.map((fact) => fact.priority));
  const labels = new Map(
    visibleRows.map((row) => [
      row.id,
      textValue(row, moduleDefinition.primaryField),
    ]),
  );
  const attention = facts
    .filter((fact) => fact.attentionRank > 0)
    .map((fact) => ({
      rowId: fact.rowId,
      label: labels.get(fact.rowId) || fact.rowId,
      timingState: fact.timingState,
      attentionReason: fact.attentionReason,
      attentionRank: fact.attentionRank,
      owner: fact.owner,
      priority: fact.priority,
      deadline: fact.deadline,
    }))
    .sort(
      (left, right) =>
        left.attentionRank - right.attentionRank ||
        left.deadline.localeCompare(right.deadline) ||
        left.label.localeCompare(right.label),
    );
  return {
    moduleId,
    snapshotDate: validDate(anchorDate) ?? OPENVIEW_SAMPLE_SNAPSHOT_DATE,
    timezone: OPENVIEW_SAMPLE_TIMEZONE,
    total: facts.length,
    scheduled: scheduleItems.filter((item) => item.type !== "unscheduled")
      .length,
    unscheduled: scheduleItems.filter((item) => item.type === "unscheduled")
      .length,
    blocked: facts.filter((fact) => fact.timingState === "blocked").length,
    overdue: facts.filter((fact) => fact.timingState === "overdue").length,
    latePlan: facts.filter((fact) => fact.timingState === "late-plan").length,
    dueSoon: facts.filter((fact) => fact.timingState === "due-soon").length,
    onTrack: facts.filter((fact) => fact.timingState === "on-track").length,
    complete: facts.filter((fact) => fact.isComplete).length,
    needsAttention: facts.filter((fact) => fact.attentionRank > 0).length,
    unassigned: facts.filter((fact) => !fact.owner.trim()).length,
    highPriority: facts.filter((fact) =>
      ["high", "critical", "urgent"].includes(
        fact.priority.toLocaleLowerCase(),
      ),
    ).length,
    byStatus,
    byOwner,
    byPriority,
    attention,
    diagnostics: facts
      .filter((fact) => fact.diagnostics.length > 0)
      .map((fact) => ({ rowId: fact.rowId, messages: fact.diagnostics })),
  };
}
