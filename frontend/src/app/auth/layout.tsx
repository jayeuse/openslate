import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { referrer: "no-referrer" };

export default function AuthLayout({ children }: { children: ReactNode }) {
  return children;
}
