import type { Person, Role } from "../../shared/data/sample-people";
import { useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { presenceLabel, type Presence } from "../domain/view-model";
import { Avatar } from "./floating";
import { PersonLink } from "./person-link";
import { Action } from "../../shared/components/ui";
import type { Member } from "../contract/types";
import { LevelBadge } from "./member-level";
import { DepartmentList } from "./channel-scope";

export function MembersPanel({
  members,
  roles,
  levels,
  presence,
  onClose,
  onDirect,
}: {
  members: Person[];
  roles: Role[];
  /** A channel's level per reader; direct and group messages have none to show. */
  levels?: Record<string, Member["level"]>;
  viewerId: string;
  viewerPresence: string;
  presence: Presence;
  onClose: () => void;
  onDirect: (name: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [personCard, setPersonCard] = useState<string | null>(null);
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
        <h3 data-slot="section-title" className="text-sm font-semibold">
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
      {(["Online", "Away", "Offline"] as const).map((status) => {
        const group = filtered.filter(
          (person) => presenceLabel(presence, person.id) === status,
        );
        return (
          <section
            key={status}
            aria-label={`${status} members`}
            className="mt-2"
          >
            <h4 className="text-muted-foreground mb-2 text-xs font-semibold">
              {status}
              <span aria-hidden="true"> — {group.length}</span>
            </h4>
            <div className="flex flex-col gap-1">
              {group.map((person) => (
                <div key={person.id}>
                  <PersonLink
                    person={person}
                    open={personCard === person.id}
                    onOpenChange={(open) =>
                      setPersonCard(open ? person.id : null)
                    }
                    roleName={
                      roles.find((role) => role.id === person.role)?.name ??
                      "Unassigned"
                    }
                    presence={presenceLabel(presence, person.id)}
                    onMessage={onDirect}
                    className={cn(
                      "hover:bg-muted min-h-12 w-full gap-3 px-1.5 py-1",
                      status === "Offline" && "text-muted-foreground",
                    )}
                  >
                    <Avatar
                      name={person.name}
                      presence={presenceLabel(presence, person.id)}
                    />
                    <span className="min-w-0">
                      <bdi className="block truncate text-sm font-medium">
                        {person.name}
                      </bdi>
                    </span>
                  </PersonLink>
                  <p className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pl-12 text-xs">
                    <DepartmentList names={person.departments} />
                    {levels?.[person.id] && (
                      <LevelBadge level={levels[person.id]} />
                    )}
                  </p>
                </div>
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
