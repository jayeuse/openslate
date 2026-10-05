import type { Metadata } from "next";
import Platform from "@/components/systems/platform/page";

export const metadata: Metadata = { title: "Platform" };

export default function PlatformPage() {
  return <Platform />;
}
