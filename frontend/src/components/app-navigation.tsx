"use client";

import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import {
  BarChart3,
  ChevronRight,
  FolderKanban,
  Layers3,
  Settings,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import {
  getWorkspaceNavigation,
  isWorkspaceNavigationGroupActive,
  isWorkspaceNavigationItemActive,
} from "@/components/workspace-navigation";
import { useWorkspaceNavigationRequest } from "@/components/workspace-navigation-guard";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

const groupIcons = {
  sandbox: Workflow,
  boards: FolderKanban,
  access: ShieldCheck,
  openview: BarChart3,
  manage: Settings,
  platform: Layers3,
} as const;

const PREFETCH_INTENT_DELAY_MS = 120;
const MAX_PREFETCHED_ROUTES = 12;

interface AppNavigationProps {
  pathname: string;
  searchParams: URLSearchParams;
  collapsed?: boolean;
  onExpandSidebar?: () => void;
}

export function AppNavigation({
  pathname,
  searchParams,
  collapsed = false,
  onExpandSidebar,
}: AppNavigationProps) {
  const router = useRouter();
  const requestNavigation = useWorkspaceNavigationRequest();
  const descriptionIdPrefix = useId();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [hash, setHash] = useState("");
  const prefetchTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const prefetchedRoutes = useRef(new Set<string>());
  const groups = getWorkspaceNavigation(pathname, searchParams);
  const search = searchParams.toString();
  const activeGroupId = groups.find((group) =>
    isWorkspaceNavigationGroupActive(group, pathname),
  )?.id;

  useEffect(() => {
    const syncHash = () => setHash(window.location.hash);
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, [pathname]);

  useEffect(() => {
    if (!activeGroupId) return;
    setExpanded((current) =>
      current[activeGroupId] ? current : { ...current, [activeGroupId]: true },
    );
  }, [activeGroupId, search]);

  useEffect(() => {
    const timers = prefetchTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  function schedulePrefetch(href: string) {
    if (prefetchedRoutes.current.has(href) || prefetchTimers.current.has(href))
      return;
    const timer = setTimeout(() => {
      prefetchTimers.current.delete(href);
      if (prefetchedRoutes.current.has(href)) return;
      prefetchedRoutes.current.add(href);
      if (prefetchedRoutes.current.size > MAX_PREFETCHED_ROUTES) {
        const oldest = prefetchedRoutes.current.values().next().value;
        if (oldest) prefetchedRoutes.current.delete(oldest);
      }
      router.prefetch(href as Route);
    }, PREFETCH_INTENT_DELAY_MS);
    prefetchTimers.current.set(href, timer);
  }

  function cancelPrefetch(href: string) {
    const timer = prefetchTimers.current.get(href);
    if (timer === undefined) return;
    clearTimeout(timer);
    prefetchTimers.current.delete(href);
  }

  function navigate(href: string, event: { preventDefault: () => void }) {
    const accepted = requestNavigation(href, () => router.push(href as Route));
    if (!accepted) event.preventDefault();
  }

  return (
    <SidebarGroup className="p-0">
      <nav aria-label="Main navigation">
        <SidebarMenu className="gap-1.5">
          {groups.map((group) => {
            const Icon = groupIcons[group.id as keyof typeof groupIcons];
            const active = isWorkspaceNavigationGroupActive(group, pathname);
            const open = !collapsed && (expanded[group.id] ?? active);
            const showDescription = Boolean(
              group.description && !collapsed && !open,
            );
            const descriptionId = `${descriptionIdPrefix}-${group.id}-description`;

            return (
              <Collapsible
                key={group.id}
                render={<SidebarMenuItem />}
                open={open}
                onOpenChange={(nextOpen) =>
                  setExpanded((current) => ({
                    ...current,
                    [group.id]: nextOpen,
                  }))
                }
              >
                <CollapsibleTrigger
                  render={
                    <SidebarMenuButton
                      isActive={active}
                      aria-label={group.label}
                      aria-describedby={
                        showDescription ? descriptionId : undefined
                      }
                      title={
                        collapsed
                          ? group.description
                            ? `${group.label} — ${group.description}`
                            : group.label
                          : undefined
                      }
                      className={cn(
                        "min-h-11",
                        showDescription && "h-auto py-1.5",
                      )}
                    />
                  }
                  onClick={() => {
                    if (collapsed) onExpandSidebar?.();
                  }}
                >
                  <Icon aria-hidden="true" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{group.label}</span>
                    {showDescription ? (
                      <span
                        id={descriptionId}
                        className="text-sidebar-muted truncate text-xs font-normal"
                      >
                        {group.description}
                      </span>
                    ) : null}
                  </span>
                  <ChevronRight
                    aria-hidden="true"
                    className={cn(
                      "ml-auto size-4 transition-transform motion-reduce:transition-none",
                      open && "rotate-90",
                    )}
                  />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <SidebarMenuSub>
                    {group.items.map((item) => {
                      const itemActive = isWorkspaceNavigationItemActive(
                        group.id,
                        item.id,
                        pathname,
                        searchParams,
                        hash,
                      );
                      return (
                        <SidebarMenuSubItem key={item.id}>
                          <SidebarMenuSubButton
                            render={
                              <Link
                                href={item.href as Route}
                                prefetch={false}
                                onNavigate={(event) =>
                                  navigate(item.href, event)
                                }
                                onPointerEnter={() =>
                                  schedulePrefetch(item.href)
                                }
                                onPointerLeave={() => cancelPrefetch(item.href)}
                                onFocus={() => schedulePrefetch(item.href)}
                                onBlur={() => cancelPrefetch(item.href)}
                              />
                            }
                            isActive={itemActive}
                            aria-current={itemActive ? "page" : undefined}
                            className="min-h-11"
                          >
                            <span>{item.label}</span>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      );
                    })}
                  </SidebarMenuSub>
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </SidebarMenu>
      </nav>
    </SidebarGroup>
  );
}
