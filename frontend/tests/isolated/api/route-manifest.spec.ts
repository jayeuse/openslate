import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

import {
  discoverFrontendRoutes,
  discoverRoutesInSources,
  manifestDifferences,
  manifestSchemaErrors,
  type FrontendRoute,
} from "./route-manifest-source";

const manifestFile = resolve(process.cwd(), "api-route-manifest.json");

function fixture(source: string) {
  return discoverRoutesInSources([
    {
      file: "frontend/src/components/systems/openview/adapters/fixture-api.ts",
      source,
    },
  ]);
}

function signature(route: FrontendRoute): string {
  return `${route.adapter} ${route.function} ${route.method} ${route.path}`;
}

const sharedPathSource = `
function recordPath(recordId: string): string {
  return \`/records/\${recordId}\`;
}

export function getRecord(recordId: string) {
  return apiFetch(recordPath(recordId), schema);
}

export function listRecordAlias(recordId: string) {
  return getRecord(recordId);
}

export function updateRecord(recordId: string) {
  return apiFetch(recordPath(recordId), schema, { method: "PATCH" });
}
`;

const expectedSharedPathRoutes: FrontendRoute[] = [
  {
    adapter: "frontend/src/components/systems/openview/adapters/fixture-api.ts",
    function: "getRecord",
    method: "GET",
    path: "/api/records/{param}",
  },
  {
    adapter: "frontend/src/components/systems/openview/adapters/fixture-api.ts",
    function: "listRecordAlias",
    method: "GET",
    path: "/api/records/{param}",
  },
  {
    adapter: "frontend/src/components/systems/openview/adapters/fixture-api.ts",
    function: "updateRecord",
    method: "PATCH",
    path: "/api/records/{param}",
  },
];

test("route discovery keeps adapter identity while resolving shared path helpers", () => {
  const result = fixture(sharedPathSource);
  expect(result.diagnostics).toEqual([]);
  expect(result.routes.map(signature)).toEqual(
    expectedSharedPathRoutes.map(signature),
  );
});

test("route discovery admits only the exact private Profile adapter outside systems", () => {
  const adapter = "frontend/src/components/profile/adapters/profile-api.ts";
  const source = `
export function readSelf() { return apiFetch("/auth/me", schema); }
export function saveSelf() { return apiFetch("/auth/me/profile", schema, { method: "PATCH" }); }
export function readAvatar(userId: string) {
  return apiRequest(\`/users/\${encodeURIComponent(userId)}/avatar\`, { cache: "no-store" });
}
`;
  const admitted = discoverRoutesInSources([{ file: adapter, source }]);
  expect(admitted.diagnostics).toEqual([]);
  expect(admitted.routes.map(signature)).toEqual([
    `${adapter} readAvatar GET /api/users/{param}/avatar`,
    `${adapter} readSelf GET /api/auth/me`,
    `${adapter} saveSelf PATCH /api/auth/me/profile`,
  ]);
  for (const file of [
    "frontend/src/components/profile/adapters/unrelated-api.ts",
    "frontend/src/components/unrelated/adapters/profile-api.ts",
  ]) {
    const refused = discoverRoutesInSources([{ file, source }]);
    expect(refused.routes).toEqual([]);
    expect(refused.diagnostics.join("\n")).toContain("unowned request call");
  }
});

test("encoded route segments are parameters while unencoded kinds stay unresolved", () => {
  const encoded = fixture(`
export function retryJob(target: { kind: string; id: string }) {
  const kind = z.string().min(1).parse(target.kind);
  return apiFetch(\`/jobs/\${encodeURIComponent(kind)}/\${target.id}/retry\`, schema, { method: "POST" });
}
`);
  expect(encoded.diagnostics).toEqual([]);
  expect(encoded.routes.map((route) => [route.method, route.path])).toEqual([
    ["POST", "/api/jobs/{param}/{param}/retry"],
  ]);
  const raw = fixture(`
export function retryJob(kind: string, id: string) {
  return apiFetch(\`/jobs/\${kind}/\${id}/retry\`, schema, { method: "POST" });
}
`);
  expect(raw.diagnostics.join("\n")).toContain(
    "unresolved dynamic path interpolation",
  );
  expect(raw.routes).toEqual([]);
});

const untrustedEncoders = [
  [
    "qualified property",
    "",
    "helper: { encodeURIComponent: (value: string) => string }",
    "",
    "helper.encodeURIComponent(kind)",
  ],
  [
    "computed property",
    "",
    "helper: { encodeURIComponent: (value: string) => string }",
    "",
    'helper["encodeURIComponent"](kind)',
  ],
  [
    "parameter alias",
    "",
    "encodeURIComponent: (value: string) => string",
    "",
    "encodeURIComponent(kind)",
  ],
  [
    "destructured parameter",
    "",
    "{ encodeURIComponent }: Encoder",
    "",
    "encodeURIComponent(kind)",
  ],
  [
    "local alias",
    "",
    "encoder: (value: string) => string",
    "const encodeURIComponent = encoder;",
    "encodeURIComponent(kind)",
  ],
  [
    "uninitialized local",
    "",
    "",
    "let encodeURIComponent: (value: string) => string;",
    "encodeURIComponent(kind)",
  ],
  [
    "imported alias",
    'import { encodeURIComponent } from "unknown-encoder";',
    "",
    "",
    "encodeURIComponent(kind)",
  ],
  [
    "module alias",
    "const encodeURIComponent = unknownEncoder;",
    "",
    "",
    "encodeURIComponent(kind)",
  ],
] as const;

for (const [
  label,
  moduleBinding,
  parameter,
  localBinding,
  expression,
] of untrustedEncoders) {
  test(`untrusted encoder ${label} stays unresolved`, () => {
    const result = fixture(`${moduleBinding}
export function retryJob(kind: string, id: string${parameter ? `, ${parameter}` : ""}) {
  ${localBinding}
  return apiFetch(\`/jobs/\${${expression}}/\${id}/retry\`, schema, { method: "POST" });
}`);
    expect(result.routes).toEqual([]);
    expect(result.diagnostics.join("\n")).toContain(
      "unresolved dynamic path interpolation",
    );
  });
}

test("untrusted encoder in nested lexical scope stays unresolved", () => {
  const result = fixture(`
export function retryJob(kind: string, id: string) {
  function send(encodeURIComponent: (value: string) => string) {
    return apiFetch(\`/jobs/\${encodeURIComponent(kind)}/\${id}/retry\`, schema, { method: "POST" });
  }
  return send(unknownEncoder);
}`);
  expect(result.routes).toEqual([]);
  expect(result.diagnostics.join("\n")).toContain(
    "unresolved dynamic path interpolation",
  );
});

test("builtin encoding survives unrelated function shadows and known value helpers", () => {
  const result = fixture(`
function unrelated(encodeURIComponent: (value: string) => string) { return encodeURIComponent("unused"); }
function encodedKind(kind: string) { return encodeURIComponent(kind); }
export function retryJob(kind: string, id: string) {
  return apiFetch(\`/jobs/\${encodedKind(kind)}/\${id}/retry\`, schema, { method: "POST" });
}`);
  expect(result.diagnostics).toEqual([]);
  expect(result.routes.map((route) => [route.method, route.path])).toEqual([
    ["POST", "/api/jobs/{param}/{param}/retry"],
  ]);
});

test("two-argument schedule wrappers keep the request method from the init argument", () => {
  const result = fixture(`
async function safeScheduleJson(path: string, init: ApiRequestInit) {
  return apiFetch(path, wireScheduleSchema, init);
}
export function getSchedule(reportId: string) {
  return safeScheduleJson(\`/reports/\${reportId}/schedule\`, { cache: "no-store" });
}
export function updateSchedule(reportId: string) {
  return safeScheduleJson(\`/reports/\${reportId}/schedule\`, {
    method: "PATCH", body: JSON.stringify({ revision: 1, enabled: false }),
  });
}
`);
  expect(result.diagnostics).toEqual([]);
  expect(
    result.routes.map((route) => [route.function, route.method, route.path]),
  ).toEqual([
    ["getSchedule", "GET", "/api/reports/{param}/schedule"],
    ["updateSchedule", "PATCH", "/api/reports/{param}/schedule"],
  ]);
});

test("route discovery resolves forwarded init values and method shorthand", () => {
  const result = fixture(`
function requestWithInit(path: string, init: ApiRequestInit) {
  return apiFetch(path, schema, init);
}
export function updateForwardedInit(recordId: string) {
  const requestInit = { method: "PATCH" };
  return requestWithInit(\`/records/\${recordId}\`, requestInit);
}
export function deleteWithMethodShorthand(recordId: string) {
  const method = "DELETE";
  return apiFetch(\`/records/\${recordId}\`, schema, { method });
}
`);

  expect(result.diagnostics).toEqual([]);
  expect(
    result.routes.map((route) => [route.function, route.method, route.path]),
  ).toEqual([
    ["deleteWithMethodShorthand", "DELETE", "/api/records/{param}"],
    ["updateForwardedInit", "PATCH", "/api/records/{param}"],
  ]);
});

test("unknown forwarded init fails closed while absent init stays GET", () => {
  const result = fixture(`
function requestWithInit(path: string, init: ApiRequestInit = {}) {
  return apiFetch(path, schema, init);
}
export function unknownForwardedInit(recordId: string, init: ApiRequestInit) {
  return requestWithInit(\`/records/\${recordId}\`, init);
}
export function unknownMethod(recordId: string, method: string) {
  return apiFetch(\`/records/\${recordId}\`, schema, { method });
}
export function getWithoutInit(recordId: string) {
  return apiFetch(\`/records/\${recordId}\`, schema);
}
export function getWithKnownInit(recordId: string) {
  return requestWithInit(\`/records/\${recordId}\`, { cache: "no-store" });
}
export function getWithOmittedHelperInit(recordId: string) {
  return requestWithInit(\`/records/\${recordId}\`);
}
`);

  expect(result.diagnostics).toEqual([
    "unresolved request method in requestWithInit",
    "unresolved request method in unknownMethod",
  ]);
  expect(
    result.routes.map((route) => [route.function, route.method, route.path]),
  ).toEqual([
    ["getWithKnownInit", "GET", "/api/records/{param}"],
    ["getWithOmittedHelperInit", "GET", "/api/records/{param}"],
    ["getWithoutInit", "GET", "/api/records/{param}"],
  ]);
});

test("manifest comparison catches missing, new, changed, variant, and extra routes", () => {
  const original = fixture(sharedPathSource);
  const missingFunction = manifestDifferences(
    original.routes,
    original.routes.filter((route) => route.function !== "getRecord"),
  );
  expect(missingFunction.missing.map((route) => route.function)).toContain(
    "getRecord",
  );

  const newFunctionSource = `${sharedPathSource}\nexport function deleteRecord(recordId: string) { return apiFetch(recordPath(recordId), schema, { method: "DELETE" }); }`;
  const added = fixture(newFunctionSource);
  const newFunction = manifestDifferences(added.routes, original.routes);
  expect(newFunction.missing.map((route) => route.function)).toContain(
    "deleteRecord",
  );

  const changedMethodSource = sharedPathSource.replace(
    'method: "PATCH"',
    'method: "PUT"',
  );
  const changedMethod = fixture(changedMethodSource);
  const methodDiff = manifestDifferences(changedMethod.routes, original.routes);
  expect(methodDiff.missing.map((route) => route.method)).toContain("PUT");
  expect(methodDiff.extra.map((route) => route.method)).toContain("PATCH");

  const changedSharedPath = fixture(
    sharedPathSource.replace("/records/", "/archived-records/"),
  );
  const pathDiff = manifestDifferences(
    changedSharedPath.routes,
    original.routes,
  );
  expect(pathDiff.missing).toHaveLength(3);
  expect(pathDiff.extra).toHaveLength(3);
  expect(
    pathDiff.missing.every((route) => route.path.includes("archived-records")),
  ).toBe(true);
  expect(
    pathDiff.extra.every((route) => route.path.includes("/records/")),
  ).toBe(true);

  const variantSource = `
function recordLinkPath(target: { kind: "event" | "post"; boardId: string; contentId: string }) {
  const collection = target.kind === "event" ? "events" : "posts";
  return \`/boards/\${target.boardId}/\${collection}/\${target.contentId}/record-links\`;
}
export function listRecordLinks(target: { kind: "event" | "post"; boardId: string; contentId: string }) {
  return apiFetch(recordLinkPath(target), schema);
}
`;
  const variants = fixture(variantSource);
  expect(variants.diagnostics).toEqual([]);
  expect(variants.routes.map((route) => route.path)).toEqual([
    "/api/boards/{param}/events/{param}/record-links",
    "/api/boards/{param}/posts/{param}/record-links",
  ]);
  const oneVariant = manifestDifferences(variants.routes, [
    variants.routes[0]!,
  ]);
  expect(oneVariant.missing.map((route) => route.path)).toContain(
    "/api/boards/{param}/posts/{param}/record-links",
  );

  const extra = manifestDifferences(original.routes, [
    ...original.routes,
    {
      ...original.routes[0]!,
      path: "/api/records/{record_id}/obsolete",
    },
  ]);
  expect(extra.extra.map((route) => route.path)).toContain(
    "/api/records/{record_id}/obsolete",
  );
});

test("unresolved dynamic request paths and calls outside adapters are reported", () => {
  const dynamicPath = fixture(`
export function loadRecord(path: string) {
  return apiFetch(routeFromUserInput(path), schema);
}
`);
  expect(dynamicPath.diagnostics.join("\n")).toContain(
    "unresolved dynamic request path call",
  );

  const pathWrapper = fixture(`
function getPath(path: string) {
  return apiFetch(path, schema);
}
export function readRecords() {
  return getPath("/records/query");
}
`);
  expect(pathWrapper.diagnostics).toEqual([]);
  expect(pathWrapper.routes.map((route) => route.path)).toEqual([
    "/api/records/query",
  ]);

  const unknownPathWrapper = fixture(`
function getPath(path: string) {
  return apiFetch(path, schema);
}
export function readRecords(path: string) {
  return getPath(path);
}
`);
  expect(unknownPathWrapper.diagnostics.join("\n")).toContain(
    "unresolved dynamic request path",
  );

  const outsideAdapter = discoverRoutesInSources([
    {
      file: "frontend/src/components/systems/openview/components/record-panel.tsx",
      source: `export function RecordPanel() { return apiFetch("/records/query", schema); }`,
    },
  ]);
  expect(outsideAdapter.diagnostics.join("\n")).toContain(
    "unowned request call",
  );
  const libraryRequest = `export function getMfaStatus() { return apiFetch("/auth/mfa", schema); }`;
  const mfaAdapter = discoverRoutesInSources([
    { file: "frontend/src/lib/mfa-api.ts", source: libraryRequest },
  ]);
  expect(mfaAdapter.diagnostics).toEqual([]);
  expect(mfaAdapter.routes.map((route) => [route.method, route.path])).toEqual([
    ["GET", "/api/auth/mfa"],
  ]);
  const themeAdapter = discoverRoutesInSources([
    {
      file: "frontend/src/lib/user-theme-preferences.ts",
      source: readFileSync(
        resolve(process.cwd(), "src/lib/user-theme-preferences.ts"),
        "utf8",
      ),
    },
  ]);
  expect(themeAdapter.diagnostics).toEqual([]);
  expect(
    themeAdapter.routes.map((route) => [route.method, route.path]),
  ).toEqual([
    ["GET", "/api/users/{param}/preferences"],
    ["PATCH", "/api/users/{param}/preferences"],
  ]);
  const unrelatedLibrary = discoverRoutesInSources([
    { file: "frontend/src/lib/unrelated-api.ts", source: libraryRequest },
  ]);
  expect(unrelatedLibrary.routes).toEqual([]);
  expect(unrelatedLibrary.diagnostics.join("\n")).toContain(
    "unowned request call",
  );
  const bindingRequest = `export function getSandboxBindings() { return apiFetch("/sandbox/bindings", schema); }`;
  const lifecycleAdapter = discoverRoutesInSources([
    {
      file: "frontend/src/components/systems/sandbox/state/lifecycle-api.ts",
      source: bindingRequest,
    },
  ]);
  expect(lifecycleAdapter.diagnostics).toEqual([]);
  expect(
    lifecycleAdapter.routes.map((route) => [route.method, route.path]),
  ).toEqual([["GET", "/api/sandbox/bindings"]]);
  const unrelatedStateAdapter = discoverRoutesInSources([
    {
      file: "frontend/src/components/systems/sandbox/state/unrelated-api.ts",
      source: bindingRequest,
    },
  ]);
  expect(unrelatedStateAdapter.routes).toEqual([]);
  expect(unrelatedStateAdapter.diagnostics.join("\n")).toContain(
    "unowned request call",
  );
});

test("manifest entries are valid and cover every frontend API route owner", () => {
  const scan = discoverFrontendRoutes();
  const manifestValue: unknown = JSON.parse(readFileSync(manifestFile, "utf8"));
  const errors = manifestSchemaErrors(manifestValue);
  expect(errors, errors.join("\n")).toEqual([]);
  const manifest = manifestValue as FrontendRoute[];
  const differences = manifestDifferences(scan.routes, manifest);
  const details = [
    `source route owners: ${scan.routes.length}`,
    `unresolved/unowned calls: ${scan.diagnostics.length}`,
    ...scan.diagnostics.slice(0, 12),
    `missing manifest entries: ${differences.missing.length}`,
    ...differences.missing.slice(0, 12).map(signature),
    `extra manifest entries: ${differences.extra.length}`,
    ...differences.extra.slice(0, 12).map(signature),
  ].join("\n");
  expect(scan.diagnostics, details).toEqual([]);
  expect(
    { missing: differences.missing.length, extra: differences.extra.length },
    details,
  ).toEqual({ missing: 0, extra: 0 });
});
