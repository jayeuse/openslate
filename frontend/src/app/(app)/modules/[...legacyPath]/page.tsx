import { redirect } from "next/navigation";

export default async function RetiredWorkspacePage({
  params,
}: {
  params: Promise<{ legacyPath: string[] }>;
}) {
  const { legacyPath } = await params;
  redirect(legacyPath.at(-1) === "schema" ? "/sandbox" : "/openview");
}
