import type { Metadata } from "next";
import BoardsRoute from "@/components/systems/boards/page";

export const metadata: Metadata = { title: "Boards" };

export default function BoardsPage() {
  return <BoardsRoute />;
}
