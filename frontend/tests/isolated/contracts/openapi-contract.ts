import { expect, test } from "@playwright/test";
import { z } from "zod";

import {
  Generator,
  REFRESH,
  mergeJson,
  objectAt,
  openApiPaths as paths,
  resolveSchema,
  schemasAt,
  stringAt,
  validateValue,
  type Json,
  type JsonObject,
  type ResponseMode,
  type Schema,
} from "./openapi-schema";

// Contract harness: adapters call a stubbed fetch, each request is checked
// against the backend's OpenAPI snapshot (contracts/openapi.json), and each
// response is generated from the operation's declared 2xx schema so the
// adapter's real Zod schema has to accept what the backend declares.

const METHODS = ["get", "put", "post", "delete", "patch"] as const;

// ---------------------------------------------------------------- operations

export type Operation = {
  key: string;
  method: string;
  template: string;
  operation: JsonObject;
  pathParams: Record<string, string>;
};

function matchTemplate(
  template: string,
  pathname: string,
): { literals: number; params: Record<string, string> } | null {
  const expected = template.split("/");
  const actual = pathname.split("/");
  if (expected.length !== actual.length) return null;
  let literals = 0;
  const params: Record<string, string> = {};
  for (const [index, segment] of expected.entries()) {
    const value = actual[index];
    const param = /^\{(.+)\}$/.exec(segment);
    if (param) {
      if (!value) return null;
      params[param[1]] = decodeURIComponent(value);
    } else if (segment === value) {
      literals += 1;
    } else {
      return null;
    }
  }
  return { literals, params };
}

/** The operation FastAPI would route to: the most literal matching template with this method. */
export function findOperation(
  method: string,
  pathname: string,
): Operation | null {
  let best: (Operation & { literals: number }) | null = null;
  for (const [template, item] of Object.entries(paths)) {
    const operation = objectAt(objectAt(item)?.[method.toLowerCase()]);
    if (operation === undefined) continue;
    const match = matchTemplate(template, pathname);
    if (match === null || (best !== null && best.literals >= match.literals))
      continue;
    best = {
      key: `${method.toUpperCase()} ${template}`,
      method: method.toUpperCase(),
      template,
      operation,
      pathParams: match.params,
      literals: match.literals,
    };
  }
  return best;
}

function allowedMethods(pathname: string): string[] {
  return Object.entries(paths)
    .filter(([template]) => matchTemplate(template, pathname) !== null)
    .flatMap(([template, item]) =>
      METHODS.filter((method) => objectAt(item)?.[method] !== undefined).map(
        (method) => `${method.toUpperCase()} ${template}`,
      ),
    );
}

function parameterValue(schema: Schema, raw: string): Json {
  const type = stringAt(resolveSchema(schema).type);
  if (type === "integer" || type === "number") {
    const number = Number(raw);
    return raw.trim() === "" || Number.isNaN(number) ? raw : number;
  }
  if (type === "boolean")
    return raw === "true" ? true : raw === "false" ? false : raw;
  const branches = schemasAt(resolveSchema(schema).anyOf);
  if (branches !== undefined) {
    for (const branch of branches) {
      const candidate = parameterValue(branch, raw);
      if (validateValue(branch, candidate, "").length === 0) return candidate;
    }
  }
  return raw;
}

function parameterSchema(parameter: JsonObject): Schema {
  return objectAt(parameter.schema) ?? {};
}

type CapturedRequest = {
  method: string;
  url: URL;
  headers: Headers;
  body: Json | undefined;
  rawBody: boolean;
};

/** Checks one captured request against its operation; returns error lines. */
export function validateRequest(
  operation: Operation,
  request: CapturedRequest,
): string[] {
  const errors: string[] = [];
  const parameters = (schemasAt(operation.operation.parameters) ?? []).map(
    (parameter) => resolveSchema(parameter),
  );
  for (const parameter of parameters) {
    const name = stringAt(parameter.name) ?? "";
    const location = stringAt(parameter.in);
    const schema = parameterSchema(parameter);
    if (location === "path") {
      const value = operation.pathParams[name];
      errors.push(
        ...validateValue(schema, parameterValue(schema, value), `path ${name}`),
      );
    } else if (location === "query") {
      const values = request.url.searchParams.getAll(name);
      if (values.length === 0 && parameter.required === true)
        errors.push(`query ${name}: required by the backend but not sent`);
      const resolved = resolveSchema(schema);
      const itemSchema =
        resolved.type === "array" ? (objectAt(resolved.items) ?? {}) : schema;
      for (const value of values)
        errors.push(
          ...validateValue(
            itemSchema,
            parameterValue(itemSchema, value),
            `query ${name}`,
          ),
        );
    } else if (location === "header") {
      const value = request.headers.get(name);
      if (value === null && parameter.required === true)
        errors.push(`header ${name}: required by the backend but not sent`);
    }
  }
  const declaredQuery = new Set(
    parameters
      .filter((parameter) => parameter.in === "query")
      .map((parameter) => stringAt(parameter.name)),
  );
  for (const name of new Set(request.url.searchParams.keys())) {
    if (!declaredQuery.has(name))
      errors.push(`query ${name}: not declared by the backend`);
  }

  const requestBody = objectAt(operation.operation.requestBody);
  const bodySchema = objectAt(
    objectAt(objectAt(requestBody?.content)?.["application/json"])?.schema,
  );
  const contentTypes = Object.keys(objectAt(requestBody?.content) ?? {});
  if (request.rawBody) {
    const sent = request.headers.get("Content-Type")?.split(";")[0] ?? "";
    if (!contentTypes.includes(sent))
      errors.push(
        `body: sent as ${sent || "no type"}, backend accepts ${contentTypes.join(", ") || "no body"}`,
      );
  } else if (request.body === undefined) {
    if (requestBody?.required === true)
      errors.push("body: required by the backend but not sent");
  } else if (bodySchema === undefined) {
    errors.push("body: sent, but the backend declares no JSON request body");
  } else {
    errors.push(...validateValue(bodySchema, request.body, "body"));
  }
  return errors;
}

type PlannedResponse =
  | { status: number; kind: "empty" }
  | { status: number; kind: "json"; body: Json };

function planResponse(
  operation: Operation,
  generator: Generator,
  override: Json | undefined,
): PlannedResponse {
  const responses = objectAt(operation.operation.responses) ?? {};
  const status = Object.keys(responses)
    .filter((code) => /^2\d\d$/.test(code))
    .sort()[0];
  if (status === undefined)
    throw new Error(`${operation.key}: the backend declares no 2xx response`);
  if (status === "204") return { status: 204, kind: "empty" };
  const schema = objectAt(
    objectAt(
      objectAt(objectAt(responses[status])?.content)?.["application/json"],
    )?.schema,
  );
  if (schema === undefined || Object.keys(schema).length === 0)
    throw new Error(
      `${operation.key}: the backend declares no JSON response schema`,
    );
  const body = generator.generate(schema, "response");
  return {
    status: Number(status),
    kind: "json",
    body: override === undefined ? body : mergeJson(body, override),
  };
}

// ---------------------------------------------------------------- harness

export type ContractCase = {
  /** Adapter function name, as exported. */
  name: string;
  run: () => Promise<unknown>;
  /**
   * Values merged into the generated response, keyed by `METHOD /api/template`.
   * Only for legitimate frontend narrowing; each entry needs a one-line reason.
   */
  responses?: Record<string, Json>;
  /** Response headers the adapter requires (for example Content-Disposition). */
  responseHeaders?: Record<string, string>;
  /**
   * Why the response cannot be checked (CSV, file bytes, no JSON schema).
   * Route, method, query, headers and JSON body are still checked.
   */
  requestOnly?: string;
  /** Set to the finding id when the adapter disagrees with the backend today. */
  fixme?: string;
};

function capture(
  input: RequestInfo | URL,
  init?: RequestInit,
): CapturedRequest {
  const href =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const body = init?.body;
  let parsed: Json | undefined;
  if (typeof body === "string") {
    const value: unknown = JSON.parse(body);
    parsed = value as Json;
  }
  return {
    method: (init?.method ?? "GET").toUpperCase(),
    url: new URL(href, "http://contract.test"),
    headers: new Headers(init?.headers),
    body: parsed,
    rawBody: body !== undefined && body !== null && typeof body !== "string",
  };
}

/** Runs one adapter call against the snapshot; returns a readable failure report. */
export async function checkContract(
  contract: ContractCase,
  mode: ResponseMode,
): Promise<string[]> {
  const generator = new Generator(mode);
  const problems: string[] = [];
  const exchanges: string[] = [];
  let requests = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests += 1;
    const request = capture(input, init);
    const pathname = request.url.pathname;
    const operation = findOperation(request.method, pathname);
    if (operation === null) {
      const allowed = allowedMethods(pathname);
      problems.push(
        `${request.method} ${pathname}: no backend operation (route or method drift)` +
          (allowed.length > 0 ? `; the path allows ${allowed.join(", ")}` : ""),
      );
      return new Response(null, { status: 404 });
    }
    for (const error of validateRequest(operation, request))
      problems.push(`${operation.key} request ${error}`);
    let planned: PlannedResponse;
    try {
      planned = planResponse(
        operation,
        generator,
        contract.responses?.[operation.key],
      );
    } catch (error) {
      if (contract.requestOnly !== undefined)
        return new Response("contract", { status: 200 });
      problems.push(error instanceof Error ? error.message : String(error));
      return new Response(null, { status: 500 });
    }
    const headers = {
      ETag: '"contract-1"',
      "Content-Type": "application/json",
      ...contract.responseHeaders,
    };
    if (planned.kind === "empty")
      return new Response(null, { status: planned.status, headers });
    exchanges.push(
      `${operation.key} -> ${planned.status} ${JSON.stringify(planned.body).slice(0, 1500)}`,
    );
    return new Response(JSON.stringify(planned.body), {
      status: planned.status,
      headers,
    });
  }) as typeof fetch;
  // ApiContractError hides Zod's issues on purpose. Zod finalizes issues
  // lazily, so this hook sees only thrown parses; the sent body is always shown.
  const zodIssues: string[] = [];
  const previousCustomError = z.config().customError;
  z.config({
    customError: (issue) => {
      const path = (issue.path ?? []).map(String).join(".") || "(root)";
      const input = JSON.stringify(issue.input) ?? "undefined";
      zodIssues.push(`${path}: ${issue.code} (got ${input.slice(0, 80)})`);
      return undefined;
    },
  });
  try {
    await contract.run();
  } catch (error) {
    const description =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    // A request-only case expects the adapter to refuse the placeholder response.
    if (contract.requestOnly === undefined)
      problems.push(
        `adapter rejected the ${mode} response (${description})`,
        ...zodIssues.map((line) => `  zod ${line}`),
        ...exchanges.map((line) => `  sent ${line}`),
      );
  } finally {
    globalThis.fetch = original;
    z.config({ customError: previousCustomError });
  }
  if (requests === 0) problems.push("the adapter made no API request");
  return problems;
}

/** Registers one Playwright test per adapter call, each checked with both response modes. */
export function describeContracts(area: string, cases: ContractCase[]): void {
  test.describe(`${area} adapters match contracts/openapi.json`, () => {
    for (const contract of cases) {
      const register = contract.fixme ? test.fixme : test;
      register(contract.name, async () => {
        const problems = await checkContract(contract, "values");
        if (contract.requestOnly === undefined)
          problems.push(...(await checkContract(contract, "nulls")));
        expect(
          problems,
          `${contract.name} disagrees with the backend. If the backend changed on purpose, ` +
            `refresh the snapshot (${REFRESH}) and update the adapter.`,
        ).toEqual([]);
      });
    }
  });
}
