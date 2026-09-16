import { notFound } from "next/navigation";

export default async function SamplePillar({
  params,
}: {
  params: Promise<{ pillar: string }>;
}) {
  await params;
  notFound();
}
