"use client";
import { Toast } from "@base-ui/react/toast";
import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";
const manager = Toast.createToastManager();
export const toast = {
  add(options: {
    title: string;
    description?: string;
    type: "success" | "error" | "info";
  }) {
    return manager.add({
      ...options,
      priority: options.type === "error" ? "high" : "low",
    });
  },
};
function ToastList() {
  const { toasts } = Toast.useToastManager<Record<string, never>>();
  return (
    <Toast.Portal>
      <Toast.Viewport className="fixed right-4 bottom-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 outline-none">
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
                <Toast.Close
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
