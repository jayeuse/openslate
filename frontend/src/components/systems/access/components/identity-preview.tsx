"use client";

import { Bot, Pencil, UserRound, UsersRound, X } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AccessGroup, AccessIdentity } from "../domain/policy";
import { displayIdentityStatus } from "../domain/policy";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { IdentityAccessCheck } from "./identity-access-check";
import type { AccessController } from "../state/controller";
import type { Role } from "../domain/model";

type IdentityPreviewProps = {
  controller: AccessController;
  identity: AccessIdentity | null;
  identities: readonly AccessIdentity[];
  roles: readonly Role[];
  groups: readonly AccessGroup[];
  departments: readonly { id: string; name: string }[];
  open: boolean;
  finalFocus: () => HTMLElement | null | false;
  onOpenChange: (open: boolean) => void;
  onManage: (identityId: string) => void;
};

const kindLabels: Record<AccessIdentity["kind"], string> = {
  internal: "Internal",
  guest: "Guest",
  service: "Service",
};

const statusLabels: Record<ReturnType<typeof displayIdentityStatus>, string> = {
  active: "Active",
  expired: "Expired",
  pending: "Pending",
  disabled: "Disabled",
  deleted: "Deleted",
  revoked: "Revoked",
  suspended: "Suspended",
};

function statusVariant(status: ReturnType<typeof displayIdentityStatus>) {
  if (status === "active") return "success" as const;
  if (status === "pending") return "warning" as const;
  if (status === "disabled" || status === "revoked")
    return "secondary" as const;
  return "outline" as const;
}

function formatExpiry(value: string | undefined): string {
  if (!value) return "No expiry";
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return "Unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    date,
  );
}

function referencedName(
  identityId: string,
  identities: readonly AccessIdentity[],
): string {
  return (
    identities.find((identity) => identity.id === identityId)?.name ??
    "Unavailable"
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-medium break-words">{value}</dd>
    </div>
  );
}

function IdentityMark({ kind }: { kind: AccessIdentity["kind"] }) {
  const Icon =
    kind === "internal" ? UserRound : kind === "guest" ? UsersRound : Bot;
  return (
    <div className="bg-muted text-foreground flex size-14 shrink-0 items-center justify-center rounded-full">
      <Icon className="size-6" aria-hidden="true" />
    </div>
  );
}

export function IdentityPreview({
  controller,
  identity,
  identities,
  roles,
  groups,
  departments,
  open,
  finalFocus,
  onOpenChange,
  onManage,
}: IdentityPreviewProps) {
  const roleName = identity
    ? (roles.find((role) => role.id === identity.roleId)?.name ?? "Unavailable")
    : "";
  const status = identity ? displayIdentityStatus(identity) : null;
  const description =
    identity?.kind === "internal"
      ? "An internal person in your workspace directory."
      : identity?.kind === "guest"
        ? "A sponsored identity with time-limited access."
        : identity?.kind === "service"
          ? "Service details for an integration or automation. No credentials are shown."
          : "This person or service is no longer in the directory.";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl space-y-5" finalFocus={finalFocus}>
        <DialogHeader className="pr-10">
          <DialogTitle>Access details</DialogTitle>
          <DialogDescription>
            This is a read-only preview. Choose Edit access to make changes.
          </DialogDescription>
        </DialogHeader>
        <DialogClose
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute top-3 right-3 min-h-11 min-w-11"
              aria-label="Close access details"
            />
          }
        >
          <X aria-hidden="true" />
        </DialogClose>

        {identity && status ? (
          <>
            <div className="flex min-w-0 items-center gap-4">
              <IdentityMark kind={identity.kind} />
              <div className="min-w-0 flex-1 space-y-1">
                <h2
                  data-slot="section-title"
                  className="text-xl font-semibold tracking-tight break-words"
                >
                  {identity.name}
                </h2>
                <p className="text-muted-foreground text-sm break-words">
                  {identity.kind === "service"
                    ? "Service metadata"
                    : identity.email}
                </p>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Badge variant="secondary">{kindLabels[identity.kind]}</Badge>
                  <Badge variant={statusVariant(status)}>
                    {statusLabels[status]}
                  </Badge>
                </div>
              </div>
            </div>

            <Tabs key={identity.id} defaultValue="details">
              <TabsList
                aria-label="Identity information"
                className="grid w-full grid-cols-2"
              >
                <TabsTrigger value="details">Details</TabsTrigger>
                <TabsTrigger value="check">Check access</TabsTrigger>
              </TabsList>
              <TabsContent value="details" className="space-y-4">
                <dl className="space-y-3 border-y py-4">
                  <Detail label="Role" value={roleName} />
                  {identity.kind === "internal" ? (
                    <>
                      <Detail
                        label="Job title"
                        value={identity.title.trim() || "Not provided"}
                      />
                      <Detail
                        label="Department"
                        value={
                          identity.departmentIds.length === 0
                            ? "Not assigned"
                            : identity.departmentIds
                                .map(
                                  (departmentId) =>
                                    departments.find(
                                      (department) =>
                                        department.id === departmentId,
                                    )?.name ?? "Unavailable",
                                )
                                .join(", ")
                        }
                      />
                      <Detail
                        label="Groups"
                        value={
                          identity.groupIds.length === 0
                            ? "No groups"
                            : identity.groupIds
                                .map(
                                  (groupId) =>
                                    groups.find((group) => group.id === groupId)
                                      ?.name ?? "Unavailable",
                                )
                                .join(", ")
                        }
                      />
                      <Detail
                        label="Access expires"
                        value={formatExpiry(identity.expiresAt)}
                      />
                    </>
                  ) : identity.kind === "guest" ? (
                    <>
                      <Detail
                        label="Sponsor"
                        value={referencedName(identity.sponsorId, identities)}
                      />
                      <Detail
                        label="Access expires"
                        value={formatExpiry(identity.expiresAt)}
                      />
                    </>
                  ) : (
                    <>
                      <Detail
                        label="Owner"
                        value={referencedName(identity.ownerId, identities)}
                      />
                      <Detail
                        label="Purpose"
                        value={identity.purpose.trim() || "Not provided"}
                      />
                      <Detail
                        label="Access expires"
                        value={formatExpiry(identity.expiresAt)}
                      />
                    </>
                  )}
                </dl>

                <section className="space-y-2" aria-labelledby="identity-about">
                  <h3
                    data-slot="section-title"
                    id="identity-about"
                    className="font-semibold"
                  >
                    About
                  </h3>
                  <p className="text-muted-foreground text-sm">{description}</p>
                </section>

                {identity.kind === "guest" && status === "pending" ? (
                  <Alert variant="warning">
                    <p className="font-medium">Invitation pending</p>
                    <p className="mt-1 text-sm">
                      This guest has not accepted their invitation.
                    </p>
                  </Alert>
                ) : null}
              </TabsContent>
              <TabsContent value="check">
                <IdentityAccessCheck
                  key={identity.id}
                  controller={controller}
                  identityId={identity.id}
                />
              </TabsContent>
            </Tabs>
            <DialogFooter className="mt-2 flex-col-reverse sm:flex-row sm:justify-between">
              <DialogClose
                render={
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                  />
                }
              >
                Close
              </DialogClose>
              <Button
                type="button"
                className="min-h-11"
                onClick={() => onManage(identity.id)}
              >
                <Pencil aria-hidden="true" /> Edit access
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <Alert variant="warning">
              <p className="font-medium">Identity unavailable</p>
              <p className="mt-1 text-sm">
                This identity is no longer available in the directory. Close
                this preview and refresh the list.
              </p>
            </Alert>
            <DialogFooter>
              <DialogClose
                render={
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                  />
                }
              >
                Close
              </DialogClose>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
