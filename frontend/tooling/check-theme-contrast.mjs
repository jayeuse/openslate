// Fails when a theme token pair in globals.css drops below WCAG AA contrast.
import { readFileSync } from "node:fs";

const css = readFileSync(
  new URL("../src/app/globals.css", import.meta.url),
  "utf8",
);

// Text pairs need 4.5:1; focus rings and control borders need 3:1.
const PAIRS = [
  ["foreground", "background", 4.5],
  ["foreground", "card", 4.5],
  ["muted-foreground", "background", 4.5],
  ["muted-foreground", "card", 4.5],
  ["muted-foreground", "muted", 4.5],
  ["primary-foreground", "primary", 4.5],
  ["primary", "card", 4.5],
  ["secondary-foreground", "secondary", 4.5],
  ["accent-foreground", "accent", 4.5],
  ["destructive", "card", 4.5],
  ["destructive-foreground", "destructive", 4.5],
  ["success", "card", 4.5],
  ["warning", "card", 4.5],
  ["action-text", "action-tint", 4.5],
  ["flow-text", "flow-tint", 4.5],
  ["warn-text", "warn-tint", 4.5],
  ["danger-text", "danger-tint", 4.5],
  ["danger-text", "card", 4.5],
  ["flow-text", "card", 4.5],
  ["action-text", "card", 4.5],
  ["sidebar-foreground", "sidebar", 4.5],
  ["sidebar-muted", "sidebar", 4.5],
  ["sidebar-foreground", "sidebar-accent", 4.5],
  ["input", "card", 3],
  ["input", "background", 3],
  ["ring", "background", 3],
  ["ring", "card", 3],
];

function block(selector) {
  const start = css.search(new RegExp(`^${selector} \\{`, "m"));
  if (start === -1) throw new Error(`Missing ${selector} block in globals.css`);
  return css.slice(start, css.indexOf("\n}", start));
}

function declarations(text) {
  return Object.fromEntries(
    [...text.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [
      m[1],
      m[2].trim(),
    ]),
  );
}

function resolve(tokens, name, seen = new Set()) {
  if (seen.has(name)) throw new Error(`Circular token --${name}`);
  seen.add(name);
  const value = tokens[name];
  if (value === undefined) throw new Error(`Missing token --${name}`);
  const alias = value.match(/^var\(--([\w-]+)\)$/);
  return alias ? resolve(tokens, alias[1], seen) : value;
}

function luminance(hex) {
  const match = hex.match(/^#([0-9a-f]{6})$/i);
  if (!match) throw new Error(`Expected a 6-digit hex color, got ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(match[1].slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const light = declarations(block(":root"));
const modes = { light, dark: { ...light, ...declarations(block(".dark")) } };

let failures = 0;
for (const [mode, tokens] of Object.entries(modes)) {
  for (const [fg, bg, minimum] of PAIRS) {
    const ratio = contrast(resolve(tokens, fg), resolve(tokens, bg));
    const ok = ratio >= minimum;
    if (!ok) failures += 1;
    if (!ok || process.argv.includes("--verbose")) {
      console.log(
        `${ok ? "ok  " : "FAIL"} ${mode.padEnd(5)} --${fg} on --${bg}: ${ratio.toFixed(2)} (needs ${minimum})`,
      );
    }
  }
}

if (failures > 0) {
  console.error(`${failures} theme contrast pair(s) below WCAG AA.`);
  process.exit(1);
}
console.log("Theme contrast: all token pairs meet WCAG AA.");
