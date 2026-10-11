import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";

import { UserPreferencesProvider } from "../../../src/components/theme-provider";
import { manageKeys } from "../../../src/components/systems/manage/adapters/manage-queries";
import type { ManageVersion } from "../../../src/components/systems/manage/adapters/backup-api";
import { UpdatesPanel } from "../../../src/components/systems/manage/components/updates-panel";
import { VerifiedWorkspaceIdentityProvider } from "../../../src/components/systems/shared/runtime/workspace-identity";

type Maintenance = ComponentProps<typeof UpdatesPanel>["maintenance"];

export type UpdatesPanelState = {
  version: ManageVersion | null;
  refused?: boolean;
  failed?: boolean;
  pending?: boolean;
};

/**
 * The Updates panel inside the providers the signed-in shell gives it: one
 * account, its query cache with the saved workspace region (en-PH in
 * America/New_York, so dates do not follow the machine's time zone), and its
 * preferences. Only the version read is supplied.
 */
export function UpdatesPanelHarness({ state }: { state: UpdatesPanelState }) {
  const client = new QueryClient();
  client.setQueryData(manageKeys.workspace(), {
    id: "00000000-0000-4000-8000-000000000077",
    display_name: "Riverside Services",
    legal_name: null,
    description: null,
    logo_file_id: null,
    locale: "en-PH",
    timezone: "America/New_York",
    mark: "RS",
    currency: "PHP",
    week_start: "monday",
    business_hours: "09:00–18:00",
    theme: "slate",
    revision: 4,
  });
  const maintenance = {
    acceptedVersion: state.version,
    versionRefused: state.refused ?? false,
    version: {
      isError: state.failed ?? false,
      isPending: state.pending ?? false,
      isFetching: false,
    },
    refreshVersion: async () => undefined,
  } as unknown as Maintenance;
  return (
    <QueryClientProvider client={client}>
      <VerifiedWorkspaceIdentityProvider userId="00000000-0000-4000-8000-000000000001">
        <UserPreferencesProvider>
          <UpdatesPanel maintenance={maintenance} />
        </UserPreferencesProvider>
      </VerifiedWorkspaceIdentityProvider>
    </QueryClientProvider>
  );
}
