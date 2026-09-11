import { redirect } from "next/navigation";

export default async function RetiredWorkspacePage({
  params,
}: {
  params: Promise<{ legacyPath: string[] }>;
}) {
  const { legacyPath } = await params;
  redirect(legacyPath.includes("records") ? "/openview" : "/sandbox");
}
