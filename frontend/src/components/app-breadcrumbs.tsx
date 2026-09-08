"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  Fragment,
  type ReactNode,
  type Dispatch,
  type SetStateAction,
} from "react";
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
  BreadcrumbEllipsis,
} from "@/components/ui/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

type EntityLabel = { id: string; name: string };
interface Labels {
  department?: EntityLabel;
  module?: EntityLabel;
  record?: EntityLabel;
}
interface Registration {
  pathname: string;
  labels: Labels;
}
const LabelsContext = createContext<Registration | null>(null);
const RegisterContext = createContext<
  Dispatch<SetStateAction<Registration | null>>
>(() => undefined);

export function BreadcrumbLabelsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [registration, register] = useState<Registration | null>(null);
  return (
    <RegisterContext.Provider value={register}>
      <LabelsContext.Provider value={registration}>
        {children}
      </LabelsContext.Provider>
    </RegisterContext.Provider>
  );
}

/** Reuse the page's fetched names; never fetch just to label navigation. */
export function useBreadcrumbLabels({ department, module, record }: Labels) {
  const pathname = usePathname();
  const register = useContext(RegisterContext);
  const departmentId = department?.id,
    departmentName = department?.name;
  const moduleId = module?.id,
    moduleName = module?.name;
  const recordId = record?.id,
    recordName = record?.name;
  useEffect(() => {
    const registration = {
      pathname,
      labels: {
        department:
          departmentId && departmentName
            ? { id: departmentId, name: departmentName }
            : undefined,
        module:
          moduleId && moduleName
            ? { id: moduleId, name: moduleName }
            : undefined,
        record:
          recordId && recordName
            ? { id: recordId, name: recordName }
            : undefined,
      },
    };
    register(registration);
    return () =>
      register((current) => (current === registration ? null : current));
  }, [
    pathname,
    register,
    departmentId,
    departmentName,
    moduleId,
    moduleName,
    recordId,
    recordName,
  ]);
}

interface Crumb {
  label: string;
  href?: string;
}
function pathCrumbs(pathname: string, labels: Labels): Crumb[] {
  const parts = pathname.split("/").filter(Boolean);
  const crumbs: Crumb[] = [{ label: "OpenSlate", href: "/workspace" }];
  if (parts[0] === "modules" && labels.department)
    crumbs.push(
      { label: "Departments", href: "/departments" },
      {
        label: labels.department.name,
        href: `/departments/${labels.department.id}`,
      },
    );
  parts.forEach((part, index) => {
    const previous = parts[index - 1];
    const href = `/${parts.slice(0, index + 1).join("/")}`;
    if (part === "modules") {
      crumbs.push({ label: "Modules" });
      return;
    }
    if (previous === "departments" && part !== "new") {
      crumbs.push({
        label:
          labels.department?.id === part
            ? labels.department.name
            : "Department",
        href,
      });
      return;
    }
    if (previous === "modules") {
      crumbs.push({
        label: labels.module?.id === part ? labels.module.name : "Module",
        href,
      });
      return;
    }
    if (previous === "records" && part !== "new") {
      crumbs.push({
        label: labels.record?.id === part ? labels.record.name : "Record",
      });
      return;
    }
    const label =
      part === "new"
        ? `New ${previous === "records" ? "record" : "department"}`
        : part === "edit"
          ? "Edit record"
          : part.charAt(0).toUpperCase() + part.slice(1).replaceAll("-", " ");
    crumbs.push({
      label,
      href: ["settings", "administration"].includes(part) ? undefined : href,
    });
  });
  return crumbs;
}

export function AppBreadcrumbs() {
  const pathname = usePathname();
  const registration = useContext(LabelsContext);
  const crumbs = pathCrumbs(
    pathname,
    registration?.pathname === pathname ? registration.labels : {},
  );
  const middle = crumbs.slice(1, -1);
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        {crumbs.map((crumb, index) => (
          <Fragment key={`${index}-${crumb.label}`}>
            {index === 1 && middle.length > 1 ? (
              <>
                <BreadcrumbSeparator className="sm:hidden" />
                <BreadcrumbItem className="sm:hidden">
                  <DropdownMenu>
                    <DropdownMenuTrigger aria-label="Show breadcrumb ancestors">
                      <BreadcrumbEllipsis />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuGroup>
                        {middle.map((item, i) =>
                          item.href ? (
                            <DropdownMenuItem
                              key={i}
                              render={<Link href={item.href as Route} />}
                            >
                              {item.label}
                            </DropdownMenuItem>
                          ) : (
                            <div
                              key={i}
                              className="text-muted-foreground px-2 py-1.5 text-sm"
                            >
                              {item.label}
                            </div>
                          ),
                        )}
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </BreadcrumbItem>
              </>
            ) : null}
            {index > 0 ? (
              <BreadcrumbSeparator
                className={
                  index < crumbs.length - 1 && middle.length > 1
                    ? "hidden sm:block"
                    : undefined
                }
              />
            ) : null}
            <BreadcrumbItem
              className={
                index > 0 && index < crumbs.length - 1 && middle.length > 1
                  ? "hidden min-w-0 sm:inline-flex"
                  : "min-w-0"
              }
            >
              {index === crumbs.length - 1 ? (
                <BreadcrumbPage className="max-w-56 truncate">
                  {crumb.label}
                </BreadcrumbPage>
              ) : crumb.href ? (
                <BreadcrumbLink
                  className="max-w-40 truncate"
                  render={<Link href={crumb.href as Route} />}
                >
                  {crumb.label}
                </BreadcrumbLink>
              ) : (
                <span className="max-w-40 truncate">{crumb.label}</span>
              )}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
