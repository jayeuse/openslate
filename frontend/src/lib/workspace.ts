import { z } from "zod";
import { CAPABILITIES } from "./api";

export const workspaceSchema = z.object({
  id: z.union([z.number(), z.string()]),
  display_name: z.string().min(1),
  legal_name: z.string().nullable(),
  description: z.string().nullable(),
  contact_email: z.string().nullable(),
  contact_phone: z.string().nullable(),
  postal_address: z.string().nullable(),
  timezone: z.string(),
  locale: z.string(),
  revision: z.number().int(),
  logo_file_id: z.string().nullable(),
});
export type WorkspaceProfile = z.infer<typeof workspaceSchema>;
export const currentUserSchema = z.object({
  id: z.string(),
  role: z.string(),
  permissions: z.array(z.enum(CAPABILITIES)),
});
export type CurrentUser = z.infer<typeof currentUserSchema>;
export function canNavigate(user: CurrentUser, href: string): boolean {
  if (
    href.startsWith("/administration") ||
    href === "/settings/workspace" ||
    href === "/files"
  )
    return user.role === "admin";
  if (href.startsWith("/departments"))
    return user.permissions.includes("departments.read");
  if (href.startsWith("/views"))
    return user.permissions.includes("records.read");
  return true;
}
