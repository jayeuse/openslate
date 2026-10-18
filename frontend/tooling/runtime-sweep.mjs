// Visits the workspace of a running local development stack in a real browser
// and fails on runtime errors: uncaught page errors, console errors, and the
// Next.js dev "Issue" badge. It signs in, follows every sidebar link, opens
// each tab, selects a Sandbox department, module, and field, and cycles that
// field through every type and back. It never saves, so it changes no data.
//
// Run it on demand after seeding or a large UI change, not in the gate:
//   npm run sweep -- --credentials /absolute/path/credentials.json
// The file is owner-only JSON {"email": "...", "password": "..."} for an
// account on the local stack (the format of the sample seeder's admin file).
// An administrator account also reaches the Sandbox designer.
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { chromium } from "playwright";

function fail(message) {
  console.error(message);
  process.exit(2);
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const credentialsPath = option("--credentials");
if (!credentialsPath || !isAbsolute(credentialsPath))
  fail("Pass --credentials with the absolute path of a credentials file.");
if (process.platform !== "win32" && statSync(credentialsPath).mode & 0o077)
  fail("The credentials file must be owner-only (chmod 600).");
const { email, password } = JSON.parse(readFileSync(credentialsPath, "utf8"));
if (typeof email !== "string" || typeof password !== "string")
  fail("The credentials file needs an email and a password.");

const origin = new URL(
  option(
    "--origin",
    `http://localhost:${process.env.FRONTEND_DEV_PORT ?? 3000}`,
  ),
);
// The sweep signs in and clicks through an installation; only a local one.
if (!["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
  fail("The sweep runs only against a local development origin.");

const problems = [];
let step = "sign in";
let issueCount = 0;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (error) =>
  problems.push({ step, kind: "page error", text: error.message }),
);
// The sweep never saves, so leaving a page may discard a local draft only.
page.on("dialog", (dialog) => dialog.accept());
page.on("console", (message) => {
  if (message.type() !== "error") return;
  const text = message.text();
  // A refused refresh or a missing optional resource is an HTTP status the
  // app handles, not a runtime error.
  if (text.startsWith("Failed to load resource")) return;
  problems.push({ step, kind: "console error", text });
});

async function settle() {
  await page.waitForLoadState("load");
  await page.waitForTimeout(1200);
  // The dev overlay counts every runtime error the page has shown.
  const count = await page.evaluate(() => {
    const text =
      document.querySelector("nextjs-portal")?.shadowRoot?.textContent;
    const match = text?.match(/(\d+)\s+Issues?/);
    return match ? Number(match[1]) : 0;
  });
  if (count > issueCount)
    problems.push({
      step,
      kind: "Next.js issue badge",
      text: `${count - issueCount} new issue(s)`,
    });
  issueCount = Math.max(issueCount, count);
}

async function openTabs() {
  const tabs = page.locator('main [role="tab"]');
  for (let index = 0; index < (await tabs.count()); index += 1) {
    const tab = tabs.nth(index);
    if (!(await tab.isVisible()) || (await tab.isDisabled())) continue;
    step = `${new URL(page.url()).pathname} tab "${(await tab.innerText()).trim()}"`;
    await tab.click();
    await settle();
  }
}

async function sweepSandboxDesigner() {
  const structure = page.getByRole("tab", { name: "Structure", exact: true });
  if (!(await structure.isVisible())) return;
  await structure.click();
  const inspector = page.locator('[aria-label="Design inspector"]');
  const typeSelect = inspector.locator('select[id$="-type"]');
  for (const kind of ["department", "module", "field"]) {
    const item = page.locator(`button[aria-label^="Select ${kind} "]`).first();
    if (!(await item.count())) continue;
    step = `Sandbox select ${kind}`;
    if (kind !== "department") await structure.click();
    await item.click();
    await settle();
  }
  // Changing the open field's type renders every settings branch, the same
  // as selecting a field of each type.
  if (!(await typeSelect.count())) return;
  const original = await typeSelect.inputValue();
  const options = await typeSelect
    .locator("option")
    .evaluateAll((items) => items.map((item) => item.value));
  for (const value of options) {
    step = `Sandbox field type ${value} (not saved)`;
    await typeSelect.selectOption(value);
    await settle();
  }
  await typeSelect.selectOption(original);
}

try {
  await page.goto(new URL("/login", origin).href);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 20_000,
  });
  // An account in several organizations first chooses one: --org <name>, or
  // the first in the list.
  const shell = page.locator('nav a[href^="/"]').first();
  const chooser = page.getByRole("heading", { name: "Choose an organization" });
  await shell.or(chooser).waitFor({ timeout: 20_000 });
  if (await chooser.isVisible()) {
    step = "choose organization";
    const wanted = option("--org");
    const choices = page
      .getByRole("button")
      .filter({ hasText: /(Admin|Member|Guest)$/ });
    await (wanted ? choices.filter({ hasText: wanted }) : choices)
      .first()
      .click();
    await shell.waitFor({ timeout: 20_000 });
  }
  await settle();

  const paths = await page.evaluate(() => [
    ...new Set(
      [...document.querySelectorAll('nav a[href^="/"]')].map((link) => {
        const url = new URL(link.href);
        return url.pathname + url.search;
      }),
    ),
  ]);
  for (const path of paths) {
    step = path;
    await page.goto(new URL(path, origin).href);
    await settle();
    await openTabs();
    if (new URL(page.url()).pathname === "/sandbox")
      await sweepSandboxDesigner();
  }
  // A sweep that reached no route proved nothing.
  if (paths.length === 0)
    problems.push({ step, kind: "no routes", text: "No sidebar links found" });
  console.log(`Visited ${paths.length} routes on ${origin.origin}.`);
} catch (error) {
  problems.push({ step, kind: "sweep stopped", text: String(error) });
} finally {
  await browser.close();
}

for (const problem of problems)
  console.log(`FAIL ${problem.step}: ${problem.kind}: ${problem.text}`);
console.log(
  problems.length === 0
    ? "Runtime sweep passed: no runtime errors."
    : `Runtime sweep failed: ${problems.length} problem(s).`,
);
process.exitCode = problems.length === 0 ? 0 : 1;
