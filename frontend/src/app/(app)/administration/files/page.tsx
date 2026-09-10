"use client";
import { useWorkspace } from "@/components/workspace-provider";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { FileList } from "@/components/files/file-list";
export default function DocumentLibraryPage() {
  const { isAdmin } = useWorkspace();
  if (!isAdmin)
    return (
      <Alert variant="destructive">
        Only administrators can access the document library.
      </Alert>
    );
  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Document library"
        description="Manage private documents available to administrators."
      />
      <Card>
        <CardHeader>
          <CardTitle>Documents</CardTitle>
          <CardDescription>
            Upload, scan and manage retained documents. Archived files keep
            their private content until explicitly purged.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FileList purpose="library_document" canRead canWrite />
        </CardContent>
      </Card>
    </>
  );
}
