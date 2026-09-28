import { spawn } from "node:child_process";

const layer = process.env.TEST_LAYER;
const baseUrl = process.env.BASE_URL;
const configurationMode = process.env.PLAYWRIGHT_CONFIGURATION;
if (!layer || !["all", "isolated", "http"].includes(layer))
  throw new Error("TEST_LAYER must be all, isolated, or http");
if (!baseUrl) throw new Error("BASE_URL is required");
if (!configurationMode || !["synthetic", "process"].includes(configurationMode))
  throw new Error("PLAYWRIGHT_CONFIGURATION must be synthetic or process");

function selectsOnlyIsolatedProject(arguments_) {
  const projects = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (
      argument === "--" ||
      argument === "-c" ||
      /^-c.+/.test(argument) ||
      argument === "--config" ||
      argument.startsWith("--config=") ||
      argument.startsWith("-c=")
    )
      return false;
    if (argument === "--project") {
      const project = arguments_[index + 1];
      if (!project || project.startsWith("-")) return false;
      projects.push(project);
      index += 1;
      while (
        index + 1 < arguments_.length &&
        !arguments_[index + 1].startsWith("-")
      ) {
        projects.push(arguments_[index + 1]);
        index += 1;
      }
    } else if (argument.startsWith("--project=")) {
      projects.push(argument.slice("--project=".length));
    }
  }
  return projects.length === 1 && projects[0] === "isolated";
}

const arguments_ = process.argv.slice(2);
const environment =
  layer === "all" && selectsOnlyIsolatedProject(arguments_)
    ? { ...process.env, TEST_LAYER: "isolated" }
    : process.env;
const playwright = spawn(
  process.execPath,
  ["node_modules/@playwright/test/cli.js", "test", ...arguments_],
  { env: environment, stdio: "inherit" },
);
playwright.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
