import type { Person, Role } from "../../access/domain/model";
import { useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { samplePresence } from "../domain/model";
import { Avatar, ProfilePopover } from "./floating";
import { Action } from "../../shared/components/ui";

export function MembersPanel({
  members,
  roles,
  viewerId,
  viewerPresence,
  onClose,
  onDirect,
}: {
  members: Person[];
  roles: Role[];
  viewerId: string;
  viewerPresence: string;
  onClose: () => void;
  onDirect: (name: string) => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = members.filter((person) =>
    person.name.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <section
      role="region"
      aria-label="Members with access"
      className="flex flex-col gap-3 p-4"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          Members{" "}
          <span className="text-muted-foreground">{members.length}</span>
        </h3>
        <Action
          size="icon"
          variant="ghost"
          aria-label="Close members"
          onClick={onClose}
        >
          <X className="size-4" />
        </Action>
      </div>
      <Input
        aria-label="Search members"
        placeholder="Find a member"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {([false, true] as const).map((offline) => {
        const group = filtered.filter(
          (person) =>
            (samplePresence(person.id, viewerId, viewerPresence) ===
              "Offline") ===
            offline,
        );
        return (
          <section key={String(offline)} className="mt-2">
            <h4 className="text-muted-foreground mb-2 text-[10px] font-semibold tracking-wider uppercase">
              {offline ? "Offline" : "Online"}
              <span aria-hidden="true"> — {group.length}</span>
            </h4>
            <div className="flex flex-col gap-1">
              {group.map((person) => (
                <ProfilePopover
                  key={person.id}
                  person={person}
                  roleName={
                    roles.find((role) => role.id === person.role)?.name ??
                    "Unassigned"
                  }
                  presence={samplePresence(person.id, viewerId, viewerPresence)}
                  onMessage={onDirect}
                  className={cn(
                    "hover:bg-muted min-h-12 w-full gap-3 px-1.5 py-1",
                    offline && "text-muted-foreground",
                  )}
                >
                  <Avatar
                    name={person.name}
                    presence={samplePresence(
                      person.id,
                      viewerId,
                      viewerPresence,
                    )}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {person.name}
                    </span>
                    <span className="text-muted-foreground block truncate text-[10px]">
                      {roles.find((role) => role.id === person.role)?.name ??
                        "Unassigned"}{" "}
                      · {samplePresence(person.id, viewerId, viewerPresence)}
                    </span>
                  </span>
                </ProfilePopover>
              ))}
            </div>
          </section>
        );
      })}
      {!filtered.length && (
        <Empty className="p-3">
          <EmptyDescription>No members match.</EmptyDescription>
        </Empty>
      )}
    </section>
  );
}
