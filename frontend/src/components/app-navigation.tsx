"use client";

import Link from "next/link";
import type { Route } from "next";
import {
  BarChart3,
  FolderKanban,
  MessageSquare,
  Settings,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from "@/components/ui/sidebar";

const pillars = [
  { label: "Sandbox", href: "/sandbox", icon: Workflow },
  { label: "Boards", href: "/boards", icon: FolderKanban },
  { label: "OpenComms", href: "/comms", icon: MessageSquare },
  { label: "Access", href: "/access", icon: ShieldCheck },
  { label: "OpenView", href: "/openview", icon: BarChart3 },
  { label: "Manage", href: "/manage", icon: Settings },
] as const;

interface AppNavigationProps {
  pathname: string;
  onNavigate: () => void;
  collapsed?: boolean;
}

export function AppNavigation({
  pathname,
  onNavigate,
  collapsed = false,
}: AppNavigationProps) {
  return (
    <SidebarGroup className="p-0">
      <nav aria-label="Main navigation">
        <SidebarMenu className="gap-1.5">
          {pillars.map(({ label, href, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <SidebarMenuItem key={href}>
                <SidebarMenuButton
                  render={<Link href={href as Route} onNavigate={onNavigate} />}
                  isActive={active}
                  aria-current={active ? "page" : undefined}
                  aria-label={label}
                  title={collapsed ? label : undefined}
                  className="min-h-11"
                >
                  <Icon aria-hidden="true" />
                  <span>{label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </nav>
    </SidebarGroup>
  );
}
