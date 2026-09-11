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
  attachmentUrls.delete(id);
  if (url) URL.revokeObjectURL(url);
}

export function releaseAllLocalAttachments(): void {
  const urls = [...attachmentUrls.values()];
  attachmentUrls.clear();
  for (const url of urls) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Continue revoking the remaining in-memory attachments during sign out.
    }
  }
}
