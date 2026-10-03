import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

type BundleStats = {
  hasErrors: () => boolean;
  toString: (options: object) => string;
};
type Compiler = { close: (done: (error?: Error) => void) => void };
type Compile = (
  configuration: object,
  done: (error?: Error, stats?: BundleStats) => void,
) => Compiler;
const load = createRequire(path.join(process.cwd(), "package.json"));
const { webpack } = load("next/dist/compiled/webpack/webpack") as {
  webpack: Compile;
};
let fixtureBundle: Promise<string> | undefined;

// The existing stack supplies the compiler. This is a browser-only primitive
// test fixture, with no product route, dependency, or application config.
export function alertDialogFixtureBundle() {
  fixtureBundle ??= compileFixture();
  return fixtureBundle;
}

async function compileFixture() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "openslate-alert-dialog-"),
  );
  const loader = path.join(directory, "typescript-loader.cjs");
  await writeFile(
    loader,
    `const ts = require(${JSON.stringify(load.resolve("typescript"))});
module.exports = (source) => ts.transpileModule(source, { compilerOptions: {
  jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022
} }).outputText;`,
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const compiler = webpack(
        {
          mode: "development",
          context: process.cwd(),
          entry: path.join(
            process.cwd(),
            "tests/http/helpers/alert-dialog-fixture.tsx",
          ),
          target: "web",
          devtool: false,
          output: { path: directory, filename: "fixture.js", publicPath: "" },
          resolve: {
            alias: { "@": path.join(process.cwd(), "src") },
            extensions: [".tsx", ".ts", ".js"],
          },
          module: {
            rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: loader }],
          },
          optimization: { minimize: false },
        },
        (error, stats) => {
          compiler.close((closeError) => {
            if (error || closeError) reject(error ?? closeError);
            else if (!stats || stats.hasErrors())
              reject(
                new Error(
                  stats?.toString({ all: false, errors: true }) ??
                    "Fixture compilation failed",
                ),
              );
            else resolve();
          });
        },
      );
    });
    return await readFile(path.join(directory, "fixture.js"), "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
