import type { Metadata } from "next";
import Manage from "@/components/systems/manage/page";

export const metadata: Metadata = { title: "Manage" };

export default function ManagePage() {
  return <Manage />;
}
