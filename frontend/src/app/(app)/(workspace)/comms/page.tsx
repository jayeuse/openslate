import type { Metadata } from "next";
import CommsScreen from "@/components/systems/comms/page";

export const metadata: Metadata = { title: "OpenComms" };

export default function CommsPage() {
  return <CommsScreen />;
}
