"use client";
import { useWorkspace } from "@/components/workspace-provider";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { FileList } from "./file-list";
export function RecordAttachments({
  recordId,
  isRecordClosed,
}: {
  recordId: string;
  isRecordClosed: boolean;
}) {
  const { can } = useWorkspace();
  const canRead = can("records.read");
  const canWrite = can("records.write");
  if (!canRead && !canWrite) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Attachments</CardTitle>
        <CardDescription>
          Private documents associated with this record.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FileList
          key={recordId}
          purpose="record_attachment"
          recordId={recordId}
          canRead={canRead}
          canWrite={canWrite}
          isParentClosed={isRecordClosed}
        />
      </CardContent>
    </Card>
  );
}
