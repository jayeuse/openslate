import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function compactId(id: string) {
  return `${id.slice(0, 8)}…${id.slice(-8)}`;
}

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
