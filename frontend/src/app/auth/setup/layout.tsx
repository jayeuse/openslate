import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Set up your account" };

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
