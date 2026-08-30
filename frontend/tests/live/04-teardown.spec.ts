import { test } from "@playwright/test";

import { teardownLiveData } from "./teardown";
import {
  getLiveTeardownEnvironment,
  hasLiveTeardownEnvironment,
} from "./support/preflight";

test.describe("live manifest-owned domain teardown", () => {
  test("purges only the confirmed manifest-owned domain roots", async () => {
    test.skip(
      !hasLiveTeardownEnvironment(),
      "Live teardown requires strict loopback auth, an existing run ID, LIVE_TEARDOWN=domain-purge, and LIFECYCLE_PURGE_ENABLED=true",
    );
    await teardownLiveData(getLiveTeardownEnvironment());
  });
});
