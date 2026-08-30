import { test } from "@playwright/test";

import { seedLiveData } from "./seed-data";
import {
  getLiveSeedEnvironment,
  hasLiveSeedEnvironment,
} from "./support/preflight";

test.describe("live bulk API seed", () => {
  test("seeds the requested scale from the confirmed schema manifest", async () => {
    test.skip(
      !hasLiveSeedEnvironment(),
      "Live seed requires explicit loopback API, Supabase, credential, and run-ID environment variables",
    );
    await seedLiveData(getLiveSeedEnvironment());
  });
});
