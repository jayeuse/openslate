"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Route } from "next";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

const sectionLabels: Record<string, string> = {
  sandbox: "Sandbox",
  boards: "Boards",
  comms: "OpenComms",
  access: "Access",
  openview: "OpenView",
  manage: "Manage",
  platform: "Workspace tools",
};

export function AppBreadcrumbs() {
  const pathname = usePathname();
  const section = pathname.split("/").filter(Boolean)[0];
  const label =
    pathname === "/settings/appearance"
      ? "Appearance"
      : sectionLabels[section] || "Workspace";
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        <BreadcrumbItem>
          <BreadcrumbLink render={<Link href={"/openview" as Route} />}>
            Workspace
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem className="min-w-0">
          <BreadcrumbPage className="truncate">{label}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
