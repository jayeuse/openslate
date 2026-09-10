import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

export default async function teardown() {
  const directory = process.env.NODE_V8_COVERAGE;
  if (!directory) throw new Error("Missing Node coverage directory");
  const servers = readdirSync(directory).filter(
    (file) =>
      file.startsWith("process-") &&
      JSON.parse(readFileSync(resolve(directory, file))).entrypoint?.endsWith(
        "next/dist/server/lib/start-server.js",
      ),
  );
  if (!servers.length) throw new Error("Missing owned Next server capture");
  writeFileSync(
    resolve(directory, "flush-request"),
    "flush after completed tests",
  );
  const deadline = Date.now() + 10_000;
  for (const file of servers) {
    const acknowledgement = resolve(
      directory,
      file.replace("process-", "flushed-").replace(".json", ""),
    );
    while (!existsSync(acknowledgement)) {
      if (Date.now() > deadline)
        throw new Error(`Next coverage did not flush: ${file}`);
      await setTimeout(50);
    }
  }
}
