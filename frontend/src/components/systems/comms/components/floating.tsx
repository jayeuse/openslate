import {
  createContext,
  useContext,
  useId,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
  type ReactNode,
} from "react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverTitle,
} from "@/components/ui/popover";
import {
  Avatar as AvatarRoot,
  AvatarFallback,
  AvatarBadge,
} from "@/components/ui/avatar";
import {
  MoreHorizontal,
  Smile,
  Pencil,
  Reply,
  MessagesSquare,
  Pin,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Person } from "../../shared/data/sample-people";
import { EMOTES } from "../domain/model";

const ProfilePopoverContext = createContext<{
  activeId: string | null;
  setActiveId: Dispatch<SetStateAction<string | null>>;
} | null>(null);

export function ProfilePopoverProvider({ children }: { children: ReactNode }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  return (
    <ProfilePopoverContext.Provider value={{ activeId, setActiveId }}>
      {children}
    </ProfilePopoverContext.Provider>
  );
}

export function Avatar({
  name,
  large = false,
  presence,
}: {
  name: string;
  large?: boolean;
  presence?: string;
}) {
  return (
    <AvatarRoot className={large ? "size-16" : undefined}>
      <AvatarFallback
        aria-hidden="true"
        className={large ? "text-xl" : undefined}
      >
        {name
          .split(" ")
          .map((part) => part[0])
          .slice(0, 2)
          .join("")}
      </AvatarFallback>
      {presence && (
        <AvatarBadge
          role="img"
          aria-label={presence}
          className={cn(
            presence === "Offline"
              ? "bg-muted-foreground"
              : presence === "Busy"
                ? "bg-warn"
                : "bg-flow",
          )}
        />
      )}
    </AvatarRoot>
  );
}

export function FloatingList({
  label,
  icon,
  children,
}: {
  label: string;
  icon: ReactNode;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={label}
            className="min-h-10"
          />
        }
      >
        {icon}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        collisionPadding={12}

        aria-label={label}
        className="w-[min(360px,calc(100vw-24px))] p-4"
      >
        <div className="mb-3 flex items-center justify-between">
          <PopoverTitle className="text-sm font-semibold">{label}</PopoverTitle>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={`Close ${label.toLowerCase()}`}
            onClick={() => setOpen(false)}
          >
            <X />
          </Button>
        </div>
        {children(() => setOpen(false))}
      </PopoverContent>
    </Popover>
  );
}

export function EmojiPicker({
  onSelect,
  disabled = false,
}: {
  onSelect: (emoji: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Use emotes"
            disabled={disabled}
            className="min-h-10"
          />
        }
      >
        <Smile className="size-4" />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={12}

        aria-label="Emoji picker"
        className="w-56 p-3"
      >
        <PopoverTitle className="text-muted-foreground mb-2 text-xs font-semibold">
          Common emotes
        </PopoverTitle>
        <div className="grid grid-cols-4 gap-1">
          {EMOTES.map(({ emoji, label }) => (
            <Tooltip key={emoji}>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Insert ${emoji}`}
                    className="size-11 text-xl"
                    onClick={() => {
                      onSelect(emoji);
                      setOpen(false);
                    }}
                  />
                }
              >
                {emoji}
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function ProfilePopover({
  person,
  roleName,
  presence,
  onMessage,
  children,
  className,
}: {
  person: Person;
  roleName: string;
  presence: string;
  onMessage: (name: string) => void;
  children?: ReactNode;
  className?: string;
}) {
  const selection = useContext(ProfilePopoverContext);
  const id = useId();
  if (!selection)
    throw new Error("ProfilePopover requires ProfilePopoverProvider.");
  const { activeId, setActiveId } = selection;
  const open = activeId === id;
  function setOpen(nextOpen: boolean) {
    // A closing profile must not dismiss the profile that replaced it.
    setActiveId((current) => (nextOpen ? id : current === id ? null : current));
  }
  const trigger = useRef<HTMLButtonElement | null>(null);
  return (
    <Popover open={open} onOpenChange={setOpen} triggerId={id}>
      <PopoverTrigger
        id={id}
        render={
          <Button
            type="button"
            variant="ghost"
            className="h-auto justify-start p-0"
          />
        }
        ref={trigger}
        aria-label={`View profile for ${person.name}`}
        className={cn(
          "focus-visible:ring-ring flex shrink-0 items-center rounded-md text-left outline-none focus-visible:ring-2",
          className,
        )}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
      >
        {children ?? <Avatar name={person.name} presence={presence} />}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="right"
        sideOffset={8}
        collisionPadding={12}

        aria-label="Member profile"
        finalFocus={() => (activeId === null ? trigger.current : false)}
        className="w-[min(280px,calc(100vw-24px))] gap-0 p-0"
      >
        <div className="bg-muted h-14" />
        <div className="flex flex-col gap-3 px-4 pb-4">
          <div className="border-popover -mt-8 w-fit rounded-full border-4">
            <Avatar name={person.name} large presence={presence} />
          </div>
          <div>
            <PopoverTitle className="font-semibold">{person.name}</PopoverTitle>
            <p className="text-muted-foreground mt-1 text-xs">{presence}</p>
          </div>
          <div className="bg-muted/50 rounded-md p-3 text-sm">
            <p className="font-medium">{roleName}</p>
            <p className="text-muted-foreground mt-1">{person.title}</p>
            <p className="text-muted-foreground mt-1 text-xs">
              {person.primary}
            </p>
          </div>
          <Button
            onClick={() => {
              setOpen(false);
              onMessage(person.name);
            }}
          >
            Message {person.name}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

type MessageMenuProps = {
  id: string;
  className?: string;
  highlighted?: boolean;
  children: ReactNode;
  mutable: boolean;
  canEdit: boolean;
  editExpired: boolean;
  canElevate: boolean;
  canDelete: boolean;
  pinned: boolean;
  allowedReactions?: string[];
  onTool?: (
    view: "message-history" | "report" | "outbox",
    opener: HTMLElement,
  ) => void;
  onReaction: (emoji: string) => void;
  onEdit: () => void;
  onReply: () => void;
  onThread: () => void;
  onPin: () => void;
  onDelete: () => void;
};
export function MessageMenu({
  id,
  className,
  highlighted,
  children,
  mutable,
  canEdit,
  editExpired,
  canElevate,
  canDelete,
  pinned,
  allowedReactions,
  onTool,
  onReaction,
  onEdit,
  onReply,
  onThread,
  onPin,
  onDelete,
}: MessageMenuProps) {
  const [open, setOpen] = useState(false);
  const [buttonAnchor, setButtonAnchor] = useState<HTMLElement | null>(null);
  const article = useRef<HTMLDivElement | null>(null);
  return (
    <ContextMenu open={open} onOpenChange={setOpen}>
      <ContextMenuTrigger
        render={
          <article
            id={id}
            tabIndex={-1}
            data-highlighted={highlighted || undefined}
          />
        }
        ref={article}
        className={cn(
          "group focus-visible:ring-ring relative rounded-md outline-none select-text focus-visible:ring-2",
          highlighted && "bg-accent ring-border ring-1",
          className,
        )}
        onContextMenu={() => setButtonAnchor(null)}
        onKeyDown={(event) => {
          if (
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          ) {
            event.preventDefault();
            setButtonAnchor(event.currentTarget);
            setOpen(true);
          }
        }}
      >
        {children}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Message actions"
          aria-haspopup="menu"
          aria-expanded={open}
          className="bg-card absolute top-1 right-1 size-8 opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
          onClick={(event) => {
            event.stopPropagation();
            setButtonAnchor(event.currentTarget);
            setOpen(true);
          }}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </ContextMenuTrigger>
      <ContextMenuContent
        anchor={buttonAnchor ?? undefined}
        sideOffset={4}
        collisionPadding={10}

        aria-label="Message actions"
        finalFocus={() => buttonAnchor ?? article.current}
        className="w-56"
      >
        <ContextMenuGroup>
          <ContextMenuSub>
            <ContextMenuSubTrigger className="min-h-9" disabled={!mutable}>
              <Smile />
              Add reaction
            </ContextMenuSubTrigger>
            <ContextMenuSubContent
              side="right"
              align="start"
              sideOffset={5}
              collisionPadding={10}

              aria-label="Common reactions"
              className="w-44"
            >
              <ContextMenuGroup>
                {EMOTES.filter(
                  ({ emoji }) =>
                    !allowedReactions || allowedReactions.includes(emoji),
                ).map(({ emoji, label }) => (
                  <ContextMenuItem
                    key={emoji}
                    className="min-h-9"
                    aria-label={`React with ${emoji}`}
                    onClick={() => onReaction(emoji)}
                  >
                    <span className="text-lg">{emoji}</span>
                    {label}
                  </ContextMenuItem>
                ))}
              </ContextMenuGroup>
            </ContextMenuSubContent>
          </ContextMenuSub>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          {canEdit && (
            <ContextMenuItem
              className="min-h-9"
              disabled={editExpired}
              onClick={onEdit}
            >
              <Pencil />
              Edit message
            </ContextMenuItem>
          )}
          <ContextMenuItem
            className="min-h-9"
            disabled={!mutable}
            onClick={onReply}
          >
            <Reply />
            Reply
          </ContextMenuItem>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem
            className="min-h-9"
            disabled={!mutable}
            onClick={onThread}
          >
            <MessagesSquare />
            Create thread
          </ContextMenuItem>
          {canElevate && (
            <ContextMenuItem className="min-h-9" onClick={onPin}>
              <Pin />
              {pinned ? "Unpin message" : "Pin message"}
            </ContextMenuItem>
          )}
        </ContextMenuGroup>
        <ContextMenuGroup>
          {(
            [
              ["report", "Report message"],
              ["message-history", "Edit history"],
              ["outbox", "Schedule message"],
            ] as const
          ).map(([view, label]) => (
            <ContextMenuItem
              key={view}
              className="min-h-9"
              onClick={() => {
                const opener = article.current;
                if (opener) onTool?.(view, opener);
              }}
            >
              {label}
            </ContextMenuItem>
          ))}
        </ContextMenuGroup>
        {canDelete && (
          <>
            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuItem
                variant="destructive"
                className="min-h-9"
                onClick={onDelete}
              >
                <Trash2 />
                Delete message
              </ContextMenuItem>
            </ContextMenuGroup>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function RowEditMenu({
  label,
  actionsLabel,
  showActions = true,
  children,
  onEdit,
  actions = [],
}: {
  label: "Channel settings" | "Category settings";
  actionsLabel: string;
  showActions?: boolean;
  children: ReactNode;
  onEdit: (opener: HTMLElement) => void;
  actions?: {
    label: string;
    onSelect: (opener: HTMLElement) => void;
    disabled?: boolean;
  }[];
}) {
  const [open, setOpen] = useState(false);
  const [buttonAnchor, setButtonAnchor] = useState<HTMLElement | null>(null);
  const row = useRef<HTMLDivElement>(null);
  const openingEditor = useRef(false);
  function openAt(anchor: HTMLElement) {
    openingEditor.current = false;
    setButtonAnchor(anchor);
    setOpen(true);
  }
  return (
    <ContextMenu
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) openingEditor.current = false;
        setOpen(nextOpen);
      }}
    >
      <ContextMenuTrigger
        ref={row}
        className="group relative"
        onContextMenu={() => {
          openingEditor.current = false;
          setButtonAnchor(null);
        }}
        onKeyDown={(event) => {
          if (
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          ) {
            event.preventDefault();
            openAt(
              event.target instanceof HTMLElement
                ? event.target
                : event.currentTarget,
            );
          }
        }}
      >
        {children}
        {showActions && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={actionsLabel}
            aria-haspopup="menu"
            aria-expanded={open}
            className="absolute top-1/2 right-1 size-8 -translate-y-1/2 opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              openAt(event.currentTarget);
            }}
          >
            <MoreHorizontal aria-hidden="true" className="size-4" />
          </Button>
        )}
      </ContextMenuTrigger>
      <ContextMenuContent
        anchor={buttonAnchor ?? undefined}
        sideOffset={4}
        collisionPadding={10}

        aria-label={actionsLabel}
        finalFocus={() =>
          openingEditor.current
            ? false
            : (buttonAnchor ?? row.current?.querySelector("button") ?? false)
        }
        className="w-48"
      >
        <ContextMenuGroup>
          <ContextMenuItem
            className="min-h-9"
            onClick={() => {
              const opener = row.current?.querySelector("button");
              if (!opener) return;
              openingEditor.current = true;
              onEdit(opener);
            }}
          >
            <Pencil aria-hidden="true" />
            {label}
          </ContextMenuItem>
          {actions.map((action) => (
            <ContextMenuItem
              key={action.label}
              disabled={action.disabled}
              className="min-h-9"
              onClick={() => {
                const opener = row.current?.querySelector("button");
                if (opener) {
                  openingEditor.current = true;
                  action.onSelect(opener);
                }
              }}
            >
              {action.label}
            </ContextMenuItem>
          ))}
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}
