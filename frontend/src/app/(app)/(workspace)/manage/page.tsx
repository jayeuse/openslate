import type { Metadata } from "next";
import SampleManage from "@/components/systems/manage/page";

export const metadata: Metadata = { title: "Manage" };

export default function ManagePage() {
  return <SampleManage />;
}
