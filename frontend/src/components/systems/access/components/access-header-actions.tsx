"use client";

import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** The page header's action area; the Access frame owns the element. */
export const AccessHeaderSlot = createContext<HTMLElement | null>(null);

/**
 * Puts a view's page actions (Invite person, Create group) in the page
 * header, beside the title. The view keeps their state; only the DOM moves.
 */
export function AccessHeaderActions({ children }: { children: ReactNode }) {
  const slot = useContext(AccessHeaderSlot);
  return slot ? createPortal(children, slot) : null;
}
