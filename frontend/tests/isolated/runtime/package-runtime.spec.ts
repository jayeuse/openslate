import { expect, test } from "@playwright/test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stageRuntime } from "../../../scripts/package-runtime.cjs";

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "openslate-runtime-package-test-"));
}

function write(path: string, contents = "fixture"): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

test("stages a native standalone build without unrelated build output", () => {
  const directory = fixture();
  try {
    const source = join(directory, "frontend");
    const staging = join(directory, "staging");
    write(join(source, ".next/standalone/server.js"), "native server");
    write(join(source, ".next/static/chunk.js"), "static");
    write(join(source, ".next/cache/large.bin"), "not retained");
    write(join(source, "public/icon.svg"), "icon");

    stageRuntime({ mode: "native", source, staging });

    expect(
      readFileSync(join(staging, ".next/standalone/server.js"), "utf8"),
    ).toBe("native server");
    expect(existsSync(join(staging, ".next/static/chunk.js"))).toBe(true);
    expect(existsSync(join(staging, "public/icon.svg"))).toBe(true);
    expect(existsSync(join(staging, ".next/cache"))).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("normalizes a container root without duplicating static or public assets", () => {
  const directory = fixture();
  try {
    const source = join(directory, "container-root");
    const staging = join(directory, "staging");
    write(join(source, "server.js"), "container server");
    write(join(source, ".next/static/chunk.js"), "static");
    write(join(source, "public/icon.svg"), "icon");
    write(join(source, "node_modules/runtime/index.js"), "runtime");

    stageRuntime({ mode: "container", source, staging });

    expect(
      readFileSync(join(staging, ".next/standalone/server.js"), "utf8"),
    ).toBe("container server");
    expect(
      existsSync(
        join(staging, ".next/standalone/node_modules/runtime/index.js"),
      ),
    ).toBe(true);
    expect(existsSync(join(staging, ".next/static/chunk.js"))).toBe(true);
    expect(existsSync(join(staging, "public/icon.svg"))).toBe(true);
    expect(existsSync(join(staging, ".next/standalone/.next/static"))).toBe(
      false,
    );
    expect(existsSync(join(staging, ".next/standalone/public"))).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects symbolic links before creating a distributable runtime", () => {
  const directory = fixture();
  try {
    const source = join(directory, "frontend");
    write(join(source, ".next/standalone/server.js"), "native server");
    write(join(source, ".next/static/chunk.js"), "static");
    symlinkSync(
      join(source, ".next/standalone/server.js"),
      join(source, ".next/standalone/server-link.js"),
    );

    expect(() =>
      stageRuntime({
        mode: "native",
        source,
        staging: join(directory, "staging"),
      }),
    ).toThrow(/symbolic link/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
