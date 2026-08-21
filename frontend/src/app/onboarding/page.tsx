"use client";

import {
  ArrowRight,
  Check,
  CircleAlert,
  ExternalLink,
  LockKeyhole,
} from "lucide-react";
import { AppPage } from "@/components/app-page";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const steps = [
  {
    title: "Administrator authenticated",
    description:
      "You are signed in with the administrator account provisioned during deployment.",
    done: true,
    href: "/workspace",
  },
  {
    title: "Create a department",
    description: "Departments give your operational areas a clear home.",
    href: "/departments/new",
  },
  {
    title: "Create a module",
    description: "A module is the record collection your team will work with.",
    href: "/departments",
  },
  {
    title: "Add fields",
    description: "Define the fields and validation rules for each record.",
    href: "/departments",
  },
  {
    title: "Validate module",
    description:
      "Review the schema for positions, options, and required values.",
    href: "/departments",
  },
  {
    title: "Add first record",
    description:
      "Create a real record to confirm the model works for your team.",
    href: "/departments",
  },
  {
    title: "Create roles and staff users",
    description:
      "Role metadata can be created now; effective domain access remains admin-only in the current API.",
    href: "/administration/roles",
    note: true,
  },
];

export default function OnboardingPage() {
  return (
    <AppPage>
      <PageHeader
        eyebrow="Guided setup"
        title="Build the operating model in order."
        description="Each step explains what needs to be true before the next action becomes useful."
        actions={<Badge variant="outline">Live workspace checklist</Badge>}
      />
      <div className="grid gap-5 lg:grid-cols-[1fr_0.42fr]">
        <Card>
          <CardContent className="p-0">
            {steps.map((step, index) => (
              <div
                className="border-border flex gap-4 border-b p-5 last:border-b-0 sm:p-6"
                key={step.title}
              >
                <div
                  className={
                    step.done
                      ? "text-success grid size-9 shrink-0 place-items-center rounded-full bg-green-100 dark:bg-green-950"
                      : "border-border text-muted-foreground grid size-9 shrink-0 place-items-center rounded-full border text-sm font-semibold"
                  }
                >
                  {step.done ? <Check size={17} /> : index + 1}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-semibold">{step.title}</h2>
                    {step.done && <Badge variant="success">Complete</Badge>}
                    {step.note && (
                      <Badge variant="warning">Admin-only API</Badge>
                    )}
                  </div>
                  <p className="text-muted-foreground mt-1 max-w-2xl text-sm leading-6">
                    {step.description}
                  </p>
                  {step.note && (
                    <p className="text-warning mt-3 flex items-start gap-2 text-xs">
                      <CircleAlert size={14} className="mt-0.5 shrink-0" />
                      Permissions are stored by the backend but are not
                      currently evaluated for authorization.
                    </p>
                  )}
                  <a
                    href={step.href}
                    className="text-primary mt-4 inline-flex items-center gap-2 text-sm font-medium hover:underline"
                  >
                    {step.done ? "Review workspace" : "Start this step"}{" "}
                    <ArrowRight size={15} />
                  </a>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
        <div className="space-y-5">
          <Alert className="flex gap-3">
            <LockKeyhole size={17} className="text-primary mt-0.5 shrink-0" />
            <div>
              <p className="font-semibold">Why the order matters</p>
              <p className="text-muted-foreground mt-1 leading-6">
                Modules need a department, fields need a module, and records
                must match the active field schema.
              </p>
            </div>
          </Alert>
          <Card>
            <CardHeader>
              <CardTitle>Before you continue</CardTitle>
            </CardHeader>
            <CardContent className="text-muted-foreground space-y-4 text-sm">
              <p>
                Archived parent resources block restore until their dependencies
                are active again.
              </p>
              <p>
                Record edits replace the complete data object, so keep all
                current field values when editing.
              </p>
              <a
                href="/docs"
                className="text-primary inline-flex items-center gap-2 font-medium"
              >
                Open API reference <ExternalLink size={14} />
              </a>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppPage>
  );
}
