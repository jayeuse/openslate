"use client";

import type { ReactNode } from "react";

import { Box, Building2, Link2, Plus, Type } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { SandboxFieldType } from "@/lib/sandbox/model";

export interface EmptyBuilderProps {
  onAddDepartment: () => void;
}

export interface EmptyDepartmentProps {
  onAddModule: () => void;
}

export interface EmptyModuleProps {
  onAddField: (type: SandboxFieldType) => void;
}

export interface EmptyLinksProps {
  onStartRelationship: () => void;
}

interface EmptyStateShellProps {
  icon: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
}

function EmptyStateShell({
  icon,
  title,
  description,
  children,
}: EmptyStateShellProps) {
  return (
    <Card className="mx-auto w-full max-w-sm p-6 text-center">
      <div
        aria-hidden="true"
        className="bg-muted mx-auto flex size-11 items-center justify-center rounded-full"
      >
        {icon}
      </div>
      <h2 className="mt-3 text-base font-semibold">{title}</h2>
      <p className="text-muted-foreground mt-1 text-sm">{description}</p>
      <div className="mt-4 flex justify-center">{children}</div>
    </Card>
  );
}

export function EmptyBuilder({ onAddDepartment }: EmptyBuilderProps) {
  return (
    <EmptyStateShell
      icon={<Building2 aria-hidden="true" className="size-5" />}
      title="Start with a department"
      description="Departments group related modules on the canvas."
    >
      <Button
        type="button"
        className="pointer-events-auto"
        data-testid="empty-add-department"
        onClick={onAddDepartment}
      >
        <Plus aria-hidden="true" />
        Add department
      </Button>
    </EmptyStateShell>
  );
}

export function EmptyDepartment({ onAddModule }: EmptyDepartmentProps) {
  return (
    <EmptyStateShell
      icon={<Box aria-hidden="true" className="size-5" />}
      title="Add your first module"
      description="Modules live inside departments and hold fields."
    >
      <Button
        type="button"
        data-testid="empty-add-module"
        onClick={onAddModule}
      >
        <Plus aria-hidden="true" />
        Add module
      </Button>
    </EmptyStateShell>
  );
}

export function EmptyModule({ onAddField }: EmptyModuleProps) {
  return (
    <EmptyStateShell
      icon={<Type aria-hidden="true" className="size-5" />}
      title="Add your first field"
      description="Fields describe the data each module stores."
    >
      <Button
        type="button"
        data-testid="empty-add-field"
        onClick={() => onAddField("text")}
      >
        <Plus aria-hidden="true" />
        Add text field
      </Button>
    </EmptyStateShell>
  );
}

export function EmptyLinks({ onStartRelationship }: EmptyLinksProps) {
  return (
    <EmptyStateShell
      icon={<Link2 aria-hidden="true" className="size-5" />}
      title="Connect two modules"
      description="Relationships link modules so records stay in sync."
    >
      <Button
        type="button"
        data-testid="empty-start-relationship"
        onClick={onStartRelationship}
      >
        <Plus aria-hidden="true" />
        Start relationship
      </Button>
    </EmptyStateShell>
  );
}
