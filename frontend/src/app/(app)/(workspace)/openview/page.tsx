import type { Metadata } from "next";
import OpenView from "@/components/systems/openview/page";

export const metadata: Metadata = { title: "OpenView" };

export default function OpenViewPage() {
  return <OpenView />;
}
