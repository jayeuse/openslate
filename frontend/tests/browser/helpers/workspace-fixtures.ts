import type { Route } from "@playwright/test";
import { CAPABILITIES } from "../../../src/lib/api";

export async function fulfillWorkspaceRequest(route: Route): Promise<boolean> {
  const path = new URL(route.request().url()).pathname;
  if (path === "/bff/auth/me") {
    await route.fulfill({
      json: {
        id: "11111111-1111-4111-8111-111111111111",
        role: "admin",
        permissions: [...CAPABILITIES],
      },
    });
    return true;
  }
  if (path === "/bff/workspace") {
    await route.fulfill({
      json: {
        id: 1,
        display_name: "OpenSlate",
        legal_name: null,
        description: null,
        contact_email: null,
        contact_phone: null,
        postal_address: null,
        timezone: "UTC",
        locale: "en-US",
        revision: 1,
        logo_file_id: null,
      },
    });
    return true;
  }
  return false;
}
