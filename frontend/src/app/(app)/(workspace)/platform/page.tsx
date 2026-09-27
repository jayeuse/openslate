import type { Metadata } from "next";
import SamplePlatform from "@/components/systems/platform/page";

export const metadata: Metadata = { title: "Platform" };

export default function PlatformPage() {
  return <SamplePlatform />;
}
