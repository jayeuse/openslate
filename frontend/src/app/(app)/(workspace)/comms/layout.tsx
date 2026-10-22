import type { ReactNode } from "react";
import { CommsClientProvider } from "@/components/systems/comms/state/client-context";

export default function CommsLayout({ children }: { children: ReactNode }) {
  return <CommsClientProvider>{children}</CommsClientProvider>;
}
