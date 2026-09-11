// File contents stay in this tab's memory. Only attachment metadata is saved.
const attachmentUrls = new Map<string, string>();

export function cacheLocalAttachment(id: string, file: File): string {
  releaseLocalAttachment(id);
  const url = URL.createObjectURL(file);
  attachmentUrls.set(id, url);
  return url;
}

export function localAttachmentUrl(id: string): string | undefined {
  return attachmentUrls.get(id);
}

export function releaseLocalAttachment(id: string): void {
  const url = attachmentUrls.get(id);
  if (url) URL.revokeObjectURL(url);
  attachmentUrls.delete(id);
}
