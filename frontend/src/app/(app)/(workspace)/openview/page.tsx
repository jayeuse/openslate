import type { Metadata } from "next";
import SampleOpenView from "@/components/systems/openview/page";

export const metadata: Metadata = { title: "OpenView" };

export default function OpenViewPage() {
  return <SampleOpenView />;
}
