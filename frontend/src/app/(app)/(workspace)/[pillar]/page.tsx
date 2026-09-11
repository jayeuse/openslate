import { notFound } from "next/navigation";
import SampleAccess from "@/components/sample/access";
import SampleManage from "@/components/sample/manage";
import SampleComms from "@/components/sample/comms";
import SamplePlatform from "@/components/sample/platform";
import SampleSandbox from "@/components/sample/sandbox";
import SampleOpenView from "@/components/sample/openview";
import SampleBoards from "@/components/sample/boards";
const names: Record<string, string> = {
  sandbox: "Organization Designer",
  openview: "Service requests",
  boards: "Boards",
  access: "Access",
  manage: "Manage",
  comms: "OpenComms",
  platform: "Workspace tools",
};
export default async function SamplePillar({
  params,
}: {
  params: Promise<{ pillar: string }>;
}) {
  const { pillar } = await params;
  if (!Object.hasOwn(names, pillar)) notFound();
  if (pillar === "access") return <SampleAccess />;
  if (pillar === "manage") return <SampleManage />;
  if (pillar === "comms") return <SampleComms />;
  if (pillar === "platform") return <SamplePlatform />;
  if (pillar === "sandbox") return <SampleSandbox />;
  if (pillar === "openview") return <SampleOpenView />;
  if (pillar === "boards") return <SampleBoards />;
  return <h1 className="text-2xl font-semibold">{names[pillar]}</h1>;
}
