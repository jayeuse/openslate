import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";

import { expect, test } from "@playwright/test";

type BrowserCrypto = {
  getRandomValues: (values: Uint8Array) => Uint8Array;
  randomUUID?: () => string;
};

function runBrowserBootstrap(crypto: BrowserCrypto): void {
  const root = {
    classList: { toggle: () => undefined },
    dataset: {},
  };
  const context = createContext({
    crypto,
    document: { documentElement: root },
    localStorage: { getItem: () => null },
  });
  const source = readFileSync(
    resolve(process.cwd(), "public", "theme-init.js"),
    "utf8",
  );

  runInContext(source, context);
}

test("browser bootstrap supplies RFC 4122 UUIDs when HTTP lacks randomUUID", () => {
  let calls = 0;
  const crypto: BrowserCrypto = {
    getRandomValues(values) {
      calls += 1;
      for (let index = 0; index < values.length; index += 1) {
        values[index] = calls * 17 + index;
      }
      return values;
    },
  };

  runBrowserBootstrap(crypto);

  const first = crypto.randomUUID?.();
  const second = crypto.randomUUID?.();

  expect(first).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(second).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(second).not.toBe(first);
  expect(calls).toBe(2);
});

test("browser bootstrap keeps the browser's native randomUUID", () => {
  const nativeRandomUUID = () => "native-browser-uuid";
  const crypto: BrowserCrypto = {
    getRandomValues(values) {
      return values;
    },
    randomUUID: nativeRandomUUID,
  };

  runBrowserBootstrap(crypto);

  expect(crypto.randomUUID).toBe(nativeRandomUUID);
});
