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
import {
  addTransitionType,
  startTransition,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import {
  currentNavigationKey,
  getWorkspaceNavigation,
  isWorkspaceNavigationGroupActive,
  isWorkspaceNavigationItemActive,
  navigationOrder,
  navigationTransitionType,
  type NavigationTransitionType,
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
  // Sidebar order, and the current place in it, give each move a direction.
  const order = navigationOrder();
  const currentKey = currentNavigationKey(pathname, searchParams, hash);
  const navRef = useRef<HTMLElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);

  // The active item's fill is one element under the list that glides to the
  // active link. It lives in the page (not in a view transition layer), so
  // it stays under the labels and inside the sidebar's scroll clipping, and
  // it follows groups as they open and close.
  useEffect(() => {
    const nav = navRef.current;
    const indicator = indicatorRef.current;
    if (!nav || !indicator) return;
    const place = () => {
      const active = nav.querySelector<HTMLElement>(
        '[data-slot="sidebar-menu-sub-button"][aria-current="page"]',
      );
      if (!active || collapsed) {
        indicator.style.opacity = "0";
        return;
      }
      const navBox = nav.getBoundingClientRect();
      const box = active.getBoundingClientRect();
      indicator.style.opacity = "1";
      indicator.style.transform = `translate(${box.left - navBox.left}px, ${box.top - navBox.top}px)`;
      indicator.style.width = `${box.width}px`;
      indicator.style.height = `${box.height}px`;
    };
    place();
    // Glide only after the first placement, so it never flies in on load.
    const frame = requestAnimationFrame(() => {
      indicator.dataset.ready = "true";
    });
    const observer = new ResizeObserver(place);
    observer.observe(nav);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [currentKey, collapsed]);

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

  function navigate(
    href: string,
    type: NavigationTransitionType | null,
    event: { preventDefault: () => void },
  ) {
    // A navigation that waits for a confirmation resumes here; it keeps its
    // direction like a direct one.
    const accepted = requestNavigation(href, () =>
      startTransition(() => {
        if (type) addTransitionType(type);
        router.push(href as Route);
      }),
    );
    if (!accepted) event.preventDefault();
  }

  return (
    <SidebarGroup className="p-0">
      <nav
        ref={navRef}
        aria-label="Main navigation"
        className="relative isolate"
      >
        <span
          ref={indicatorRef}
          aria-hidden="true"
          data-slot="sidebar-active-indicator"
          className="bg-sidebar-accent pointer-events-none absolute top-0 left-0 -z-10 rounded-md opacity-0 data-ready:transition-[transform,width,height,opacity] data-ready:duration-(--motion-base) data-ready:ease-(--ease-out) motion-reduce:transition-none"
        />
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
                      "ml-auto size-4 transition-transform duration-(--motion-base) ease-(--ease-out) motion-reduce:transition-none",
                      open && "rotate-90",
                    )}
                  />
                </CollapsibleTrigger>
                <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-(--motion-base) ease-(--ease-out) data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none">
                  <SidebarMenuSub>
                    {group.items.map((item) => {
                      const itemActive = isWorkspaceNavigationItemActive(
                        group.id,
                        item.id,
                        pathname,
                        searchParams,
                        hash,
                      );
                      const type = navigationTransitionType(
                        order,
                        currentKey,
                        `${group.id}:${item.id}`,
                      );
                      return (
                        <SidebarMenuSubItem key={item.id}>
                          <SidebarMenuSubButton
                            render={
                              <Link
                                href={item.href as Route}
                                prefetch={false}
                                transitionTypes={type ? [type] : undefined}
                                onNavigate={(event) =>
                                  navigate(item.href, type, event)
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
                            // The active fill is the nav's indicator, so it
                            // can glide from item to item.
                            className="min-h-11 data-active:bg-transparent"
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
