"use client";
import { Toast } from "@base-ui/react/toast";
import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";
const manager = Toast.createToastManager();
export const toast = {
  /** Errors stay until dismissed; other toasts close on their own. An
   *  action (such as Undo) closes the toast when used. */
  add({
    action,
    ...options
  }: {
    title: string;
    description?: string;
    type: "success" | "error" | "info";
    action?: { label: string; onClick: () => void };
    /** Runs when the toast starts closing (timeout, dismiss, or action). */
    onClose?: () => void;
  }) {
    const id: string = manager.add({
      ...options,
      priority: options.type === "error" ? "high" : "low",
      timeout: options.type === "error" ? 0 : 6000,
      actionProps: action && {
        children: action.label,
        onClick: () => {
          action.onClick();
          manager.close(id);
        },
      },
    });
    return id;
  },
};
function ToastList() {
  const { toasts } = Toast.useToastManager<Record<string, never>>();
  return (
    <Toast.Portal>
      {/* A notice never covers a primary control: bottom left on wider
          screens (over lists, clear of composers and page actions), and
          below the 56px top bar on phones, where a composer fills the
          bottom edge. */}
      <Toast.Viewport className="fixed z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 outline-none max-sm:top-[calc(3.5rem+0.5rem)] max-sm:left-1/2 max-sm:-translate-x-1/2 sm:bottom-4 sm:left-4">
        {toasts.map((item) => {
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
              className="border-border bg-card text-card-foreground relative rounded-[var(--radius)] border p-4 shadow-lg transition-opacity duration-150 data-ending-style:opacity-0 data-limited:hidden data-starting-style:opacity-0 motion-reduce:transition-none"
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
