"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { Route } from "next";
import {
  ChevronDown,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  UserCircle,
  X,
} from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import {
  AppNavigation,
  type NavigationStructure,
} from "@/components/app-navigation";
import { useRealtime } from "@/components/realtime-provider";
import {
  AppBreadcrumbs,
  BreadcrumbLabelsProvider,
} from "@/components/app-breadcrumbs";
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

const NAVIGATION_STRUCTURE_KEY = "openslate-navigation-structure";
const SIDEBAR_COLLAPSED_KEY = "openslate-sidebar-collapsed";
const SIDEBAR_WIDTH_KEY = "openslate-sidebar-width";
const SIDEBAR_MIN_WIDTH = 256;
const SIDEBAR_MAX_WIDTH = 400;

function clampSidebarWidth(width: number) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}

export interface AppShellNavigationContextValue {
  structure: NavigationStructure;
  setStructure: (structure: NavigationStructure) => void;
  openNavigation: () => void;
  closeNavigation: () => void;
  mobileNavigationOpen: boolean;
}

const AppShellNavigationContext = createContext<AppShellNavigationContextValue>(
  {
    structure: "structured",
    setStructure: () => undefined,
    openNavigation: () => undefined,
    closeNavigation: () => undefined,
    mobileNavigationOpen: false,
  },
);

/** Access the shared mobile navigation drawer from Sandbox or other full-screen views. */
export function useAppShellNavigation() {
  return useContext(AppShellNavigationContext);
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { invalidate } = useRealtime();
  const isSandboxPage = pathname === "/sandbox";
  const [structure, setStructure] = useState<NavigationStructure>("structured");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_MIN_WIDTH);
  const [resizing, setResizing] = useState(false);
  const resizeStart = useRef<{
    pointerId: number;
    x: number;
    width: number;
  } | null>(null);
  const [sandboxRailExpanded, setSandboxRailExpanded] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const mobileTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileCloseRef = useRef<HTMLButtonElement>(null);
  const navigationReturnFocus = useRef<HTMLElement | null>(null);

  const effectiveCollapsed = isSandboxPage
    ? !sandboxRailExpanded
    : sidebarCollapsed;

  useEffect(() => {
    try {
      const storedStructure = window.localStorage.getItem(
        NAVIGATION_STRUCTURE_KEY,
      );
      if (storedStructure === "classic" || storedStructure === "structured") {
        setStructure(storedStructure);
      }
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
      window.localStorage.setItem(NAVIGATION_STRUCTURE_KEY, structure);
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
      window.localStorage.setItem(
        SIDEBAR_COLLAPSED_KEY,
        String(sidebarCollapsed),
      );
    } catch {
      // Preference storage is best effort; navigation remains usable when it is unavailable.
    }
  }, [preferencesReady, sidebarCollapsed, sidebarWidth, structure]);

  useEffect(() => {
    if (isSandboxPage) setSandboxRailExpanded(false);
  }, [isSandboxPage]);

  useEffect(() => {
    setMobileOpen(false);
    setAccountOpen(false);
  }, [pathname]);

  function navigate(href: string) {
    setMobileOpen(false);
    setAccountOpen(false);
    router.push(href as Route);
  }

  function openMobileNavigation() {
    navigationReturnFocus.current = document.activeElement as HTMLElement;
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
    if (isSandboxPage) {
      setSandboxRailExpanded(open);
    } else {
      setSidebarCollapsed(!open);
    }
  }

  async function logout() {
    try {
      await fetch("/session/logout", {
        method: "POST",
        credentials: "same-origin",
      });
    } finally {
      invalidate();
      router.replace("/login");
    }
  }

  const navigationContext: AppShellNavigationContextValue = {
    structure,
    setStructure,
    openNavigation: openMobileNavigation,
    closeNavigation: closeMobileNavigation,
    mobileNavigationOpen: mobileOpen,
  };

  const sidebarStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
    "--sidebar-width-icon": "64px",
  } as CSSProperties;

  return (
    <BreadcrumbLabelsProvider>
      <AppShellNavigationContext.Provider value={navigationContext}>
        <SidebarProvider
          open={!effectiveCollapsed}
          onOpenChange={setSidebarOpen}
          className={cn(
            "app-shell bg-background text-foreground",
            isSandboxPage ? "h-dvh overflow-hidden" : "min-h-screen",
          )}
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
            <AppSidebarHeader
              collapsed={effectiveCollapsed}
              isSandboxPage={isSandboxPage}
            />
            <SidebarContent className="px-4 py-4">
              <AppNavigation
                pathname={pathname}
                structure={structure}
                onNavigate={closeMobileNavigation}
                collapsed={effectiveCollapsed}
              />
            </SidebarContent>
            <AppSidebarFooter
              collapsed={effectiveCollapsed}
              showToggle
              accountOpen={accountOpen && !mobileOpen}
              onAccountOpenChange={setAccountOpen}
              onNavigate={navigate}
              onLogout={logout}
            />
            {!effectiveCollapsed ? (
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
              finalFocus={() =>
                navigationReturnFocus.current ?? mobileTriggerRef.current
              }
              className="flex h-full w-72 max-w-[calc(100vw-2rem)] flex-col p-0"
            >
              <SheetTitle className="sr-only">OpenSlate navigation</SheetTitle>
              <div className="flex h-14 shrink-0 items-center justify-between border-b px-4">
                <Link
                  href="/workspace"
                  onNavigate={closeMobileNavigation}
                  className="flex min-w-0 items-center gap-2.5 font-semibold"
                >
                  <span className="bg-foreground text-background grid size-8 shrink-0 place-items-center rounded-md text-[10px] font-bold">
                    OS
                  </span>
                  <span>OpenSlate</span>
                </Link>
                <button
                  ref={mobileCloseRef}
                  type="button"
                  aria-label="Close navigation"
                  onClick={closeMobileNavigation}
                  className="text-sidebar-muted hover:bg-sidebar-accent hover:text-sidebar-foreground grid size-9 place-items-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                <AppNavigation
                  pathname={pathname}
                  structure={structure}
                  onNavigate={closeMobileNavigation}
                />
              </div>
              <AppSidebarFooter
                collapsed={false}
                accountOpen={accountOpen}
                onAccountOpenChange={setAccountOpen}
                onNavigate={navigate}
                onLogout={logout}
              />
            </SheetContent>
          </Sheet>

          <div
            className={cn(
              "min-w-0 flex-1",
              isSandboxPage ? "h-full" : "min-h-screen",
            )}
          >
            {!isSandboxPage ? (
              <header className="border-border bg-background/95 sticky top-0 z-20 flex h-12 items-center border-b px-4 backdrop-blur sm:px-8">
                <div className="flex min-w-0 items-center gap-2.5">
                  <Button
                    ref={mobileTriggerRef}
                    variant="ghost"
                    size="icon"
                    className="lg:hidden"
                    aria-label="Open navigation"
                    aria-expanded={mobileOpen}
                    aria-controls="mobile-navigation"
                    onClick={openMobileNavigation}
                  >
                    <Menu aria-hidden="true" />
                  </Button>
                  <AppBreadcrumbs />
                </div>
              </header>
            ) : null}
            <main
              id="main-content"
              className={cn(
                isSandboxPage
                  ? "h-full min-h-0 overflow-hidden"
                  : "mx-auto min-h-[calc(100vh-3rem)] max-w-[1600px] p-4 sm:p-8",
              )}
            >
              {children}
            </main>
          </div>
        </SidebarProvider>
        <Toaster />
      </AppShellNavigationContext.Provider>
    </BreadcrumbLabelsProvider>
  );
}

function AppSidebarHeader({
  collapsed,
  isSandboxPage,
}: {
  collapsed: boolean;
  isSandboxPage: boolean;
}) {
  return (
    <SidebarHeader className="h-14 shrink-0 flex-row items-center gap-3 border-b px-4">
      <Link
        href="/workspace"
        aria-label="OpenSlate workspace"
        className={cn(
          "flex min-w-0 items-center gap-2.5 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2",
        )}
      >
        <span className="bg-foreground text-background grid size-8 shrink-0 place-items-center rounded-md text-[10px] font-bold">
          OS
        </span>
        {!collapsed ? (
          <span className="truncate text-sm font-semibold">OpenSlate</span>
        ) : null}
      </Link>
      {isSandboxPage && !collapsed ? (
        <span className="sr-only">Sandbox sidebar</span>
      ) : null}
    </SidebarHeader>
  );
}

function AppSidebarFooter({
  collapsed,
  showToggle = false,
  accountOpen,
  onAccountOpenChange,
  onNavigate,
  onLogout,
}: {
  collapsed: boolean;
  showToggle?: boolean;
  accountOpen: boolean;
  onAccountOpenChange: (open: boolean) => void;
  onNavigate: (href: string) => void;
  onLogout: () => void;
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
        <SidebarMenuItem>
          <DropdownMenu open={accountOpen} onOpenChange={onAccountOpenChange}>
            <DropdownMenuTrigger
              render={
                <SidebarMenuButton
                  type="button"
                  aria-label={collapsed ? "Account" : undefined}
                  title={collapsed ? "Account" : undefined}
                  aria-expanded={accountOpen}
                >
                  <UserCircle className="size-4 shrink-0" aria-hidden="true" />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-left",
                      collapsed && "sr-only",
                    )}
                  >
                    Account
                  </span>
                  <ChevronDown
                    className={cn(
                      "text-sidebar-muted size-3.5 shrink-0 transition-transform",
                      accountOpen && "rotate-180",
                      collapsed && "sr-only",
                    )}
                    aria-hidden="true"
                  />
                </SidebarMenuButton>
              }
            />
            <DropdownMenuContent
              side={collapsed ? "right" : "top"}
              align="start"
              aria-label="Account actions"
            >
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={onLogout}>
                  <LogOut aria-hidden="true" /> Sign out
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
}
