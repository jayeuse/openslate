import type { ReactNode } from "react";
import { SampleProvider } from "@/components/systems/shared/runtime/sample-state";

export default function CommsLayout({ children }: { children: ReactNode }) {
  return <SampleProvider>{children}</SampleProvider>;
}
