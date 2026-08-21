"use client";

import { useEffect, useState } from "react";
import { FileClock, Search } from "lucide-react";
import { AppPage } from "@/components/app-page";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { apiFetch, listQuery, type ListResponse } from "@/lib/api";

type AuditLog = {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  request_path: string;
  created_at: string;
  performed_by: string | null;
};
export default function AuditPage() {
  const [items, setItems] = useState<AuditLog[]>([]);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    async function load() {
      try {
        const result = await apiFetch<ListResponse<AuditLog>>(
          `/audit-logs?${listQuery({ limit: 100, search, sort_by: "created_at", sort_order: "desc" })}`,
        );
        setItems(result.items);
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Audit trail could not be loaded",
        );
      }
    }
    void load();
  }, [search]);
  return (
    <AppPage>
      <PageHeader
        eyebrow="Administration"
        title="Audit trail"
        description="A read-only record of application-level mutations and the actor context attached to them."
      />
      <div className="mb-5 max-w-md">
        <div className="relative">
          <Search
            size={16}
            className="text-muted-foreground absolute top-3 left-3"
          />
          <Input
            className="pl-9"
            aria-label="Search audit trail"
            placeholder="Search entity or request path"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>
      {error && <p className="text-destructive mb-5 text-sm">{error}</p>}
      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="bg-muted/60 text-muted-foreground text-xs uppercase">
              <tr>
                <th className="px-5 py-3 font-medium">Action</th>
                <th className="px-5 py-3 font-medium">Entity</th>
                <th className="px-5 py-3 font-medium">Path</th>
                <th className="px-5 py-3 font-medium">Actor</th>
                <th className="px-5 py-3 font-medium">When</th>
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {items.length === 0 && (
                <tr>
                  <td
                    className="text-muted-foreground px-5 py-10 text-center"
                    colSpan={5}
                  >
                    <FileClock className="mx-auto mb-3" />
                    No audit events found.
                  </td>
                </tr>
              )}
              {items.map((item) => (
                <tr key={item.id} className="hover:bg-muted/30">
                  <td className="px-5 py-4">
                    <Badge
                      variant={item.action === "delete" ? "warning" : "default"}
                    >
                      {item.action}
                    </Badge>
                  </td>
                  <td className="px-5 py-4">
                    <p className="font-medium">{item.entity_type}</p>
                    <p className="text-muted-foreground font-mono text-[11px]">
                      {item.entity_id.slice(0, 8)}…
                    </p>
                  </td>
                  <td className="text-muted-foreground px-5 py-4 font-mono text-xs">
                    {item.request_path}
                  </td>
                  <td className="text-muted-foreground px-5 py-4 font-mono text-xs">
                    {item.performed_by?.slice(0, 8) ?? "system"}
                  </td>
                  <td className="text-muted-foreground px-5 py-4 text-xs">
                    {new Date(item.created_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </AppPage>
  );
}
