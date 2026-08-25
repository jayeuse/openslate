"use client";

import { usePathname, useRouter } from "next/navigation";
import type { Route } from "next";
import { useState } from "react";
import {
  ChevronDown,
  LayoutDashboard,
  Menu,
  PanelLeft,
  Settings,
  ShieldCheck,
  TableProperties,
  Users,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useRealtime } from "@/components/realtime-provider";
import { cn } from "@/lib/utils";

const primaryLinks = [
  { href: "/workspace", label: "Workspace", icon: LayoutDashboard },
  { href: "/departments", label: "Departments", icon: PanelLeft },
  { href: "/administration/users", label: "People", icon: Users },
  { href: "/administration/roles", label: "Roles", icon: ShieldCheck },
  {
    href: "/administration/audit",
    label: "Audit trail",
    icon: TableProperties,
  },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const { invalidate } = useRealtime();
  const title =
    pathname === "/workspace"
      ? "Workspace"
      : (pathname
          .split("/")
          .filter(Boolean)
          .slice(-1)[0]
          ?.replaceAll("-", " ") ?? "Workspace");

  function navigate(href: string) {
    setMobileOpen(false);
    router.push(href as Route);
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

  return (
    <div className="bg-background text-foreground min-h-screen">
      <a
        href="#main-content"
        className="focus:bg-primary focus:text-primary-foreground sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:px-4 focus:py-2"
      >
        Skip to content
      </a>
      <aside className="bg-sidebar text-sidebar-foreground fixed inset-y-0 left-0 z-30 hidden w-64 flex-col lg:flex">
        <div className="flex h-16 items-center gap-3 border-b border-white/10 px-5">
          <span className="bg-primary text-primary-foreground grid size-8 place-items-center rounded-md text-xs font-bold">
            OS
          </span>
          <div>
            <p className="text-sm font-semibold">OpenSlate</p>
            <p className="text-sidebar-muted text-[10px] tracking-[0.16em] uppercase">
              Operations
            </p>
          </div>
        </div>
        <div className="px-4 py-6">
          <p className="text-sidebar-muted mb-3 px-2 text-[10px] font-semibold tracking-[0.16em] uppercase">
            Workspace
          </p>
          <nav className="space-y-1">
            {primaryLinks.map(({ href, label, icon: Icon }) => (
              <button
                key={href}
                onClick={() => navigate(href)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm transition-colors",
                  pathname.startsWith(href)
                    ? "bg-sidebar-accent text-white"
                    : "text-sidebar-muted hover:bg-sidebar-accent/70 hover:text-white",
                )}
              >
                <Icon size={17} aria-hidden="true" />
                {label}
              </button>
            ))}
          </nav>
        </div>
        <div className="mt-auto space-y-1 border-t border-white/10 p-4">
          <button
            onClick={() => navigate("/settings/appearance")}
            className="text-sidebar-muted hover:bg-sidebar-accent flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm hover:text-white"
          >
            <Settings size={17} aria-hidden="true" />
            Appearance
          </button>
          <button
            onClick={logout}
            className="text-sidebar-muted hover:bg-sidebar-accent flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm hover:text-white"
          >
            <X size={17} aria-hidden="true" />
            Sign out
          </button>
        </div>
      </aside>
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={() => setMobileOpen(false)}
        >
          <aside
            className="bg-sidebar text-sidebar-foreground h-full w-72 p-5"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-8 flex items-center justify-between">
              <span className="font-semibold">OpenSlate</span>
              <button
                aria-label="Close navigation"
                onClick={() => setMobileOpen(false)}
              >
                <X />
              </button>
            </div>
            <nav className="space-y-1">
              {primaryLinks.map(({ href, label, icon: Icon }) => (
                <button
                  key={href}
                  onClick={() => navigate(href)}
                  className="text-sidebar-muted hover:bg-sidebar-accent flex w-full items-center gap-3 rounded-md px-3 py-3 text-left text-sm hover:text-white"
                >
                  <Icon size={17} aria-hidden="true" />
                  {label}
                </button>
              ))}
            </nav>
          </aside>
        </div>
      )}
      <div className="lg:pl-64">
        <header className="border-border bg-background/95 sticky top-0 z-20 flex h-16 items-center justify-between border-b px-4 backdrop-blur sm:px-8">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              aria-label="Open navigation"
              onClick={() => setMobileOpen(true)}
            >
              <Menu />
            </Button>
            <div className="text-muted-foreground hidden items-center gap-2 text-sm sm:flex">
              <span>OpenSlate</span>
              <span>/</span>
            </div>
            <h1 className="text-sm font-semibold capitalize">{title}</h1>
          </div>
          <div className="relative">
            <Button
              variant="ghost"
              className="gap-2"
              onClick={() => setAccountOpen((value) => !value)}
            >
              <span className="bg-accent text-accent-foreground grid size-7 place-items-center rounded-full text-xs font-bold">
                AD
              </span>
              <span className="hidden sm:inline">Administrator</span>
              <ChevronDown size={15} />
            </Button>
            {accountOpen && (
              <div className="border-border bg-popover absolute right-0 mt-2 w-48 rounded-md border p-1 shadow-lg">
                <button
                  className="hover:bg-muted w-full rounded px-3 py-2 text-left text-sm"
                  onClick={() => navigate("/settings/appearance")}
                >
                  Appearance
                </button>
                <button
                  className="text-destructive hover:bg-muted w-full rounded px-3 py-2 text-left text-sm"
                  onClick={logout}
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        </header>
        <main id="main-content" className="mx-auto max-w-[1600px] p-4 sm:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
