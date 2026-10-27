// Fails when a theme token pair drops below WCAG AA contrast, in light or
// dark, for Slate (globals.css) and each organization theme (themes/*.css).
import { readFileSync } from "node:fs";

const read = (path) =>
  readFileSync(new URL(`../src/app/${path}`, import.meta.url), "utf8");
const THEMES = ["whiteboard", "triplicate", "stockroom"];

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
  // Triplicate draws chips without a tint, so warning ink sits on the card.
  ["warn-text", "card", 4.5],
  ["warn-text", "background", 4.5],
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
  // Canvas skin: table text, type labels, department heads, line labels.
  ["canvas-module-ink", "canvas-module-fill", 4.5],
  ["canvas-type-ink", "canvas-module-fill", 4.5],
  ["canvas-type-ink", "canvas-row-stripe", 4.5],
  ["canvas-label-ink", "canvas-label-fill", 4.5],
  ["canvas-field-ink", "canvas-row-stripe", 4.5],
  // Rows a Test run changed take the action tint on the canvas.
  ["canvas-field-ink", "action-tint", 4.5],
  ["canvas-type-ink", "action-tint", 4.5],
  ["data-ink", "card", 4.5],
  ["data-ink", "background", 4.5],
  ["button-ink", "card", 4.5],
  ...[1, 2, 3, 4].flatMap((n) => [
    ["canvas-module-ink", `dept-${n}-card`, 4.5],
    ["canvas-dept-ink", `dept-${n}-band`, 4.5],
    ["canvas-dept-name", `dept-${n}-band`, 4.5],
    ["canvas-field-ink", `dept-${n}-module`, 4.5],
    ["canvas-type-ink", `dept-${n}-module`, 4.5],
    ["canvas-field-ink", `dept-${n}-stripe`, 4.5],
    ["canvas-type-ink", `dept-${n}-stripe`, 4.5],
  ]),
];

// Each block ends its selector list with the preview selector, for example
// `.dark [data-theme-preview="triplicate"] {`.
function block(css, file, selector) {
  const line = `${selector} {`;
  const start = css.split("\n").findIndex((text) => text === line);
  if (start === -1) throw new Error(`Missing ${line} in ${file}`);
  const offset = css.split("\n").slice(0, start).join("\n").length;
  return css.slice(offset, css.indexOf("\n}", offset));
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

const globals = read("globals.css");
const slateLight = declarations(
  block(globals, "globals.css", '[data-theme-preview="slate"]'),
);
const slateDark = declarations(
  block(globals, "globals.css", '.dark [data-theme-preview="slate"]'),
);
const modes = {
  "slate light": slateLight,
  "slate dark": { ...slateLight, ...slateDark },
};

let failures = 0;
for (const theme of THEMES) {
  const file = `themes/${theme}.css`;
  const css = read(file);
  const light = declarations(
    block(css, file, `[data-theme-preview="${theme}"]`),
  );
  const dark = declarations(
    block(css, file, `.dark [data-theme-preview="${theme}"]`),
  );
  // The light block outranks Slate's .dark block, so a token missing from
  // the theme's dark block would show its light value in dark mode.
  for (const name of Object.keys(light)) {
    if (name in dark) continue;
    failures += 1;
    console.log(`FAIL ${theme} dark does not set --${name}`);
  }
  modes[`${theme} light`] = { ...slateLight, ...light };
  modes[`${theme} dark`] = { ...slateLight, ...slateDark, ...light, ...dark };
}

function hue(hex) {
  const [r, g, b] = [0, 2, 4].map(
    (i) => parseInt(hex.slice(1 + i, 3 + i), 16) / 255,
  );
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  if (delta === 0) return 0;
  const h =
    max === r
      ? ((g - b) / delta) % 6
      : max === g
        ? (b - r) / delta + 2
        : (r - g) / delta + 4;
  return (h * 60 + 360) % 360;
}

// Signal law: warn and danger need distinct hues, and the action color must
// stand apart from body text so links and buttons read as actions.
function signalFailures(mode, tokens) {
  const found = [];
  const warn = hue(resolve(tokens, "warn"));
  const danger = hue(resolve(tokens, "danger"));
  const distance = Math.min(
    Math.abs(warn - danger),
    360 - Math.abs(warn - danger),
  );
  if (distance < 30)
    found.push(
      `${mode} --warn and --danger hues are ${distance.toFixed(0)}° apart (needs 30)`,
    );
  const separation = contrast(
    resolve(tokens, "action"),
    resolve(tokens, "ink"),
  );
  if (separation < 1.5)
    found.push(
      `${mode} --action is too close to --ink: ${separation.toFixed(2)} (needs 1.5)`,
    );
  return found;
}

for (const [mode, tokens] of Object.entries(modes)) {
  for (const failure of signalFailures(mode, tokens)) {
    failures += 1;
    console.log(`FAIL ${failure}`);
  }
  for (const [fg, bg, minimum] of PAIRS) {
    const ratio = contrast(resolve(tokens, fg), resolve(tokens, bg));
    const ok = ratio >= minimum;
    if (!ok) failures += 1;
    if (!ok || process.argv.includes("--verbose")) {
      console.log(
        `${ok ? "ok  " : "FAIL"} ${mode.padEnd(16)} --${fg} on --${bg}: ${ratio.toFixed(2)} (needs ${minimum})`,
      );
    }
  }
}

// Calendar tints (Boards): `color-mix(in oklab, <calendar> p%, var(--card))`
// behind text. The calendar is a department mark or neutral ink-muted.
// Week blocks: muted time and place on the 22% fill. Month pills and
// all-day bars: ink on the 32% fill and its 42% hover.
function toLinear(channel) {
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}
function fromLinear(channel) {
  const value =
    channel <= 0.0031308
      ? channel * 12.92
      : 1.055 * channel ** (1 / 2.4) - 0.055;
  return Math.min(1, Math.max(0, value));
}
function toOklab(hex) {
  const [r, g, b] = [0, 2, 4].map((i) =>
    toLinear(parseInt(hex.slice(1 + i, 3 + i), 16) / 255),
  );
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
function fromOklab([L, A, B]) {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return `#${rgb
    .map((channel) =>
      Math.round(fromLinear(channel) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}
/** `color-mix(in oklab, a <percent>%, b)` for opaque hex colors. */
function mixOklab(a, percent, b) {
  const [x, y] = [toOklab(a), toOklab(b)];
  const t = percent / 100;
  return fromOklab(x.map((value, index) => value * t + y[index] * (1 - t)));
}

const CALENDAR_TINTS = [
  ["muted-foreground", 22],
  ["foreground", 32],
  ["foreground", 42],
];
const CALENDARS = ["dept-1", "dept-2", "dept-3", "dept-4", "ink-muted"];
const lowest = new Map();
for (const [mode, tokens] of Object.entries(modes)) {
  for (const calendar of CALENDARS)
    for (const [fg, percent] of CALENDAR_TINTS) {
      const fill = mixOklab(
        resolve(tokens, calendar),
        percent,
        resolve(tokens, "card"),
      );
      const ratio = contrast(resolve(tokens, fg), fill);
      const pair = `--${fg} on --${calendar} ${percent}% over --card`;
      const known = lowest.get(`${fg} ${percent}`);
      if (!known || ratio < known.ratio)
        lowest.set(`${fg} ${percent}`, { ratio, mode, pair });
      const ok = ratio >= 4.5;
      if (!ok) failures += 1;
      if (!ok || process.argv.includes("--verbose"))
        console.log(
          `${ok ? "ok  " : "FAIL"} ${mode.padEnd(16)} ${pair}: ${ratio.toFixed(2)} (needs 4.5)`,
        );
    }
}
if (process.argv.includes("--verbose"))
  for (const { ratio, mode, pair } of lowest.values())
    console.log(`lowest ${pair}: ${ratio.toFixed(2)} (${mode})`);

if (failures > 0) {
  console.error(`${failures} theme check(s) failed.`);
  process.exit(1);
}
console.log(
  `Theme contrast: all token pairs meet WCAG AA in ${Object.keys(modes).length} theme modes.`,
);
