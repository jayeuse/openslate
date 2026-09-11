"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { Route } from "next";
import {
  Bell,
  Search,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  UserCircle,
  X,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { AppNavigation } from "@/components/app-navigation";
import { AppBreadcrumbs } from "@/components/app-breadcrumbs";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Toaster } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

const SIDEBAR_COLLAPSED_KEY = "openslate-sidebar-collapsed";
const SIDEBAR_WIDTH_KEY = "openslate-sidebar-width";
const SIDEBAR_MIN_WIDTH = 256;
const SIDEBAR_MAX_WIDTH = 400;

function clampSidebarWidth(width: number) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isComms = pathname === "/comms";
  const [savedSidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [commsSidebarCollapsed, setCommsSidebarCollapsed] = useState(true);
  const sidebarCollapsed = isComms
    ? commsSidebarCollapsed
    : savedSidebarCollapsed;
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_MIN_WIDTH);
  const [resizing, setResizing] = useState(false);
  const resizeStart = useRef<{
    pointerId: number;
    x: number;
    width: number;
  } | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const mobileCloseRef = useRef<HTMLButtonElement>(null);
  const navigationReturnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    try {
      const storedWidth = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
      if (storedWidth !== null && Number.isFinite(Number(storedWidth))) {
        setSidebarWidth(clampSidebarWidth(Number(storedWidth)));
      }
      setSidebarCollapsed(
        window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true",
      );
    } catch {
      // Keep defaults when browser storage is unavailable.
    } finally {
      setPreferencesReady(true);
    }
  }, []);

  useEffect(() => {
    if (!preferencesReady) return;
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
      window.localStorage.setItem(
        SIDEBAR_COLLAPSED_KEY,
        String(savedSidebarCollapsed),
      );
    } catch {
      // Preference storage is best effort; navigation remains usable when it is unavailable.
    }
  }, [preferencesReady, savedSidebarCollapsed, sidebarWidth]);

  useEffect(() => {
    setMobileOpen(false);
    setAccountOpen(false);
  }, [pathname]);

  function navigate(href: string) {
    setMobileOpen(false);
    setAccountOpen(false);
    router.push(href as Route);
  }

  function openMobileNavigation(opener: HTMLElement) {
    navigationReturnFocus.current = opener;
    setAccountOpen(false);
    setMobileOpen(true);
  }

  function closeMobileNavigation() {
    setMobileOpen(false);
    setAccountOpen(false);
  }

  function setSidebarOpen(open: boolean) {
    resizeStart.current = null;
    setResizing(false);
    if (isComms) setCommsSidebarCollapsed(!open);
    else setSidebarCollapsed(!open);
  }

  async function logout() {
    try {
      await fetch("/session/logout", {
        method: "POST",
        credentials: "same-origin",
      });
    } finally {
      router.replace("/login");
    }
  }

  const sidebarStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
    "--sidebar-width-icon": "64px",
  } as CSSProperties;

  return (
    <>
      <SidebarProvider
        open={!sidebarCollapsed}
        onOpenChange={setSidebarOpen}
        className="app-shell bg-background text-foreground min-h-screen"
        style={sidebarStyle}
        data-sidebar-resizing={resizing || undefined}
      >
        <a
          href="#main-content"
          className="focus:bg-primary focus:text-primary-foreground sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[70] focus:rounded-md focus:px-4 focus:py-2"
        >
          Skip to content
        </a>

        <Sidebar
          collapsible="icon"
          role="complementary"
          id="primary-sidebar"
          aria-label="Primary sidebar"
          className="z-30"
        >
          <AppSidebarHeader collapsed={sidebarCollapsed} />
          <SidebarContent className="px-3 py-5">
            <AppNavigation
              pathname={pathname}
              onNavigate={closeMobileNavigation}
              collapsed={sidebarCollapsed}
            />
          </SidebarContent>
          <AppSidebarFooter
            collapsed={sidebarCollapsed}
            showToggle
            onNavigate={navigate}
          />
          {!sidebarCollapsed ? (
            <div
              role="separator"
              aria-label="Resize sidebar"
              aria-orientation="vertical"
              aria-controls="primary-sidebar"
              aria-valuemin={SIDEBAR_MIN_WIDTH}
              aria-valuemax={SIDEBAR_MAX_WIDTH}
              aria-valuenow={sidebarWidth}
              aria-valuetext={`${sidebarWidth} pixels`}
              tabIndex={0}
              title="Drag to resize. Double-click to reset."
              className="hover:bg-primary/20 focus-visible:bg-primary/20 focus-visible:outline-ring absolute inset-y-0 -right-1 z-40 w-2 cursor-col-resize touch-none focus-visible:outline-2"
              onPointerDown={(event) => {
                if (!event.isPrimary || event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.focus();
                event.currentTarget.setPointerCapture(event.pointerId);
                resizeStart.current = {
                  pointerId: event.pointerId,
                  x: event.clientX,
                  width: sidebarWidth,
                };
                setResizing(true);
              }}
              onPointerMove={(event) => {
                const start = resizeStart.current;
                if (!start || start.pointerId !== event.pointerId) return;
                setSidebarWidth(
                  clampSidebarWidth(
                    Math.round(start.width + event.clientX - start.x),
                  ),
                );
              }}
              onPointerUp={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
                resizeStart.current = null;
                setResizing(false);
              }}
              onPointerCancel={() => {
                resizeStart.current = null;
                setResizing(false);
              }}
              onLostPointerCapture={() => {
                resizeStart.current = null;
                setResizing(false);
              }}
              onDoubleClick={() => setSidebarWidth(SIDEBAR_MIN_WIDTH)}
              onKeyDown={(event) => {
                if (
                  !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                setSidebarWidth((current) =>
                  event.key === "Home"
                    ? SIDEBAR_MIN_WIDTH
                    : event.key === "End"
                      ? SIDEBAR_MAX_WIDTH
                      : clampSidebarWidth(
                          current + (event.key === "ArrowRight" ? 16 : -16),
                        ),
                );
              }}
            />
          ) : null}
        </Sidebar>

        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent
            side="left"
            id="mobile-navigation"
            initialFocus={mobileCloseRef}
            finalFocus={() => navigationReturnFocus.current}
            className="flex h-full w-72 max-w-[calc(100vw-2rem)] flex-col p-0"
          >
            <SheetTitle className="sr-only">OpenSlate navigation</SheetTitle>
            <div className="flex h-14 shrink-0 items-center justify-between border-b px-4">
              <Link
                href={"/openview" as Route}
                onNavigate={closeMobileNavigation}
                className="flex min-w-0 items-center gap-2.5 font-semibold"
              >
                <WorkspaceMark />
                <span>OpenSlate</span>
              </Link>
              <button
                ref={mobileCloseRef}
                type="button"
                aria-label="Close navigation"
                onClick={closeMobileNavigation}
                className="text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground grid size-11 place-items-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
            <div className="px-4 pt-3">
              <WorkspaceLabel />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              <AppNavigation
                pathname={pathname}
                onNavigate={closeMobileNavigation}
              />
            </div>
            <AppSidebarFooter collapsed={false} onNavigate={navigate} />
          </SheetContent>
        </Sheet>

        <div className="min-h-screen min-w-0 flex-1">
          <header className="border-border bg-background sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b px-4 sm:px-5">
            <div className="flex min-w-0 items-center gap-2.5">
              <Button
                variant="ghost"
                size="icon"
                className="size-11 lg:hidden"
                aria-label="Open navigation"
                aria-expanded={mobileOpen}
                aria-controls="mobile-navigation"
                onClick={(event) => openMobileNavigation(event.currentTarget)}
              >
                <Menu aria-hidden="true" />
              </Button>
              <AppBreadcrumbs />
            </div>
            <div className="flex shrink-0 items-center gap-1 sm:gap-3">
              <Link
                href={"/platform" as Route}
                aria-label="Search workspace"
                title="Search workspace"
                className="text-muted-foreground hover:bg-muted flex min-h-11 items-center gap-2 rounded-md px-3 text-sm sm:min-w-52 sm:border"
              >
                <Search className="size-4" aria-hidden="true" />
                <span className="hidden sm:inline">Search workspace…</span>
              </Link>
              <Link
                href={"/platform#notifications" as Route}
                aria-label="Notifications"
                title="Notifications"
                className="hover:bg-muted grid size-11 place-items-center rounded-md"
              >
                <Bell className="size-4" aria-hidden="true" />
              </Link>
              <DropdownMenu open={accountOpen} onOpenChange={setAccountOpen}>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-11"
                      aria-label="Account"
                    />
                  }
                >
                  <UserCircle className="size-5" aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" aria-label="Account">
                  <DropdownMenuGroup>
                    <DropdownMenuItem
                      render={
                        <Link
                          href={"/platform#account" as Route}
                          onNavigate={() => setAccountOpen(false)}
                        />
                      }
                    >
                      <UserCircle aria-hidden="true" />
                      Account settings
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={logout}>
                      <LogOut aria-hidden="true" />
                      Sign out
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>
          <main
            id="main-content"
            className={cn(
              isComms
                ? "flex h-[calc(100dvh-3.5rem)] min-h-0 flex-col overflow-hidden"
                : "min-h-[calc(100vh-3.5rem)] p-4 sm:px-5 sm:py-7",
            )}
          >
            {children}
          </main>
        </div>
      </SidebarProvider>
      <Toaster />
    </>
  );
}

function AppSidebarHeader({ collapsed }: { collapsed: boolean }) {
  return (
    <SidebarHeader className="shrink-0 gap-4 px-4 pt-4 pb-2">
      <Link
        href={"/openview" as Route}
        aria-label="OpenSlate workspace"
        className={cn(
          "flex min-w-0 items-center gap-2.5 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2",
        )}
      >
        <WorkspaceMark />
        {!collapsed ? (
          <span className="truncate text-lg font-semibold tracking-tight">
            OpenSlate
          </span>
        ) : null}
      </Link>
      {!collapsed ? <WorkspaceLabel /> : null}
    </SidebarHeader>
  );
}

function AppSidebarFooter({
  collapsed,
  showToggle = false,
  onNavigate,
}: {
  collapsed: boolean;
  showToggle?: boolean;
  onNavigate: (href: string) => void;
}) {
  return (
    <SidebarFooter className="border-sidebar-accent/60 relative shrink-0 border-t px-4 py-3">
      <SidebarMenu>
        {showToggle ? (
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<SidebarTrigger />}
              type="button"
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!collapsed}
              aria-controls="primary-sidebar"
            >
              {collapsed ? (
                <PanelLeftOpen className="size-4 shrink-0" aria-hidden="true" />
              ) : (
                <PanelLeftClose
                  className="size-4 shrink-0"
                  aria-hidden="true"
                />
              )}
              <span className={cn("truncate", collapsed && "sr-only")}>
                Collapse sidebar
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : null}
        <SidebarMenuItem>
          <SidebarMenuButton
            type="button"
            aria-label={collapsed ? "Appearance" : undefined}
            title={collapsed ? "Appearance" : undefined}
            onClick={() => onNavigate("/settings/appearance")}
          >
            <Settings className="size-4 shrink-0" aria-hidden="true" />
            <span className={cn("truncate", collapsed && "sr-only")}>
              Appearance
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
}

function WorkspaceMark() {
  return (
    <span
      className="bg-foreground text-background grid size-8 shrink-0 place-items-center rounded-md text-[10px] font-bold"
      aria-hidden="true"
    >
      OS
    </span>
  );
}

function WorkspaceLabel() {
  return (
    <div className="text-sidebar-muted flex min-h-11 items-center gap-2 px-2 text-xs">
      <span
        className="bg-sidebar-accent text-sidebar-foreground grid size-6 shrink-0 place-items-center rounded font-semibold"
        aria-hidden="true"
      >
        W
      </span>
      <span>Workspace</span>
    </div>
  );
}
