import type { Metadata } from "next";
import SampleBoards from "@/components/systems/boards/page";

export const metadata: Metadata = { title: "Boards" };

export default function BoardsPage() {
  return <SampleBoards />;
}
