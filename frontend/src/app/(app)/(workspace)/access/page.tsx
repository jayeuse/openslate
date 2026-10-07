import type { Metadata } from "next";
import Access from "@/components/systems/access/page";

export const metadata: Metadata = { title: "Access" };

export default function AccessPage() {
  return <Access />;
}
