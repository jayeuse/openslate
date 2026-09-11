"use client";
import { useId, type ReactNode, type InputHTMLAttributes } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export function Field({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="grid gap-2 text-sm font-medium">
      {label}
      <Input className="min-h-11" {...props} />
    </label>
  );
}
export function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="grid gap-2 text-sm font-medium">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="border-input bg-background focus-visible:outline-ring min-h-11 w-full rounded-md border px-3 text-sm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
}
export function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="hover:bg-muted flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 text-sm">
      <input
        type="checkbox"
        className="accent-foreground size-4"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}
export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {description && (
          <p className="text-muted-foreground mt-1 text-sm">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}
export function Editor({
  title,
  open,
  onClose,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent className="max-sm:fixed max-sm:inset-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:max-w-none max-sm:rounded-none sm:max-w-xl">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription className="mt-2 mb-6">
          Sample changes stay in this tab.
        </DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  );
}
export function Actions({
  onCancel,
  save = "Save changes",
}: {
  onCancel: () => void;
  save?: string;
}) {
  return (
    <div className="mt-6 flex flex-wrap justify-end gap-2 border-t pt-4">
      <Button
        type="button"
        className="min-h-11"
        variant="outline"
        onClick={onCancel}
      >
        Cancel
      </Button>
      <Button type="submit" className="min-h-11">
        {save}
      </Button>
    </div>
  );
}
export function Tabs({
  names,
  current,
  set,
}: {
  names: string[];
  current: string;
  set: (name: string) => void;
}) {
  return (
    <nav
      aria-label="Section navigation"
      className="mb-7 flex flex-wrap gap-1 border-b pb-3"
    >
      {names.map((name) => (
        <Button
          key={name}
          aria-current={current === name ? "page" : undefined}
          variant={current === name ? "secondary" : "ghost"}
          className="min-h-11"
          onClick={() => set(name)}
        >
          {name}
        </Button>
      ))}
    </nav>
  );
}
