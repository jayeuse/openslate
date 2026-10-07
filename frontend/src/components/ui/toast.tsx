"use client";
import { Toast } from "@base-ui/react/toast";
import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import { useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
type NoticeData = { workspaceRevision?: number };
type NoticeOptions = {
  title: string;
  description?: string;
  type: "success" | "error" | "info";
  action?: { label: string; onClick: () => void };
  /** Runs when closing or when private admission is suspended. */
  onClose?: () => void;
};
const manager = Toast.createToastManager<NoticeData>();
const privateNotices = new Map<string, () => void>();
const listeners = new Set<() => void>();
let workspaceRevision = 0;
let workspaceActive = false;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const getRevision = () => workspaceRevision;

function addNotice(
  { action, onClose, ...options }: NoticeOptions,
  privateNotice: boolean,
) {
  if (privateNotice && !workspaceActive) {
    onClose?.();
    return null;
  }
  const admittedRevision = workspaceRevision;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    onClose?.();
  };
  const id: string = manager.add({
    ...options,
    data: privateNotice ? { workspaceRevision: admittedRevision } : {},
    onClose: close,
    onRemove: () => privateNotices.delete(id),
    priority: options.type === "error" ? "high" : "low",
    // An action (Undo) needs time to reach by keyboard.
    timeout: options.type === "error" ? 0 : action ? 12000 : 6000,
    actionProps: action && {
      children: action.label,
      onClick: () => {
        if (
          closed ||
          (privateNotice &&
            (!workspaceActive || admittedRevision !== workspaceRevision))
        )
          return;
        action.onClick();
        manager.close(id);
      },
    },
  });
  if (privateNotice && !closed) privateNotices.set(id, close);
  return id;
}

export const toast = {
  resumeWorkspace() {
    workspaceActive = true;
  },
  clearWorkspace() {
    workspaceActive = false;
    workspaceRevision++;
    for (const listener of listeners) listener();
    for (const [id, close] of [...privateNotices]) {
      try {
        // The provider's separate announcer also reads ending notices. Clear
        // private content and actions before their normal final removal.
        manager.update(id, {
          title: "",
          description: "",
          actionProps: undefined,
          priority: "low",
        });
        manager.close(id);
      } finally {
        close();
      }
    }
  },
  /** Errors stay until dismissed; other notices expire. Actions close their notice. */
  add(options: NoticeOptions) {
    return addNotice(options, true);
  },
  /** Public MFA cleanup must remain available outside a verified workspace. */
  addPublic(options: NoticeOptions) {
    return addNotice(options, false);
  },
};
function ToastList() {
  const { toasts } = Toast.useToastManager<NoticeData>();
  const revision = useSyncExternalStore(subscribe, getRevision, getRevision);
  return (
    <Toast.Portal>
      {/* A notice never covers a primary control: bottom left on wider
          screens (over lists, clear of composers and page actions), and
          below the 56px top bar on phones, where a composer fills the
          bottom edge. */}
      <Toast.Viewport
        // Base UI names this region "Notifications", which collides with the
        // Notifications inbox landmark.
        aria-label="Status messages"
        className="fixed z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 outline-none max-sm:top-[calc(3.5rem+0.5rem)] max-sm:left-1/2 max-sm:-translate-x-1/2 sm:bottom-4 sm:left-4"
      >
        {toasts.map((item) => {
          const obsolete =
            item.data?.workspaceRevision !== undefined &&
            item.data.workspaceRevision !== revision;
          const Icon =
            item.type === "success"
              ? CheckCircle2
              : item.type === "error"
                ? CircleAlert
                : Info;
          return (
            <Toast.Root
              key={item.id}
              toast={item}
              ref={(node) => {
                if (!obsolete || !node) return;
                // Ending records reject manager updates. Finish only this
                // account's old animations so Base UI removes them before paint.
                for (const animation of node.getAnimations()) {
                  try {
                    animation.finish();
                  } catch {
                    animation.cancel();
                  }
                }
              }}
              hidden={obsolete}
              inert={obsolete}
              aria-hidden={obsolete || undefined}
              className={cn(
                "border-border bg-card text-card-foreground relative rounded-[var(--radius)] border p-4 shadow-lg transition-opacity duration-150 data-ending-style:opacity-0 data-limited:hidden data-starting-style:opacity-0 motion-reduce:transition-none",
                item.type === "error" && "border-danger-rule bg-danger-tint",
                obsolete && "hidden",
              )}
            >
              <Toast.Content className="flex items-start gap-3">
                <Icon
                  className={cn(
                    "mt-0.5 size-4 shrink-0",
                    item.type === "error" && "text-destructive",
                  )}
                />
                <div className="flex flex-1 flex-col gap-1">
                  <Toast.Title className="text-sm font-medium" />
                  <Toast.Description className="text-muted-foreground text-sm" />
                </div>
                {item.actionProps && (
                  <span className="sr-only">
                    Press F6 to reach this notice.
                  </span>
                )}
                {item.actionProps && (
                  <Toast.Action className="text-action-text hover:bg-muted focus-visible:outline-ring -my-1 min-h-8 shrink-0 rounded-[var(--radius)] px-2.5 text-sm font-semibold outline-none focus-visible:outline-2" />
                )}
                {/* Base UI hides Close from assistive technology but keeps it
                    focusable; a focusable control must keep its name. */}
                <Toast.Close
                  aria-hidden={false}
                  aria-label="Dismiss notification"
                  className="text-muted-foreground hover:bg-muted focus-visible:outline-ring rounded-sm p-1 outline-none focus-visible:outline-2"
                >
                  <X className="size-4" />
                </Toast.Close>
              </Toast.Content>
            </Toast.Root>
          );
        })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}
export function Toaster() {
  return (
    <Toast.Provider toastManager={manager}>
      <ToastList />
    </Toast.Provider>
  );
}
