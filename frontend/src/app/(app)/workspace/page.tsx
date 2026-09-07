"use client";

import {
  ArrowRight,
  Building2,
  CircleCheck,
  ListChecks,
  Plus,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const steps = [
  "Create a department",
  "Create a module",
  "Add and order fields",
  "Validate the module",
  "Add your first record",
];

export default function WorkspacePage() {
  return (
    <>
      <PageHeader
        eyebrow="Administrator workspace"
        title="Good morning. Start with the model."
        description="OpenSlate keeps setup and daily operations in the same place. Begin with the next incomplete step, or jump into an existing department."
        actions={
          <Button asChild>
            <a href="/onboarding">
              Open setup checklist <ArrowRight size={16} />
            </a>
          </Button>
        }
      />
      <div className="grid gap-5 xl:grid-cols-[1.5fr_1fr]">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Setup checklist</CardTitle>
                <p className="text-muted-foreground mt-1 text-sm">
                  A guided path from empty workspace to first record.
                </p>
              </div>
              <Badge variant="default">0 of 5 complete</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {steps.map((step, index) => (
              <a
                href="/onboarding"
                key={step}
                className="group hover:border-border hover:bg-muted flex items-center gap-4 rounded-md border border-transparent p-3 transition"
              >
                <span className="border-border text-muted-foreground group-hover:border-primary group-hover:text-primary grid size-8 place-items-center rounded-full border text-xs font-semibold">
                  {index + 1}
                </span>
                <span className="flex-1 text-sm font-medium">{step}</span>
                <ArrowRight
                  size={16}
                  className="text-muted-foreground group-hover:text-primary transition"
                />
              </a>
            ))}
          </CardContent>
        </Card>
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-1">
          <Card>
            <CardContent className="flex items-start gap-4 p-5">
              <div className="bg-accent text-accent-foreground grid size-10 place-items-center rounded-md">
                <Building2 size={19} />
              </div>
              <div>
                <p className="text-sm font-semibold">Departments</p>
                <p className="mt-1 text-2xl font-semibold">0</p>
                <a
                  href="/departments"
                  className="text-primary mt-2 inline-flex items-center gap-1 text-xs font-medium"
                >
                  Browse departments <ArrowRight size={13} />
                </a>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-start gap-4 p-5">
              <div className="bg-accent text-accent-foreground grid size-10 place-items-center rounded-md">
                <ListChecks size={19} />
              </div>
              <div>
                <p className="text-sm font-semibold">Next action</p>
                <p className="text-muted-foreground mt-2 text-sm">
                  Create your first department to begin.
                </p>
                <Button asChild variant="outline" size="sm" className="mt-3">
                  <a href="/departments/new">
                    <Plus size={14} /> Create department
                  </a>
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
      <div className="border-border text-muted-foreground mt-5 flex items-center gap-2 rounded-md border border-dashed p-4 text-sm">
        <CircleCheck size={17} className="text-success" /> Your progress is
        derived from the live workspace, so it stays accurate after refresh.
      </div>
    </>
  );
}
