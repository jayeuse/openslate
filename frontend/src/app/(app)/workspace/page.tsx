import Link from "next/link";
import { ArrowRight, Building2, ListChecks, Workflow } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const shortcuts = [
  {
    href: "/sandbox",
    icon: Workflow,
    title: "Organization Designer",
    description:
      "Explore departments, modules, fields, and relationships in the Sandbox.",
    action: "Open designer",
  },
  {
    href: "/departments",
    icon: Building2,
    title: "Departments",
    description:
      "Browse your organization and work with its modules and records.",
    action: "Browse departments",
  },
  {
    href: "/onboarding",
    icon: ListChecks,
    title: "Setup checklist",
    description:
      "Follow the steps from your first department to validated records.",
    action: "Open setup checklist",
  },
] as const;

export default function WorkspacePage() {
  return (
    <>
      <PageHeader
        title="Good morning. Start with the model."
        description="Choose where you want to work."
        actions={
          <Button asChild>
            <Link href="/departments/new">
              Create department <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>Workspace overview</CardTitle>
        </CardHeader>
        <CardContent className="divide-border divide-y p-0">
          {shortcuts.map(({ href, icon: Icon, title, description, action }) => (
            <Link
              key={href}
              href={href}
              className="hover:bg-muted/60 focus-visible:outline-ring flex items-start gap-4 px-5 py-6 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 sm:items-center"
            >
              <Icon
                className="text-muted-foreground mt-1 size-5 shrink-0 sm:mt-0"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-semibold">{title}</h2>
                <p className="text-muted-foreground mt-1 text-sm leading-6">
                  {description}
                </p>
                <span className="text-primary mt-2 inline-block text-xs font-medium">
                  {action}
                </span>
              </div>
              <ArrowRight
                className="text-muted-foreground mt-1 size-4 shrink-0 sm:mt-0"
                aria-hidden="true"
              />
            </Link>
          ))}
        </CardContent>
      </Card>
    </>
  );
}
