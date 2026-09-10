"use client";
import { useWorkspace } from "@/components/workspace-provider";
import { formatWorkspaceDateTime, datetimeInputToUtc } from "@/lib/date-time";

import { useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileClock,
  RefreshCw,
  Search,
  ShieldAlert,
} from "lucide-react";

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  ApiError,
  apiFetch,
  listQuery,
  type AuditAction,
  type AuditLog,
  type ListResponse,
  type Pagination,
  type SecurityEvent,
  type SecurityEventOutcome,
} from "@/lib/api";

const PAGE_SIZE = 100;
const EXPORT_LIMIT = 100;
type AuditView = "audit" | "security";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableRecord(
  value: unknown,
): value is Record<string, unknown> | null {
  return value === null || isRecord(value);
}

function isAuditAction(value: unknown): value is AuditAction {
  return value === "create" || value === "update" || value === "delete";
}

function isAuditLog(value: unknown): value is AuditLog {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.created_at === "string" &&
    isNullableString(value.performed_by) &&
    isAuditAction(value.action) &&
    typeof value.entity_type === "string" &&
    isNullableString(value.entity_id) &&
    isNullableRecord(value.before) &&
    isNullableRecord(value.after) &&
    isNullableString(value.request_id) &&
    isNullableString(value.request_method) &&
    isNullableString(value.request_path) &&
    isNullableString(value.actor_label) &&
    isNullableString(value.note)
  );
}

function isSecurityEventOutcome(value: unknown): value is SecurityEventOutcome {
  return (
    value === "attempt" ||
    value === "success" ||
    value === "denied" ||
    value === "failure" ||
    value === "partial"
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function isSecurityEvent(value: unknown): value is SecurityEvent {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.occurred_at === "string" &&
    typeof value.event_type === "string" &&
    isSecurityEventOutcome(value.outcome) &&
    typeof value.source === "string" &&
    typeof value.operation_id === "string" &&
    isNullableString(value.actor_id) &&
    isNullableString(value.subject_id) &&
    isStringRecord(value.labels) &&
    isNullableString(value.fingerprint) &&
    isNullableString(value.reason) &&
    isNullableString(value.request_id) &&
    isNullableString(value.request_method) &&
    isNullableString(value.request_path) &&
    isRecord(value.metadata)
  );
}

function parsePagination(value: unknown): Pagination | null {
  if (!isRecord(value)) return null;
  const { limit, offset, count, total, has_more: hasMore } = value;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    typeof offset !== "number" ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    typeof count !== "number" ||
    !Number.isInteger(count) ||
    count < 0 ||
    typeof total !== "number" ||
    !Number.isInteger(total) ||
    total < 0 ||
    typeof hasMore !== "boolean"
  ) {
    return null;
  }
  return { limit, offset, count, total, has_more: hasMore };
}

function parseListResponse<T>(
  value: unknown,
  itemGuard: (item: unknown) => item is T,
): ListResponse<T> | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  const pagination = parsePagination(value.pagination);
  if (!pagination) return null;
  const items: T[] = [];
  for (const item of value.items) {
    if (!itemGuard(item)) return null;
    items.push(item);
  }
  return { items, pagination };
}

function parseExport<T>(
  value: unknown,
  itemGuard: (item: unknown) => item is T,
): T[] | null {
  if (!Array.isArray(value)) return null;
  const items: T[] = [];
  for (const item of value) {
    if (!itemGuard(item)) return null;
    items.push(item);
  }
  return items;
}

function compactId(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-8)}`;
}

function snapshotText(value: Record<string, unknown> | null) {
  if (value === null) return "Not recorded";
  try {
    return JSON.stringify(value, null, 2) ?? "Not available";
  } catch {
    return "Not available";
  }
}

function dateBoundary(value: string, timezone: string, endOfDay = false) {
  if (!value) return undefined;
  return datetimeInputToUtc(
    `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`,
    timezone,
  );
}

function safeErrorMessage(
  reason: unknown,
  resource: string,
  action: "load" | "export",
) {
  if (reason instanceof ApiError && reason.status === 403) {
    return `Administrator access is required to ${action} ${resource}.`;
  }
  if (reason instanceof ApiError && reason.status === 422) {
    return `The ${resource} filters were rejected. Check the filter values and try again.`;
  }
  if (action === "export") {
    return `${resource} could not be exported. Try again.`;
  }
  return `${resource} could not be loaded. Try again.`;
}

function triggerJsonDownload(value: unknown[], filename: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function DetailList({
  details,
}: {
  details: Array<{ label: string; value: string; mono?: boolean }>;
}) {
  return (
    <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
      {details.map(({ label, value, mono }) => (
        <div key={label} className="min-w-0">
          <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            {label}
          </dt>
          <dd
            className={
              mono ? "mt-1 font-mono text-xs break-all" : "mt-1 break-words"
            }
          >
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function AuditDetails({ item }: { item: AuditLog }) {
  const { profile } = useWorkspace();
  return (
    <details className="group">
      <summary
        className="focus-visible:outline-ring text-primary inline-flex min-h-11 cursor-pointer list-none items-center rounded-[var(--radius)] px-2 py-1 text-xs font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden"
        aria-label={`View details for ${item.action} ${item.entity_type}`}
      >
        View details
      </summary>
      <div className="bg-muted/40 border-border mt-3 space-y-4 rounded-[var(--radius)] border p-4 text-left">
        <DetailList
          details={[
            {
              label: "Entity ID",
              value: item.entity_id ?? "Not recorded",
              mono: true,
            },
            {
              label: "Actor",
              value: `${item.actor_label ?? "No actor label"} · ID: ${item.performed_by ?? "Not recorded"}`,
            },
            {
              label: "Request ID",
              value: item.request_id ?? "Not recorded",
              mono: true,
            },
            {
              label: "Request",
              value:
                `${item.request_method ?? "Not recorded"} ${item.request_path ?? ""}`.trim(),
              mono: true,
            },
            {
              label: "Timestamp",
              value: formatWorkspaceDateTime(item.created_at, profile),
            },
            { label: "Note", value: item.note ?? "No note recorded" },
          ]}
        />
        <div className="grid gap-4 md:grid-cols-2">
          <div className="min-w-0">
            <h4 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              Before
            </h4>
            <pre className="bg-card border-border mt-2 max-h-72 overflow-auto rounded-[var(--radius)] border p-3 font-mono text-xs break-words whitespace-pre-wrap">
              {snapshotText(item.before)}
            </pre>
          </div>
          <div className="min-w-0">
            <h4 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              After
            </h4>
            <pre className="bg-card border-border mt-2 max-h-72 overflow-auto rounded-[var(--radius)] border p-3 font-mono text-xs break-words whitespace-pre-wrap">
              {snapshotText(item.after)}
            </pre>
          </div>
        </div>
      </div>
    </details>
  );
}

function AuditTable({ items }: { items: AuditLog[] }) {
  const { profile } = useWorkspace();
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] text-left text-sm">
        <caption className="sr-only">Audit log entries</caption>
        <thead className="bg-muted/60 text-muted-foreground text-xs uppercase">
          <tr>
            <th scope="col" className="px-5 py-3 font-medium">
              Action
            </th>
            <th scope="col" className="px-5 py-3 font-medium">
              Entity
            </th>
            <th scope="col" className="px-5 py-3 font-medium">
              Request
            </th>
            <th scope="col" className="px-5 py-3 font-medium">
              Actor
            </th>
            <th scope="col" className="px-5 py-3 font-medium">
              When
            </th>
            <th scope="col" className="px-5 py-3 font-medium">
              Details
            </th>
          </tr>
        </thead>
        <tbody className="divide-border divide-y">
          {items.map((item) => (
            <tr key={item.id} className="hover:bg-muted/30 align-top">
              <td className="px-5 py-4">
                <Badge
                  variant={item.action === "delete" ? "warning" : "default"}
                >
                  {item.action}
                </Badge>
              </td>
              <td className="px-5 py-4">
                <p className="font-medium break-words">{item.entity_type}</p>
                <p className="text-muted-foreground font-mono text-[11px]">
                  {item.entity_id ? compactId(item.entity_id) : "No entity ID"}
                </p>
              </td>
              <td className="text-muted-foreground max-w-72 px-5 py-4 font-mono text-xs break-all">
                {item.request_path ?? "Not recorded"}
              </td>
              <td className="text-muted-foreground max-w-52 px-5 py-4 text-xs break-words">
                {item.actor_label ??
                  (item.performed_by ? compactId(item.performed_by) : "System")}
              </td>
              <td className="text-muted-foreground px-5 py-4 text-xs whitespace-nowrap">
                <time dateTime={item.created_at}>
                  {formatWorkspaceDateTime(item.created_at, profile)}
                </time>
              </td>
              <td className="px-5 py-4">
                <AuditDetails item={item} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function outcomeVariant(outcome: SecurityEventOutcome) {
  if (outcome === "success") return "success" as const;
  if (outcome === "denied" || outcome === "failure") {
    return "destructive" as const;
  }
  if (outcome === "partial") return "warning" as const;
  return "default" as const;
}

function SecurityDetails({ item }: { item: SecurityEvent }) {
  const { profile } = useWorkspace();
  return (
    <details className="group">
      <summary
        className="focus-visible:outline-ring text-primary inline-flex min-h-11 cursor-pointer list-none items-center rounded-[var(--radius)] px-2 py-1 text-xs font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden"
        aria-label={`View details for ${item.event_type}`}
      >
        View details
      </summary>
      <div className="bg-muted/40 border-border mt-3 space-y-4 rounded-[var(--radius)] border p-4 text-left">
        <DetailList
          details={[
            { label: "Event type", value: item.event_type },
            { label: "Outcome", value: item.outcome },
            { label: "Source", value: item.source },
            {
              label: "Operation ID (correlation)",
              value: item.operation_id,
              mono: true,
            },
            {
              label: "Actor ID",
              value: item.actor_id ?? "Not recorded",
              mono: true,
            },
            {
              label: "Subject ID",
              value: item.subject_id ?? "Not recorded",
              mono: true,
            },
            { label: "Reason", value: item.reason ?? "No reason recorded" },
            {
              label: "Timestamp",
              value: formatWorkspaceDateTime(item.occurred_at, profile),
            },
            {
              label: "Request",
              value:
                `${item.request_method ?? "Not recorded"} ${item.request_path ?? ""}`.trim(),
              mono: true,
            },
            {
              label: "Request ID",
              value: item.request_id ?? "Not recorded",
              mono: true,
            },
          ]}
        />
      </div>
    </details>
  );
}

function SecurityTable({ items }: { items: SecurityEvent[] }) {
  const { profile } = useWorkspace();
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] text-left text-sm">
        <caption className="sr-only">Security event entries</caption>
        <thead className="bg-muted/60 text-muted-foreground text-xs uppercase">
          <tr>
            <th scope="col" className="px-5 py-3 font-medium">
              Event
            </th>
            <th scope="col" className="px-5 py-3 font-medium">
              Outcome
            </th>
            <th scope="col" className="px-5 py-3 font-medium">
              Source
            </th>
            <th scope="col" className="px-5 py-3 font-medium">
              Operation
            </th>
            <th scope="col" className="px-5 py-3 font-medium">
              Actor / subject
            </th>
            <th scope="col" className="px-5 py-3 font-medium">
              When
            </th>
            <th scope="col" className="px-5 py-3 font-medium">
              Details
            </th>
          </tr>
        </thead>
        <tbody className="divide-border divide-y">
          {items.map((item) => (
            <tr key={item.id} className="hover:bg-muted/30 align-top">
              <td className="px-5 py-4">
                <p className="font-medium break-words">{item.event_type}</p>
                <p className="text-muted-foreground font-mono text-[11px]">
                  {compactId(item.id)}
                </p>
              </td>
              <td className="px-5 py-4">
                <Badge variant={outcomeVariant(item.outcome)}>
                  {item.outcome}
                </Badge>
              </td>
              <td className="text-muted-foreground px-5 py-4 break-words">
                {item.source}
              </td>
              <td className="text-muted-foreground max-w-64 px-5 py-4 font-mono text-xs break-all">
                {item.operation_id}
              </td>
              <td className="text-muted-foreground max-w-52 px-5 py-4 text-xs break-all">
                <div>Actor: {item.actor_id ?? "Not recorded"}</div>
                <div>Subject: {item.subject_id ?? "Not recorded"}</div>
              </td>
              <td className="text-muted-foreground px-5 py-4 text-xs whitespace-nowrap">
                <time dateTime={item.occurred_at}>
                  {formatWorkspaceDateTime(item.occurred_at, profile)}
                </time>
              </td>
              <td className="px-5 py-4">
                <SecurityDetails item={item} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyState({ kind }: { kind: AuditView }) {
  const label = kind === "audit" ? "audit logs" : "security events";
  return (
    <div className="text-muted-foreground p-10 text-center text-sm">
      {kind === "audit" ? (
        <FileClock className="mx-auto mb-3" aria-hidden="true" />
      ) : (
        <ShieldAlert className="mx-auto mb-3" aria-hidden="true" />
      )}
      <p>No {label} found for the current filters.</p>
    </div>
  );
}

function PaginationControls({
  label,
  offset,
  pagination,
  itemCount,
  onPrevious,
  onNext,
  disabled,
}: {
  label: string;
  offset: number;
  pagination: Pagination;
  itemCount: number;
  onPrevious: () => void;
  onNext: () => void;
  disabled: boolean;
}) {
  const start = pagination.total === 0 ? 0 : offset + 1;
  const end = offset + itemCount;
  return (
    <div className="border-border flex flex-col gap-3 border-t px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-muted-foreground text-xs" aria-live="polite">
        Showing {start}–{end} of {pagination.total} {label}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Previous ${label} page`}
          onClick={onPrevious}
          disabled={disabled || offset === 0}
        >
          <ChevronLeft aria-hidden="true" /> Previous
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Next ${label} page`}
          onClick={onNext}
          disabled={disabled || !pagination.has_more}
        >
          Next <ChevronRight aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

export default function AuditPage() {
  const { profile } = useWorkspace();
  const [view, setView] = useState<AuditView>("audit");
  const [auditItems, setAuditItems] = useState<AuditLog[]>([]);
  const [auditPagination, setAuditPagination] = useState<Pagination | null>(
    null,
  );
  const [auditSearch, setAuditSearch] = useState("");
  const [auditAction, setAuditAction] = useState("");
  const [auditEntityType, setAuditEntityType] = useState("");
  const [auditFrom, setAuditFrom] = useState("");
  const [auditTo, setAuditTo] = useState("");
  const [auditOffset, setAuditOffset] = useState(0);
  const [auditRetry, setAuditRetry] = useState(0);
  const [auditLoading, setAuditLoading] = useState(true);
  const [auditError, setAuditError] = useState("");
  const [securityItems, setSecurityItems] = useState<SecurityEvent[]>([]);
  const [securityPagination, setSecurityPagination] =
    useState<Pagination | null>(null);
  const [securitySearch, setSecuritySearch] = useState("");
  const [securityOperationId, setSecurityOperationId] = useState("");
  const [securityOffset, setSecurityOffset] = useState(0);
  const [securityRetry, setSecurityRetry] = useState(0);
  const [securityLoading, setSecurityLoading] = useState(false);
  const [securityError, setSecurityError] = useState("");
  const [exportError, setExportError] = useState("");
  const [exporting, setExporting] = useState<AuditView | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setAuditLoading(true);
    setAuditError("");
    let query: string;
    try {
      query = listQuery({
        limit: PAGE_SIZE,
        offset: auditOffset,
        search: auditSearch.trim() || undefined,
        action: auditAction || undefined,
        entity_type: auditEntityType.trim() || undefined,
        created_after: dateBoundary(auditFrom, profile.timezone),
        created_before: dateBoundary(auditTo, profile.timezone, true),
        sort_by: "created_at",
        sort_order: "desc",
      });
    } catch {
      setAuditItems([]);
      setAuditPagination(null);
      setAuditLoading(false);
      setAuditError(
        "The selected date boundary is not unique in the workspace timezone. Choose another date.",
      );
      return () => controller.abort();
    }
    void apiFetch<unknown>(`/audit-logs?${query}`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!active) return;
        const result = parseListResponse(value, isAuditLog);
        if (!result)
          throw new Error("Audit logs returned an unexpected response");
        setAuditItems(result.items);
        setAuditPagination(result.pagination);
      })
      .catch((reason: unknown) => {
        if (!active || controller.signal.aborted) return;
        setAuditItems([]);
        setAuditPagination(null);
        setAuditError(safeErrorMessage(reason, "audit logs", "load"));
      })
      .finally(() => {
        if (active) setAuditLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    auditAction,
    auditEntityType,
    auditFrom,
    auditOffset,
    auditRetry,
    auditSearch,
    auditTo,
    profile.timezone,
  ]);

  useEffect(() => {
    if (view !== "security") return;
    const controller = new AbortController();
    let active = true;
    setSecurityLoading(true);
    setSecurityError("");
    const query = listQuery({
      limit: PAGE_SIZE,
      offset: securityOffset,
      search: securitySearch.trim() || undefined,
      operation_id: securityOperationId.trim() || undefined,
      sort_by: "occurred_at",
      sort_order: "desc",
    });
    void apiFetch<unknown>(`/security-events?${query}`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!active) return;
        const result = parseListResponse(value, isSecurityEvent);
        if (!result)
          throw new Error("Security events returned an unexpected response");
        setSecurityItems(result.items);
        setSecurityPagination(result.pagination);
      })
      .catch((reason: unknown) => {
        if (!active || controller.signal.aborted) return;
        setSecurityItems([]);
        setSecurityPagination(null);
        setSecurityError(safeErrorMessage(reason, "security events", "load"));
      })
      .finally(() => {
        if (active) setSecurityLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    securityOffset,
    securityOperationId,
    securityRetry,
    securitySearch,
    view,
  ]);

  function selectView(nextView: AuditView) {
    setView(nextView);
    setExportError("");
  }

  function clearAuditFilters() {
    setAuditSearch("");
    setAuditAction("");
    setAuditEntityType("");
    setAuditFrom("");
    setAuditTo("");
    setAuditOffset(0);
  }

  function clearSecurityFilters() {
    setSecuritySearch("");
    setSecurityOperationId("");
    setSecurityOffset(0);
  }

  async function exportAuditLogs() {
    if (exporting) return;
    setExporting("audit");
    setExportError("");
    try {
      const query = listQuery({
        limit: PAGE_SIZE,
        offset: auditOffset,
        search: auditSearch.trim() || undefined,
        action: auditAction || undefined,
        entity_type: auditEntityType.trim() || undefined,
        created_after: dateBoundary(auditFrom, profile.timezone),
        created_before: dateBoundary(auditTo, profile.timezone, true),
        sort_by: "created_at",
        sort_order: "desc",
      });
      const value = await apiFetch<unknown>(`/audit-logs/export?${query}`);
      const items = parseExport(value, isAuditLog);
      if (!items)
        throw new Error("Audit export returned an unexpected response");
      triggerJsonDownload(items, "audit-logs.json");
      toast.add({
        title: "Audit logs exported as bounded JSON.",
        type: "success",
      });
    } catch (reason: unknown) {
      setExportError(safeErrorMessage(reason, "audit logs", "export"));
    } finally {
      setExporting(null);
    }
  }

  async function exportSecurityEvents() {
    if (exporting) return;
    setExporting("security");
    setExportError("");
    const query = listQuery({
      limit: EXPORT_LIMIT,
      operation_id: securityOperationId.trim() || undefined,
    });
    try {
      const value = await apiFetch<unknown>(`/security-events/export?${query}`);
      const items = parseExport(value, isSecurityEvent);
      if (!items)
        throw new Error("Security export returned an unexpected response");
      triggerJsonDownload(items, "security-events.json");
      toast.add({
        title: "Security events exported as bounded JSON.",
        type: "success",
      });
    } catch (reason: unknown) {
      setExportError(safeErrorMessage(reason, "security events", "export"));
    } finally {
      setExporting(null);
    }
  }

  const isAudit = view === "audit";
  const currentError = isAudit ? auditError : securityError;
  const currentLoading = isAudit ? auditLoading : securityLoading;
  const currentPagination = isAudit ? auditPagination : securityPagination;
  const currentOffset = isAudit ? auditOffset : securityOffset;
  const currentItems = isAudit ? auditItems : securityItems;

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Audit trail"
        description="A read-only record of application-level mutations and security events, with request context and operational correlation for administrators."
        actions={<Badge variant="default">Backend enforced</Badge>}
      />
      <Alert className="mb-5 flex gap-3">
        <ShieldAlert size={17} className="mt-0.5 shrink-0" aria-hidden="true" />
        <div>
          <p className="font-semibold">Administrator-only governance data</p>
          <p className="mt-1">
            Access, filtering, and exports are authorized by the backend. No
            event payloads are written or changed from this view.
          </p>
        </div>
      </Alert>
      <Card>
        <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>{isAudit ? "Audit logs" : "Security events"}</CardTitle>
            <CardDescription>
              {isAudit
                ? "Bounded application mutation history with request and snapshot context."
                : "Bounded security telemetry with operation-level correlation."}
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              void (isAudit ? exportAuditLogs() : exportSecurityEvents())
            }
            disabled={!!exporting || currentLoading}
          >
            <Download aria-hidden="true" />
            {exporting === view ? "Exporting…" : "Export JSON"}
          </Button>
        </CardHeader>
        <Tabs
          value={view}
          onValueChange={(value) => selectView(value as AuditView)}
        >
          <TabsList
            aria-label="Audit governance views"
            activateOnFocus={false}
            className="border-border flex flex-wrap gap-1 border-b px-5 pt-4"
          >
            <TabsTrigger value="audit">Audit logs</TabsTrigger>
            <TabsTrigger value="security">Security events</TabsTrigger>
          </TabsList>
          <TabsContent value={view} className="space-y-5 p-0">
            {isAudit ? (
              <form
                className="bg-muted/20 grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-6"
                onSubmit={(event) => event.preventDefault()}
              >
                <div className="space-y-2 sm:col-span-2 lg:col-span-2">
                  <label
                    className="text-foreground text-sm font-medium"
                    htmlFor="audit-search"
                  >
                    Search audit trail
                  </label>
                  <div className="relative">
                    <Search
                      size={16}
                      className="text-muted-foreground absolute top-3 left-3"
                      aria-hidden="true"
                    />
                    <Input
                      id="audit-search"
                      className="pl-9"
                      placeholder="Search entity or request path"
                      value={auditSearch}
                      onChange={(event) => {
                        setAuditSearch(event.target.value);
                        setAuditOffset(0);
                      }}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <label
                    className="text-foreground text-sm font-medium"
                    htmlFor="audit-action"
                  >
                    Action
                  </label>
                  <select
                    id="audit-action"
                    className="border-input bg-card text-foreground focus-visible:border-primary h-10 w-full rounded-[var(--radius)] border px-3 text-sm"
                    value={auditAction}
                    onChange={(event) => {
                      setAuditAction(event.target.value);
                      setAuditOffset(0);
                    }}
                  >
                    <option value="">All actions</option>
                    <option value="create">Create</option>
                    <option value="update">Update</option>
                    <option value="delete">Delete</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <label
                    className="text-foreground text-sm font-medium"
                    htmlFor="audit-entity-type"
                  >
                    Entity type
                  </label>
                  <Input
                    id="audit-entity-type"
                    placeholder="e.g. records"
                    value={auditEntityType}
                    onChange={(event) => {
                      setAuditEntityType(event.target.value);
                      setAuditOffset(0);
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <label
                    className="text-foreground text-sm font-medium"
                    htmlFor="audit-from"
                  >
                    From date
                  </label>
                  <Input
                    id="audit-from"
                    type="date"
                    value={auditFrom}
                    onChange={(event) => {
                      setAuditFrom(event.target.value);
                      setAuditOffset(0);
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <label
                    className="text-foreground text-sm font-medium"
                    htmlFor="audit-to"
                  >
                    To date
                  </label>
                  <Input
                    id="audit-to"
                    type="date"
                    value={auditTo}
                    onChange={(event) => {
                      setAuditTo(event.target.value);
                      setAuditOffset(0);
                    }}
                  />
                </div>
                {(auditSearch ||
                  auditAction ||
                  auditEntityType ||
                  auditFrom ||
                  auditTo) && (
                  <div className="flex items-end lg:col-span-6">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={clearAuditFilters}
                    >
                      Clear filters
                    </Button>
                  </div>
                )}
              </form>
            ) : (
              <form
                className="bg-muted/20 grid gap-4 p-5 sm:grid-cols-2"
                onSubmit={(event) => event.preventDefault()}
              >
                <div className="space-y-2">
                  <label
                    className="text-foreground text-sm font-medium"
                    htmlFor="security-search"
                  >
                    Search security events
                  </label>
                  <div className="relative">
                    <Search
                      size={16}
                      className="text-muted-foreground absolute top-3 left-3"
                      aria-hidden="true"
                    />
                    <Input
                      id="security-search"
                      className="pl-9"
                      placeholder="Search type, source, reason, or path"
                      value={securitySearch}
                      onChange={(event) => {
                        setSecuritySearch(event.target.value);
                        setSecurityOffset(0);
                      }}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <label
                    className="text-foreground text-sm font-medium"
                    htmlFor="security-operation-id"
                  >
                    Operation ID
                  </label>
                  <Input
                    id="security-operation-id"
                    className="font-mono text-xs"
                    placeholder="Filter a correlated operation"
                    value={securityOperationId}
                    onChange={(event) => {
                      setSecurityOperationId(event.target.value);
                      setSecurityOffset(0);
                    }}
                  />
                </div>
                {(securitySearch || securityOperationId) && (
                  <div className="flex items-end sm:col-span-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={clearSecurityFilters}
                    >
                      Clear filters
                    </Button>
                  </div>
                )}
              </form>
            )}
            {currentError && (
              <Alert
                variant="destructive"
                className="mx-5 flex flex-wrap items-center justify-between gap-3"
              >
                <span>{currentError}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    if (isAudit) setAuditRetry((retry) => retry + 1);
                    else setSecurityRetry((retry) => retry + 1);
                  }}
                  disabled={currentLoading}
                >
                  <RefreshCw aria-hidden="true" /> Try again
                </Button>
              </Alert>
            )}
            {exportError && (
              <Alert variant="destructive" className="mx-5">
                {exportError}
              </Alert>
            )}
            {currentLoading && currentItems.length === 0 ? (
              <div
                className="text-muted-foreground px-5 py-10 text-sm"
                role="status"
              >
                <span className="sr-only">
                  Loading {isAudit ? "audit logs" : "security events"}…
                </span>
                <Skeleton className="h-40 w-full" />
              </div>
            ) : currentError ? null : currentItems.length === 0 ? (
              <EmptyState kind={view} />
            ) : (
              <>
                {currentLoading && (
                  <p
                    className="text-muted-foreground border-border border-y px-5 py-3 text-xs"
                    role="status"
                  >
                    Refreshing {isAudit ? "audit logs" : "security events"}…
                  </p>
                )}
                {isAudit ? (
                  <AuditTable items={auditItems} />
                ) : (
                  <SecurityTable items={securityItems} />
                )}
              </>
            )}
            {currentPagination && !currentError && (
              <PaginationControls
                label={isAudit ? "audit logs" : "security events"}
                offset={currentOffset}
                pagination={currentPagination}
                itemCount={currentItems.length}
                onPrevious={() => {
                  if (isAudit) {
                    setAuditOffset((offset) => Math.max(0, offset - PAGE_SIZE));
                  } else {
                    setSecurityOffset((offset) =>
                      Math.max(0, offset - PAGE_SIZE),
                    );
                  }
                }}
                onNext={() => {
                  if (isAudit) setAuditOffset((offset) => offset + PAGE_SIZE);
                  else setSecurityOffset((offset) => offset + PAGE_SIZE);
                }}
                disabled={currentLoading}
              />
            )}
          </TabsContent>
        </Tabs>
      </Card>
      <p className="sr-only" role="status">
        Showing {isAudit ? "audit logs" : "security events"}
      </p>
    </>
  );
}
