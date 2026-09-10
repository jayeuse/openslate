"use client";

import { useWorkspace } from "@/components/workspace-provider";
import { canNavigate } from "@/lib/workspace";
import Link from "next/link";
import type { Route } from "next";
import { useEffect, useState } from "react";
import {
  BarChart3,
  ChevronDown,
  FolderKanban,
  MessageSquare,
  PanelLeft,
  Settings,
  ShieldCheck,
  TableProperties,
  Users,
  Workflow,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  useSidebar,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
} from "@/components/ui/sidebar";

export type NavigationStructure = "structured" | "classic";

type NavigationItem = {
  label: string;
  href?: Route;
  note?: string;
};

type NavigationIcon = typeof Workflow;

type NavigationGroup = {
  label: string;
  icon: NavigationIcon;
  future?: boolean;
  items: NavigationItem[];
};

const classicLinks = [
  {
    href: "/administration/files" as Route,
    label: "Documents",
    icon: FolderKanban,
  },
  {
    href: "/settings/workspace" as Route,
    label: "Workspace settings",
    icon: Settings,
  },
  { href: "/departments", label: "Departments", icon: PanelLeft },
  { href: "/sandbox", label: "Sandbox", icon: Workflow },
  { href: "/administration/users", label: "People", icon: Users },
  { href: "/administration/roles", label: "Roles", icon: ShieldCheck },
  {
    href: "/administration/audit",
    label: "Audit trail",
    icon: TableProperties,
  },
] satisfies { href: Route; label: string; icon: NavigationIcon }[];

const groups: NavigationGroup[] = [
  {
    label: "OpenView",
    icon: BarChart3,
    items: ["Views", "Dashboards", "Charts", "Reports"].map((label) => ({
      label,
    })),
  },
  {
    label: "Boards",
    icon: FolderKanban,
    future: true,
    items: [
      "Organization",
      "Departments",
      "Calendars",
      "Announcements",
      "Embedded Views",
    ].map((label) => ({ label })),
  },
  {
    label: "OpenComms",
    icon: MessageSquare,
    future: true,
    items: ["Channels", "Direct Messages", "Threads"].map((label) => ({
      label,
    })),
  },
  {
    label: "Sandbox",
    icon: Workflow,
    items: [
      { label: "Organization Designer", href: "/sandbox" },
      { label: "Relationships", href: "/sandbox", note: "In designer" },
      { label: "Automation", href: "/sandbox", note: "In designer" },
      { label: "Simulation" },
      { label: "Preview" },
      { label: "Publish" },
    ],
  },
  {
    label: "Access",
    icon: ShieldCheck,
    items: [
      { label: "Users", href: "/administration/users" },
      { label: "Roles", href: "/administration/roles" },
      { label: "Permissions", href: "/administration/roles", note: "In roles" },
      { label: "Membership" },
    ],
  },
  {
    label: "Manage",
    icon: Settings,
    items: [
      { label: "Documents", href: "/administration/files" as Route },
      { label: "Workspace settings", href: "/settings/workspace" as Route },
      { label: "Organization", href: "/departments" },
      { label: "Security" },
      { label: "Audit", href: "/administration/audit" },
      { label: "Backup" },
      { label: "Updates" },
      { label: "Licensing" },
    ],
  },
];

interface AppNavigationProps {
  pathname: string;
  structure: NavigationStructure;
  onNavigate: () => void;
  collapsed?: boolean;
}

export function AppNavigation({
  pathname,
  structure,
  onNavigate,
  collapsed = false,
}: AppNavigationProps) {
  const { user } = useWorkspace();
  const visibleGroups = groups
    .filter((group) => group.label !== "Access" || user.role === "admin")
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) => !item.href || canNavigate(user, item.href),
      ),
    }));
  const { setOpen } = useSidebar();
  const [openGroups, setOpenGroups] = useState<Set<string>>(
    () =>
      new Set(
        groups
          .filter(({ items }) =>
            items.some(({ href }) => href && isCurrentPath(pathname, href)),
          )
          .map(({ label }) => label),
      ),
  );

  const isCurrent = (href: string) => isCurrentPath(pathname, href);
  const itemClass = (active: boolean) =>
    cn(
      "group flex min-h-9 w-full items-center rounded-md text-left text-sm whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2",
      "gap-2.5 px-3",
      active
        ? "bg-sidebar-accent text-sidebar-foreground"
        : "text-sidebar-muted hover:bg-sidebar-accent/70 hover:text-sidebar-foreground",
    );

  useEffect(() => {
    if (collapsed) return;
    setOpenGroups((current) => {
      const next = new Set(current);
      for (const group of groups) {
        if (group.items.some(({ href }) => href && isCurrent(href))) {
          next.add(group.label);
        }
      }
      return next;
    });
  }, [collapsed, pathname]);

  const toggleGroup = (label: string) => {
    setOpenGroups((current) => {
      const next = new Set(current);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  const renderItem = (item: NavigationItem, group: NavigationGroup | null) => {
    const { label, href, note } = item;
    const active = Boolean(href && !note && isCurrent(href));
    const unavailableLabel = group?.future ? "Future feature" : "Planned";

    if (href) {
      return (
        <SidebarMenuSubButton
          render={<Link href={href} onNavigate={onNavigate} />}
          isActive={active}
          aria-current={active ? "page" : undefined}
          className="min-h-9"
        >
          <span className="min-w-0 truncate">{label}</span>
          {note ? (
            <span className="text-sidebar-muted ml-auto text-[10px]">
              {note}
            </span>
          ) : null}
        </SidebarMenuSubButton>
      );
    }

    return (
      <button
        key={label}
        type="button"
        disabled
        aria-label={`${label} ${unavailableLabel}`}
        title={`${label} — ${unavailableLabel}`}
        className={cn(
          itemClass(false),
          "text-sidebar-muted cursor-not-allowed opacity-70",
        )}
      >
        <span className={"truncate"}>{label}</span>
        <span className="text-sidebar-muted ml-auto text-[10px]">
          {unavailableLabel}
        </span>
      </button>
    );
  };

  const renderGroupItems = (group: NavigationGroup) => (
    <SidebarMenuSub>
      {group.items.map((item) => (
        <SidebarMenuSubItem key={item.label}>
          {renderItem(item, group)}
        </SidebarMenuSubItem>
      ))}
    </SidebarMenuSub>
  );

  return (
    <SidebarGroup className="p-0">
      <nav aria-label="Main navigation">
        <SidebarMenu>
          {structure === "classic"
            ? classicLinks
                .filter(({ href }) => canNavigate(user, href))
                .map(({ href, label, icon: Icon }) => (
                  <SidebarMenuItem key={label}>
                    <SidebarMenuButton
                      render={<Link href={href} onNavigate={onNavigate} />}
                      isActive={isCurrent(href)}
                      aria-current={isCurrent(href) ? "page" : undefined}
                      aria-label={collapsed ? label : undefined}
                      title={collapsed ? label : undefined}
                    >
                      <Icon aria-hidden="true" />
                      <span>{label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))
            : visibleGroups.map((group) => {
                const { label, icon: Icon, future } = group;
                const active = group.items.some(
                  ({ href, note }) => href && !note && isCurrent(href),
                );

                return (
                  <SidebarMenuItem key={label}>
                    <SidebarMenuButton
                      isActive={active}
                      type="button"
                      aria-label={collapsed ? label : undefined}
                      title={collapsed ? label : undefined}
                      aria-expanded={!collapsed && openGroups.has(label)}
                      onClick={() => {
                        if (collapsed) {
                          setOpenGroups((current) =>
                            new Set(current).add(label),
                          );
                          setOpen(true);
                        } else {
                          toggleGroup(label);
                        }
                      }}
                    >
                      <Icon className="size-4 shrink-0" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{label}</span>
                      {future ? (
                        <span className="text-sidebar-muted text-[10px] font-normal group-data-[collapsible=icon]:hidden">
                          Future
                        </span>
                      ) : null}
                      <ChevronDown
                        aria-hidden="true"
                        className={cn(
                          "text-sidebar-muted shrink-0 transition-transform group-data-[collapsible=icon]:hidden",
                          openGroups.has(label) && "rotate-180",
                        )}
                      />
                    </SidebarMenuButton>
                    {openGroups.has(label) ? renderGroupItems(group) : null}
                  </SidebarMenuItem>
                );
              })}
        </SidebarMenu>
      </nav>
    </SidebarGroup>
  );
}

function isCurrentPath(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}
