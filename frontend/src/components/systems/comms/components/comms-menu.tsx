"use client";
import { useRef, useState } from "react";
import {
  ChevronDown,
  FolderOpen,
  FolderPlus,
  Hash,
  MessageSquare,
  Plus,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useCommsRead } from "../state/runtime";
import { useCommsWorkspaceView } from "../state/use-comms-workspace";

export type WorkspaceSetting =
  | "create-channel"
  | "edit-channel"
  | "create-category"
  | "edit-category"
  | "threads"
  | "personal"
  | "workspace"
  | "management"
  | "templates"
  | "history"
  | "moderation"
  | "outbox"
  | "retention"
  | "export";
export type CommsMenuAccess = {
  canManageChannel: boolean;
  canCreate: boolean;
  canAdminister: boolean;
};
export type OpenWorkspaceSetting = (
  setting: WorkspaceSetting,
  opener: HTMLElement,
) => void;

function RecoverableBadge({ count }: { count: number }) {
  return (
    <Badge variant="warning" className="ml-auto">
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">
        {count} removed {count === 1 ? "message" : "messages"} to review
      </span>
    </Badge>
  );
}
export function CommsMenu({
  compact = false,
  hasChannel,
  canManageChannel,
  canCreate,
  canAdminister,
  onSelect,
}: CommsMenuAccess & {
  compact?: boolean;
  hasChannel: boolean;
  onSelect: OpenWorkspaceSetting;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const { checks } = useCommsWorkspaceView();
  const rooms = Object.entries(checks)
    .filter(([, check]) => check.capabilities.moderate.allowed)
    .map(([id]) => id);
  const counts = useCommsRead(
    `moderation-count:${rooms.join(",")}`,
    async (client, signal) => {
      let total = 0;
      for (const room of rooms)
        total += (
          await client.listRemovedMessages(room, { limit: 1 }, { signal })
        ).pagination.total;
      return total;
    },
    open && canAdminister,
  );
  const recoverableCount = counts.data;
  const groups = [
    [
      { id: "personal", label: "My preferences", icon: UserRound },
      { id: "threads", label: "Browse threads", icon: MessageSquare },
    ],
    canManageChannel
      ? [
          { id: "edit-channel", label: "Channel settings", icon: Hash },
          { id: "edit-category", label: "Category settings", icon: FolderOpen },
        ]
      : [],
    canCreate
      ? [
          { id: "create-channel", label: "New channel", icon: Plus },
          { id: "create-category", label: "New category", icon: FolderPlus },
        ]
      : [],
  ].filter((group) => group.length > 0) as {
    id: WorkspaceSetting;
    label: string;
    icon: typeof Hash;
  }[][];
  const adminGroups = [
    {
      label: "Messages and safety",
      tools: [
        { id: "moderation", label: "Moderation" },
        { id: "outbox", label: "Scheduled messages" },
        { id: "retention", label: "Message retention" },
        { id: "export", label: "Export messages" },
      ],
    },
    {
      label: "Setup",
      tools: [
        { id: "workspace", label: "Workspace settings" },
        { id: "templates", label: "Channel templates" },
        { id: "management", label: "Join requests" },
        { id: "history", label: "Settings history" },
      ],
    },
  ] as const;
  const select = (id: WorkspaceSetting) => {
    if (trigger.current) onSelect(id, trigger.current);
  };
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-0.5",
        compact && "md:hidden",
      )}
    >
      <h1
        className={cn(
          "truncate pl-2 font-semibold tracking-tight",
          compact && "pl-0 text-xs",
        )}
      >
        OpenComms
      </h1>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          ref={trigger}
          aria-label="OpenComms menu"
          className={cn(
            "hover:bg-muted focus-visible:ring-ring grid size-11 shrink-0 place-items-center rounded-md outline-none focus-visible:ring-2",
            compact && "size-7",
          )}
        >
          <ChevronDown aria-hidden="true" className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-60 max-w-[calc(100vw-32px)] p-1.5">
          {groups.map((group, index) => (
            <DropdownMenuGroup key={group[0].id}>
              {index > 0 && <DropdownMenuSeparator />}
              {group.map(({ id, label, icon: Icon }) => (
                <DropdownMenuItem
                  key={id}
                  className="min-h-10"
                  disabled={id.startsWith("edit-") && !hasChannel}
                  onClick={() => select(id)}
                >
                  <Icon aria-hidden="true" /> {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          ))}
          {canAdminister && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="min-h-10">
                  <ShieldCheck aria-hidden="true" /> Admin tools
                  {recoverableCount !== undefined && recoverableCount > 0 && (
                    <RecoverableBadge count={recoverableCount} />
                  )}
                  {counts.status === "loading" && (
                    <span
                      role="status"
                      aria-label="Loading moderation count"
                      className="ml-auto"
                    >
                      …
                    </span>
                  )}
                  {counts.error && (
                    <span
                      role="status"
                      className="text-muted-foreground ml-auto text-xs"
                    >
                      Count unavailable
                    </span>
                  )}
                </DropdownMenuSubTrigger>
                <DropdownMenuContent
                  side="right"
                  sideOffset={6}
                  className="w-56 max-w-[calc(100vw-32px)] p-1.5"
                >
                  {adminGroups.map((group, index) => (
                    <DropdownMenuGroup key={group.label}>
                      {index > 0 && <DropdownMenuSeparator />}
                      <DropdownMenuLabel className="text-muted-foreground px-2 pt-1.5 pb-1 text-xs font-semibold">
                        {group.label}
                      </DropdownMenuLabel>
                      {group.tools.map(({ id, label }) => (
                        <DropdownMenuItem
                          key={id}
                          className="min-h-10"
                          onClick={() => select(id)}
                        >
                          {label}
                          {id === "moderation" &&
                            recoverableCount !== undefined &&
                            recoverableCount > 0 && (
                              <RecoverableBadge count={recoverableCount} />
                            )}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuGroup>
                  ))}
                </DropdownMenuContent>
              </DropdownMenuSub>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
