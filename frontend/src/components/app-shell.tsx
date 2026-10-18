"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import type { Route } from "next";
import {
  Search,
  LogOut,
  Menu,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCcw,
  Settings,
  UserCircle,
  X,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { useUserPreferences } from "@/components/theme-provider";
import { useOrganizationTheme } from "@/components/organization-theme-provider";
import { OrganizationMenu } from "@/components/organization-menu";
import { PersonAvatar } from "@/components/person-avatar";
import { authMeOptions } from "@/components/systems/openview/adapters/openview-queries";
import { NotificationBell } from "@/components/systems/platform/components/notification-bell";
import { AppNavigation } from "@/components/app-navigation";
import { AppBreadcrumbs } from "@/components/app-breadcrumbs";
import { HelpPanel } from "@/components/help/help-panel";
import {
  GuardedWorkspaceLink,
  WorkspaceNavigationGuardProvider,
  useWorkspaceNavigationRequest,
} from "@/components/workspace-navigation-guard";
import { releaseAllLocalAttachments } from "@/components/systems/shared/runtime/local-attachments";
import {
  clearVerifiedWorkspaceSessionSnapshot,
  registerWorkspaceSessionClear,
  WorkspaceSignOutProvider,
  useWorkspaceInteractionSuspended,
} from "@/components/systems/shared/runtime/workspace-identity";
import { WorkspaceLogo } from "@/components/systems/shared/runtime/workspace-logo";
import {
  workspaceBrandOptions,
  workspaceLogoOptions,
  subscribeWorkspaceBrand,
  manageKeys,
} from "@/components/systems/manage/adapters/manage-queries";
import { WorkspaceLogoBindingChanged } from "@/components/systems/manage/adapters/workspace-logo-api";
import type { WorkspaceBrand } from "@/components/systems/manage/adapters/workspace-api";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
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
import { signOut, requestSessionRecheck } from "@/lib/auth-api";
import { ApiError } from "@/lib/api";

const SIDEBAR_COLLAPSED_KEY = "openslate-sidebar-collapsed";
const SIDEBAR_WIDTH_KEY = "openslate-sidebar-width";
const SIDEBAR_MIN_WIDTH = 271;
const SIDEBAR_MAX_WIDTH = 400;

function clampSidebarWidth(width: number) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}

export function AppShell({
  children,
  verifiedUserId,
  organizationId,
  onSwitchOrganization,
  onSignOutAccepted,
}: {
  children: ReactNode;
  verifiedUserId: string | null;
  organizationId: string | null;
  onSwitchOrganization: (orgId: string) => Promise<void>;
  onSignOutAccepted: () => void;
}) {
  const { device } = useUserPreferences();
  const [sidebarRemSize, setSidebarRemSize] = useState(16);
  useLayoutEffect(() => {
    setSidebarRemSize(
      parseFloat(getComputedStyle(document.documentElement).fontSize),
    );
  }, [device.textSize]);
  const sidebarScale = sidebarRemSize / 16;
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const isComms = pathname === "/comms";
  const isAccess = pathname === "/access";
  // On desktop (1280px and up) the Sandbox fills the viewport and never
  // scrolls; its panels do. Phones and tablets scroll the page.
  const isSandbox = pathname === "/sandbox";
  const isManage = pathname === "/manage";
  const suspended = useWorkspaceInteractionSuspended();
  const queryClient = useQueryClient();
  const brandQuery = useQuery({
    ...workspaceBrandOptions(),
    // The shell shows the organization's identity on every route, Comms too.
    enabled: !suspended,
  });
  const savedLogoQuery = useQuery({
    ...workspaceLogoOptions(brandQuery.data?.logo_file_id ?? ""),
    enabled:
      !suspended &&
      !brandQuery.isError &&
      Boolean(brandQuery.data?.logo_file_id),
  });
  const brandDenied = [brandQuery.error, savedLogoQuery.error].some(
    (error) =>
      error instanceof ApiError &&
      (error.status === 401 || error.status === 403),
  );
  const brandDenialReported = useRef(false);
  useEffect(() => {
    if (!brandDenied) brandDenialReported.current = false;
    else if (!suspended && !brandDenialReported.current) {
      brandDenialReported.current = true;
      requestSessionRecheck();
    }
  }, [brandDenied, suspended]);
  useLayoutEffect(() => {
    if (!suspended) return;
    void queryClient.cancelQueries({ queryKey: manageKeys.brand() });
    void queryClient.cancelQueries({ queryKey: manageKeys.logos() });
  }, [suspended, queryClient]);
  useEffect(() => {
    if (suspended || brandDenied) return;
    return subscribeWorkspaceBrand(queryClient);
  }, [suspended, brandDenied, queryClient]);
  useEffect(() => {
    if (
      savedLogoQuery.error instanceof WorkspaceLogoBindingChanged &&
      !suspended
    )
      void queryClient.invalidateQueries({ queryKey: manageKeys.brand() });
  }, [savedLogoQuery.error, suspended, queryClient]);
  const brand = suspended || brandDenied ? undefined : brandQuery.data;
  // The signed-in organization's look replaces the public (signed-out) one.
  const { hold: holdTheme, releaseHold: releaseTheme } = useOrganizationTheme();
  const themeOwner = useRef(Symbol("signed-in-organization"));
  const brandTheme = brand?.theme;
  useEffect(() => {
    if (brandTheme) holdTheme(themeOwner.current, brandTheme);
  }, [brandTheme, holdTheme]);
  useEffect(() => {
    const owner = themeOwner.current;
    return () => releaseTheme(owner);
  }, [releaseTheme]);
  const logoBlob =
    suspended || brandDenied || brandQuery.isError || savedLogoQuery.isError
      ? undefined
      : savedLogoQuery.data;
  const retryLogo = () => {
    if (suspended) return;
    if (brandQuery.isError || !brandQuery.data) void brandQuery.refetch();
    else void savedLogoQuery.refetch();
  };
  const logoFailed =
    !suspended && (brandQuery.isError || savedLogoQuery.isError);
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
  const [signOutCleanup, setSignOutCleanup] = useState<
    "active" | "clearing" | "failed"
  >("active");
  const cleanupPending = useRef(false);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const mobileCloseRef = useRef<HTMLButtonElement>(null);
  const navigationReturnFocus = useRef<HTMLElement | null>(null);
  const navigationSearchParams = new URLSearchParams(searchParams.toString());

  useLayoutEffect(() => {
    if (verifiedUserId === null) return;
    toast.resumeWorkspace();
    const unregister = registerWorkspaceSessionClear(
      verifiedUserId,
      toast.clearWorkspace,
    );
    return () => {
      unregister();
      toast.clearWorkspace();
    };
  }, [verifiedUserId]);

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

  async function finishSignOut() {
    if (cleanupPending.current) return;
    cleanupPending.current = true;
    toast.clearWorkspace();
    const cleanup = clearVerifiedWorkspaceSessionSnapshot(verifiedUserId);
    flushSync(() => {
      onSignOutAccepted();
      setSignOutCleanup("clearing");
    });
    releaseAllLocalAttachments();
    try {
      if (!(await cleanup)) {
        setSignOutCleanup("failed");
        return;
      }
      router.replace("/login");
    } catch {
      setSignOutCleanup("failed");
    } finally {
      cleanupPending.current = false;
    }
  }

  async function logout() {
    try {
      await signOut();
    } catch {
      toast.add({
        title: "Could not sign out",
        description: "Your workspace is still active. Try again.",
        type: "error",
      });
      return;
    }
    await finishSignOut();
  }

  const sidebarStyle = {
    "--sidebar-width": `${sidebarWidth / 16}rem`,
    "--sidebar-width-icon": "64px",
  } as CSSProperties;

  if (signOutCleanup !== "active")
    return (
      <main className="bg-background text-foreground grid min-h-screen place-items-center">
        <div className="max-w-md px-6 text-center">
          <h1 data-slot="page-title" className="text-xl font-semibold">
            Signed out
          </h1>
          {signOutCleanup === "failed" ? (
            <>
              <p className="mt-3 text-sm" role="alert">
                We could not clear saved Access drafts or other workspace drafts
                in this tab. Close this tab before another person signs in, or
                clear this site&apos;s session data. You can retry cleanup here.
              </p>
              <Button
                className="mt-5 min-h-11"
                onClick={() => void finishSignOut()}
              >
                Retry clearing drafts
              </Button>
            </>
          ) : (
            <p className="mt-3 text-sm" role="status">
              Clearing saved drafts…
            </p>
          )}
        </div>
      </main>
    );

  return (
    <WorkspaceNavigationGuardProvider
      onAcceptedNavigation={closeMobileNavigation}
    >
      <WorkspaceSignOutProvider complete={finishSignOut}>
        <SidebarProvider
          open={!sidebarCollapsed}
          onOpenChange={setSidebarOpen}
          className={cn(
            "app-shell bg-background text-foreground",
            isAccess
              ? "fixed inset-0 h-screen min-h-0 overflow-hidden"
              : isSandbox
                ? "min-h-screen xl:fixed xl:inset-0 xl:h-screen xl:min-h-0 xl:overflow-hidden"
                : "min-h-screen",
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
              collapsed={sidebarCollapsed}
              organizationId={organizationId}
              onSwitchOrganization={onSwitchOrganization}
              brand={brand}
              blob={logoBlob}
              concealed={suspended || brandDenied}
              failed={logoFailed}
              onRetry={retryLogo}
            />
            <SidebarContent className="app-sidebar-scroll px-3 pt-5">
              <AppNavigation
                pathname={pathname}
                searchParams={navigationSearchParams}
                collapsed={sidebarCollapsed}
                onExpandSidebar={() => setSidebarOpen(true)}
              />
              <div className="bg-sidebar sticky bottom-0 z-10 -mx-3 mt-auto px-3 pt-3 pb-2">
                <AppCommsLink collapsed={sidebarCollapsed} />
              </div>
            </SidebarContent>
            <AppSidebarFooter collapsed={sidebarCollapsed} showToggle />
            {!sidebarCollapsed ? (
              <div
                role="separator"
                aria-label="Resize sidebar"
                aria-orientation="vertical"
                aria-controls="primary-sidebar"
                aria-valuemin={SIDEBAR_MIN_WIDTH * sidebarScale}
                aria-valuemax={SIDEBAR_MAX_WIDTH * sidebarScale}
                aria-valuenow={sidebarWidth * sidebarScale}
                aria-valuetext={`${Math.round(sidebarWidth * sidebarScale)} pixels`}
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
                      Math.round(
                        start.width + (event.clientX - start.x) / sidebarScale,
                      ),
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
              className="flex h-full w-72 max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0"
            >
              <SheetTitle className="sr-only">OpenSlate navigation</SheetTitle>
              <div className="flex h-14 shrink-0 items-center justify-between gap-1 border-b px-4">
                <GuardedWorkspaceLink
                  href={"/openview" as Route}
                  aria-label={`${brand?.display_name ?? "OpenSlate"} workspace`}
                  onAcceptedNavigate={closeMobileNavigation}
                  className="flex shrink-0 items-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                  <WorkspaceLogo
                    blob={logoBlob}
                    name={brand?.display_name ?? "OpenSlate"}
                    mark={brand?.mark ?? "OS"}
                    hidden={suspended || brandDenied}
                  />
                </GuardedWorkspaceLink>
                <OrganizationMenu
                  name={brand?.display_name ?? "OpenSlate"}
                  organizationId={organizationId}
                  onSwitchOrganization={onSwitchOrganization}
                  onAccepted={closeMobileNavigation}
                  compact
                />
                {logoFailed ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className="size-11 shrink-0"
                    aria-label="Retry logo"
                    onClick={retryLogo}
                  >
                    <RotateCcw aria-hidden="true" className="size-4" />
                  </Button>
                ) : null}
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
              <div className="app-sidebar-scroll flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-4">
                <AppNavigation
                  pathname={pathname}
                  searchParams={navigationSearchParams}
                />
                <div className="bg-card sticky bottom-0 z-10 -mx-4 mt-auto px-4 pt-3 pb-2">
                  <AppCommsLink collapsed={false} />
                </div>
              </div>
              <AppSidebarFooter collapsed={false} />
            </SheetContent>
          </Sheet>

          <div
            className={cn(
              "min-w-0 flex-1",
              isComms || isAccess
                ? "h-screen min-h-0"
                : isSandbox
                  ? "min-h-screen xl:h-screen xl:min-h-0"
                  : "min-h-screen",
            )}
          >
            <header
              data-skin="topbar"
              className="border-border bg-card sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b px-4 sm:px-5"
            >
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
              <AppHeaderActions
                verifiedUserId={verifiedUserId}
                accountOpen={accountOpen}
                onAccountOpenChange={setAccountOpen}
                onLogout={logout}
              />
            </header>
            <main
              id="main-content"
              data-skin="page"
              data-page-spacing={isComms ? "excluded" : undefined}
              className={cn(
                isComms || isAccess
                  ? "flex h-[calc(100dvh-3.5rem)] min-h-0 flex-col overflow-hidden"
                  : isSandbox
                    ? "min-h-[calc(100vh-3.5rem)] p-4 sm:px-5 sm:py-7 xl:flex xl:h-[calc(100dvh-3.5rem)] xl:min-h-0 xl:flex-col xl:overflow-hidden"
                    : isManage
                      ? "min-h-[calc(100vh-3.5rem)] p-3 sm:px-5 sm:py-3"
                      : "min-h-[calc(100vh-3.5rem)] p-4 sm:px-5 sm:py-7",
              )}
            >
              {children}
            </main>
          </div>
        </SidebarProvider>
      </WorkspaceSignOutProvider>
    </WorkspaceNavigationGuardProvider>
  );
}

function AppSidebarHeader({
  collapsed,
  organizationId,
  onSwitchOrganization,
  brand,
  blob,
  concealed,
  failed,
  onRetry,
}: {
  collapsed: boolean;
  organizationId: string | null;
  onSwitchOrganization: (orgId: string) => Promise<void>;
  brand: WorkspaceBrand | undefined;
  blob: Blob | undefined;
  concealed: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  const name = brand?.display_name ?? "OpenSlate";
  return (
    <SidebarHeader className="shrink-0 gap-4 px-4 pt-4 pb-2">
      <div
        className={cn(
          "flex min-w-0 items-center gap-1",
          collapsed && "flex-col",
        )}
      >
        <GuardedWorkspaceLink
          href={"/openview" as Route}
          aria-label={`${name} workspace`}
          className="flex shrink-0 items-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <WorkspaceLogo
            blob={blob}
            name={name}
            mark={brand?.mark ?? "OS"}
            hidden={concealed}
          />
        </GuardedWorkspaceLink>
        <OrganizationMenu
          name={name}
          organizationId={organizationId}
          onSwitchOrganization={onSwitchOrganization}
          iconOnly={collapsed}
        />
      </div>
      {failed ? (
        <Button
          type="button"
          variant="ghost"
          className="min-h-11"
          aria-label="Retry logo"
          onClick={onRetry}
        >
          {collapsed ? (
            <RotateCcw aria-hidden="true" className="size-4" />
          ) : (
            "Retry logo"
          )}
        </Button>
      ) : null}
    </SidebarHeader>
  );
}

const commsDescription = "Messages and channels";

function AppCommsLink({ collapsed }: { collapsed: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const active = pathname === "/comms" || pathname.startsWith("/comms/");
  const descriptionId = useId();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          render={
            <GuardedWorkspaceLink
              href={"/comms" as Route}
              prefetch={false}
              onPointerEnter={() => router.prefetch("/comms" as Route)}
              onFocus={() => router.prefetch("/comms" as Route)}
            />
          }
          isActive={active}
          aria-current={active ? "page" : undefined}
          aria-label="OpenComms"
          aria-describedby={collapsed ? undefined : descriptionId}
          title={collapsed ? `OpenComms — ${commsDescription}` : undefined}
          className={cn("min-h-11", !collapsed && "h-auto py-1.5")}
        >
          <MessageSquare aria-hidden="true" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate">OpenComms</span>
            {!collapsed ? (
              <span
                id={descriptionId}
                className="text-sidebar-muted truncate text-xs font-normal"
              >
                {commsDescription}
              </span>
            ) : null}
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function AppSidebarFooter({
  collapsed,
  showToggle = false,
}: {
  collapsed: boolean;
  showToggle?: boolean;
}) {
  const router = useRouter();
  const requestNavigation = useWorkspaceNavigationRequest();

  function navigate(href: Route) {
    const resume = () => router.push(href);
    if (requestNavigation(href, resume)) resume();
  }

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
            aria-label={collapsed ? "Your profile" : undefined}
            title={collapsed ? "Your profile" : undefined}
            onClick={() => navigate("/profile")}
          >
            <Settings className="size-4 shrink-0" aria-hidden="true" />
            <span className={cn("truncate", collapsed && "sr-only")}>
              Your profile
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
}

function AppHeaderActions({
  verifiedUserId,
  accountOpen,
  onAccountOpenChange,
  onLogout,
}: {
  verifiedUserId: string | null;
  accountOpen: boolean;
  onAccountOpenChange: (open: boolean) => void;
  onLogout: () => Promise<void>;
}) {
  const requestNavigation = useWorkspaceNavigationRequest();
  const suspended = useWorkspaceInteractionSuspended();
  const identity = useQuery({ ...authMeOptions(), enabled: !suspended });
  const self =
    !suspended && identity.data?.id === verifiedUserId
      ? identity.data
      : undefined;

  function requestLogout() {
    const logout = () => {
      onAccountOpenChange(false);
      void onLogout();
    };
    if (requestNavigation("/login", logout)) logout();
  }

  return (
    <div className="flex shrink-0 items-center gap-1 sm:gap-3">
      <GuardedWorkspaceLink
        href={"/platform" as Route}
        aria-label="Search workspace"
        title="Search workspace"
        className="text-muted-foreground hover:bg-muted flex min-h-11 items-center gap-2 rounded-md px-3 text-sm sm:min-w-52 sm:border"
      >
        <Search className="size-4" aria-hidden="true" />
        <span className="hidden sm:inline">Search workspace…</span>
      </GuardedWorkspaceLink>
      <NotificationBell accountId={verifiedUserId} />
      <HelpPanel />
      <DropdownMenu open={accountOpen} onOpenChange={onAccountOpenChange}>
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
          {self ? (
            <PersonAvatar
              name={self.displayName ?? self.username}
              avatarUrl={
                self.avatarFileId ? `/api/users/${self.id}/avatar` : null
              }
              size="default"
            />
          ) : (
            <UserCircle className="size-5" aria-hidden="true" />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" aria-label="Account">
          <DropdownMenuGroup>
            <DropdownMenuItem
              render={
                <GuardedWorkspaceLink
                  href={"/profile" as Route}
                  onAcceptedNavigate={() => onAccountOpenChange(false)}
                />
              }
            >
              <UserCircle aria-hidden="true" />
              Your profile
            </DropdownMenuItem>
            <DropdownMenuItem onClick={requestLogout}>
              <LogOut aria-hidden="true" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
