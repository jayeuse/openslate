/* eslint-disable @typescript-eslint/no-require-imports -- Synchronous Node --require preload. */
// Capture executed JavaScript, not the TypeScript file at the same URL.
const inspector = require("node:inspector");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const v8 = require("node:v8");
const directory = process.env.NODE_V8_COVERAGE;
if (directory) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, `process-${process.pid}.json`),
    JSON.stringify({ entrypoint: process.argv[1] }),
  );
  const session = new inspector.Session();
  session.connect();
  session.on("Debugger.scriptParsed", ({ params }) => {
    if (
      !params.url.includes("/src/") ||
      params.url.includes("node_modules") ||
      params.url.startsWith("about:")
    )
      return;
    session.post(
      "Debugger.getScriptSource",
      { scriptId: params.scriptId },
      (error, result) => {
        if (error) throw error;
        const source = result.scriptSource;
        const sourceHash = crypto
          .createHash("sha256")
          .update(source)
          .digest("hex");
        const sourcePath = path.join(directory, `source-${sourceHash}.json`);
        try {
          fs.writeFileSync(sourcePath, JSON.stringify({ sourceHash, source }), {
            flag: "wx",
          });
        } catch (writeError) {
          if (writeError.code !== "EEXIST") throw writeError;
        }
        const scriptId = crypto
          .createHash("sha1")
          .update(String(params.scriptId))
          .digest("hex");
        fs.writeFileSync(
          path.join(directory, `script-${process.pid}-${scriptId}.json`),
          JSON.stringify({
            url: params.url,
            sourceHash,
            pid: process.pid,
            scriptId: params.scriptId,
          }),
        );
      },
    );
  });
  session.post("Debugger.enable");
  setInterval(() => {
    if (!fs.existsSync(path.join(directory, "flush-request"))) return;
    const acknowledged = path.join(directory, `flushed-${process.pid}`);
    if (fs.existsSync(acknowledged)) return;
    v8.takeCoverage();
    fs.writeFileSync(acknowledged, "complete");
  }, 50).unref();
  process.on("exit", () => v8.takeCoverage());
  // Playwright terminates its owned Next server with SIGTERM.
  process.on("SIGTERM", () => {
    v8.takeCoverage();
    process.exit(0);
  });
}
