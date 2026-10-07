import type { Metadata } from "next";
import SandboxRoute from "@/components/systems/sandbox/page";

export const metadata: Metadata = { title: "Sandbox" };

export default function SandboxPage() {
  return <SandboxRoute />;
}
