"use client";

import { useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiFetch, type Department } from "@/lib/api";

export default function NewDepartmentPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const department = await apiFetch<Department>("/departments", {
        method: "POST",
        body: JSON.stringify({ department_name: name }),
      });
      router.push(`/departments/${department.id}`);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Department could not be created",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="Workspace / Structure"
        title="Create a department"
        description="This becomes the parent for one or more operational modules."
        actions={
          <Button asChild variant="ghost">
            <a href="/departments">
              <ArrowLeft size={16} /> Back
            </a>
          </Button>
        }
      />
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Department details</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="space-y-6" onSubmit={submit}>
            {error && <Alert variant="destructive">{error}</Alert>}
            <div className="space-y-2">
              <Label htmlFor="department-name">Department name</Label>
              <Input
                id="department-name"
                autoFocus
                maxLength={150}
                required
                placeholder="e.g. Customer Operations"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                Use a name your team will recognize in navigation and reports.
              </p>
            </div>
            <div className="flex justify-end">
              <Button disabled={pending}>
                {pending ? (
                  "Creating…"
                ) : (
                  <>
                    Create department <ArrowRight size={16} />
                  </>
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </>
  );
}
