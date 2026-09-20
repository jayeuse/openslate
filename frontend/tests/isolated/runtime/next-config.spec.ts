import { expect, test } from "@playwright/test";

import nextConfig from "../../../next.config";
import { syntheticEnvironment } from "../../../playwright.config";

test("development proxy preserves the backend upload size contract", () => {
  expect(nextConfig.experimental?.proxyClientMaxBodySize).toBe("25mb");
});

test("synthetic test server cannot route API traffic to a local backend", () => {
  expect(syntheticEnvironment.BACKEND_URL).toBe("http://backend.invalid");
});
