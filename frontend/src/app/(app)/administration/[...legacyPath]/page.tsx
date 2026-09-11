import { redirect } from "next/navigation";

export default async function RetiredWorkspacePage({
  params,
}: {
  params: Promise<{ legacyPath: string[] }>;
}) {
  const { legacyPath } = await params;
  redirect(
    legacyPath[0] === "files"
      ? "/platform"
      : legacyPath[0] === "audit"
        ? "/manage"
        : "/access",
  );
}
