import type { ReactNode } from "react";

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="text-sm font-semibold">{children}</h2>;
}
