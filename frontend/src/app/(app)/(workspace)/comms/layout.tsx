import type { ReactNode } from "react";
import { SampleProvider } from "@/components/systems/shared/runtime/sample-state";
import { CommsClientProvider } from "@/components/systems/comms/state/client-context";

export default function CommsLayout({ children }: { children: ReactNode }) {
  return (
    <SampleProvider>
      <CommsClientProvider>{children}</CommsClientProvider>
    </SampleProvider>
  );
}
