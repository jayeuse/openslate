"use client";

import { useEffect, useState } from "react";
import {
  ArrowRight,
  Building2,
  Plus,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  apiFetch,
  listQuery,
  type Department,
  type ListResponse,
} from "@/lib/api";

export default function DepartmentsPage() {
  const [items, setItems] = useState<Department[]>([]);
  const [search, setSearch] = useState("");
  const [deleted, setDeleted] = useState("include");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  async function load() {
    setLoading(true);
    setError("");
    try {
      const result = await apiFetch<ListResponse<Department>>(
        `/departments?${listQuery({ limit: 100, search, deleted, sort_by: "department_name", sort_order: "asc" })}`,
      );
      setItems(result.items);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Departments could not be loaded",
      );
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, [search, deleted]);
  return (
    <>
      <PageHeader
        eyebrow="Workspace / Structure"
        title="Departments"
        description="Start with the areas of work your organization needs to coordinate."
        actions={
          <Button asChild>
            <a href="/departments/new">
              <Plus size={16} /> New department
            </a>
          </Button>
        }
      />
      <div className="mb-5 flex flex-col gap-3 sm:flex-row">
        <div className="relative max-w-md flex-1">
          <Search
            size={16}
            className="text-muted-foreground absolute top-3 left-3"
          />
          <Input
            className="pl-9"
            placeholder="Search departments"
            aria-label="Search departments"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <Button
          variant="outline"
          onClick={() =>
            setDeleted(deleted === "exclude" ? "include" : "exclude")
          }
        >
          <SlidersHorizontal size={16} />{" "}
          {deleted === "exclude" ? "Active only" : "Include archived"}
        </Button>
      </div>
      {error && (
        <Alert variant="destructive" className="mb-5">
          {error}{" "}
          <button
            className="ml-2 font-medium underline"
            onClick={() => void load()}
          >
            Try again
          </button>
        </Alert>
      )}
      {!loading && !error && items.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center px-6 py-16 text-center">
            <div className="bg-accent text-accent-foreground grid size-12 place-items-center rounded-full">
              <Building2 />
            </div>
            <h2 className="mt-5 text-lg font-semibold">
              {search ? "No departments found" : "Create your first department"}
            </h2>
            <p className="text-muted-foreground mt-2 max-w-md text-sm leading-6">
              {search
                ? "Try a different name or clear the search."
                : "Departments are the first structural layer. Create one before you create a module."}
            </p>
            {!search && (
              <Button asChild className="mt-5">
                <a href="/departments/new">
                  <Plus size={16} /> Create department
                </a>
              </Button>
            )}
          </CardContent>
        </Card>
      )}
      {loading && items.length === 0 && (
        <div className="border-border bg-card text-muted-foreground rounded-[var(--radius)] border p-8 text-sm">
          <span role="status" className="sr-only">
            Loading departments…
          </span>
          <div
            className="grid gap-3 md:grid-cols-2 xl:grid-cols-3"
            aria-busy="true"
          >
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-48" />
            ))}
          </div>
        </div>
      )}
      {loading && items.length > 0 && (
        <p role="status" className="text-muted-foreground mb-3 text-xs">
          Refreshing departments…
        </p>
      )}
      {items.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((department) => (
            <Card
              key={department.id}
              className="hover:border-primary/50 transition"
            >
              <CardContent className="p-5">
                <div className="flex items-start justify-between">
                  <div className="bg-accent text-accent-foreground grid size-10 place-items-center rounded-md">
                    <Building2 size={19} />
                  </div>
                  <Badge
                    variant={department.is_deleted ? "warning" : "success"}
                  >
                    {department.is_deleted ? "Closed" : "Active"}
                  </Badge>
                </div>
                <h2 className="mt-5 text-lg font-semibold">
                  {department.department_name}
                </h2>
                <p className="text-muted-foreground mt-1 text-xs">
                  Created {new Date(department.created_at).toLocaleDateString()}
                </p>
                <div className="mt-5 flex flex-wrap items-center gap-3">
                  <a
                    href={`/departments/${department.id}`}
                    className="text-primary inline-flex items-center gap-2 text-sm font-medium"
                  >
                    Open department <ArrowRight size={15} />
                  </a>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
