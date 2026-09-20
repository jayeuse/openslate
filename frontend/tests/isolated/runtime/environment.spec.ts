import { expect, test } from "@playwright/test";

import {
  developmentApiRewrites,
  FRONTEND_ENVIRONMENT_KEYS,
  validatePublicEnvironment,
  validateRuntimeEnvironment,
} from "../../../src/lib/environment";

const environment = {
  PORT: "3000",
  HOSTNAME: "127.0.0.1",
  BACKEND_URL: "http://127.0.0.1:8000",
  NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED: "false",
};

test("frontend requires only safe host, API origin, and public settings", () => {
  expect(validateRuntimeEnvironment(environment)).toEqual({
    port: 3000,
    hostname: "127.0.0.1",
  });
  expect(validatePublicEnvironment(environment)).toEqual({
    lifecyclePurgeEnabled: false,
  });
  expect(FRONTEND_ENVIRONMENT_KEYS).toEqual([
    "BACKEND_URL",
    "PORT",
    "HOSTNAME",
    "NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED",
  ]);
});

test("development API requests are rewritten to the configured FastAPI origin", () => {
  expect(
    developmentApiRewrites({ ...environment, NODE_ENV: "development" }),
  ).toEqual([
    {
      source: "/api/:path*",
      destination: "http://127.0.0.1:8000/api/:path*",
    },
  ]);
  expect(
    developmentApiRewrites({ ...environment, NODE_ENV: "production" }),
  ).toEqual([]);
});

test("development API rewrite rejects unsafe backend destinations", () => {
  for (const backendUrl of [
    "ftp://127.0.0.1:8000",
    "http://user:password@127.0.0.1:8000",
    "http://127.0.0.1:8000/path",
  ]) {
    expect(() =>
      developmentApiRewrites({
        ...environment,
        NODE_ENV: "development",
        BACKEND_URL: backendUrl,
      }),
    ).toThrow("BACKEND_URL");
  }
});

test("frontend environment validation does not require service credentials", () => {
  const secretCanary = "must-not-appear-in-errors";
  for (const [name, value] of [
    ["PORT", "0"],
    ["PORT", "65536"],
    ["HOSTNAME", ""],
    ["NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED", "yes"],
  ] as const) {
    const candidate = { ...environment, [name]: value };
    const validate =
      name === "NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED"
        ? validatePublicEnvironment
        : validateRuntimeEnvironment;
    expect(() => validate(candidate)).toThrow(name);
    expect(() => validate(candidate)).not.toThrow(secretCanary);
  }
});
