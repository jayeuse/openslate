import { expect, test } from "@playwright/test";
import { z } from "zod";

import { ErrorReferenceView } from "../../../src/components/ui/error-reference";
import { SearchSelectError } from "../../../src/components/ui/search-select";
import { toast } from "../../../src/components/ui/toast";
import {
  ApiContractError,
  ApiError,
  apiContractError,
  apiFetch,
  keepRequestId,
} from "../../../src/lib/api";
import {
  apiErrorMessage,
  apiErrorReference,
  apiErrorText,
  errorTextFor,
} from "../../../src/lib/api-errors";
import { reportError } from "../../../src/lib/feedback";
import { installFetch } from "../helpers/fake-fetch";
import { staticMarkup } from "../sandbox/static-markup";

// Error references (docs/specs/system-health.md, S1): the ID that an error
// keeps (S1-C3), what the reference shows (S1-C4), nothing without an ID
// (S1-C5), and no server text in the message (S1-C6).

const bodyId = "019a4c2e-7b1d-7c3e-9f00-4f9c2e1a0b2c";
const headerId = "019a4c2e-7b1d-7c3e-9f00-00000000beef";

async function failure(response: Response): Promise<unknown> {
  const fetchStub = installFetch(() => response);
  try {
    await apiFetch("/things", z.object({ id: z.string() }), {
      refreshOnUnauthorized: false,
    });
  } catch (error) {
    return error;
  } finally {
    fetchStub.restore();
  }
  throw new Error("The request did not fail");
}

test("an API error keeps the body's request ID before the header's", async () => {
  const error = await failure(
    new Response(JSON.stringify({ detail: "Gone", request_id: bodyId }), {
      status: 404,
      headers: { "Content-Type": "application/json", "X-Request-ID": headerId },
    }),
  );
  expect(error).toBeInstanceOf(ApiError);
  expect(apiErrorReference(error)).toBe(bodyId);
});

test("an error body without a request ID falls back to the response header", async () => {
  // The host check answers in plain text but still sends the header.
  const error = await failure(
    new Response("Invalid host header", {
      status: 400,
      headers: { "X-Request-ID": headerId },
    }),
  );
  expect(apiErrorReference(error)).toBe(headerId);
});

test("a rejected success body keeps the header ID of the response it rejected", async () => {
  const error = await failure(
    new Response(JSON.stringify({ unexpected: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", "X-Request-ID": headerId },
    }),
  );
  expect(error).toBeInstanceOf(ApiContractError);
  expect(apiErrorReference(error)).toBe(headerId);
  expect(apiErrorMessage(error, "fallback")).toBe(
    "The server returned an unexpected response. Refresh and try again.",
  );
});

test("an adapter's contract check after a successful request keeps that response's ID", async () => {
  // S1-C3 header fallback and D4.5: the adapter rejects a body that parsed.
  const fetchStub = installFetch(
    () =>
      new Response(JSON.stringify({ id: "other" }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Request-ID": headerId,
        },
      }),
  );
  try {
    const thing = await apiFetch("/things", z.object({ id: z.string() }));
    expect(apiErrorReference(apiContractError(thing))).toBe(headerId);
  } finally {
    fetchStub.restore();
  }
  const response = new Response(null, {
    status: 200,
    headers: { "X-Request-ID": headerId },
  });
  expect(apiErrorReference(apiContractError(response))).toBe(headerId);
  expect(
    apiErrorReference(apiContractError({ data: null, response, etag: null })),
  ).toBe(headerId);
  // A check with no request behind it, or data that no request returned,
  // keeps no reference (S1-C5).
  expect(apiErrorReference(apiContractError())).toBeUndefined();
  expect(apiErrorReference(apiContractError({ id: "x" }))).toBeUndefined();
  expect(apiErrorReference(apiContractError(null))).toBeUndefined();
  expect(apiContractError()).toBeInstanceOf(ApiContractError);
});

test("failures without a request ID have no reference", async () => {
  const proxy = await failure(new Response("Bad gateway", { status: 502 }));
  expect(apiErrorReference(proxy)).toBeUndefined();
  for (const error of [
    new TypeError("Failed to fetch"),
    new DOMException("Aborted", "AbortError"),
    new Error("Clipboard refused"),
    null,
  ])
    expect(apiErrorReference(error)).toBeUndefined();
});

test("a request ID that is not an ID shows no reference and no server text", async () => {
  // A response from something in front of the server can carry any text. A
  // request ID is a canonical UUID (8-4-4-4-12 hex); a host and port written
  // with dashes is not one either.
  for (const requestId of [
    "db.internal:5432 SELECT * FROM users",
    "db-host-5432",
  ]) {
    const error = await failure(
      new Response(
        JSON.stringify({
          detail: "Traceback at db.internal:5432",
          request_id: requestId,
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      ),
    );
    expect(apiErrorReference(error)).toBeUndefined();
    expect(apiErrorText(error, "The item could not be saved.")).toEqual({
      message: "The item could not be saved.",
      reference: undefined,
    });
  }
});

test("the message and the reference stay together for the surface that shows them", async () => {
  const error = await failure(
    new Response(JSON.stringify({ detail: "Busy", request_id: bodyId }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    }),
  );
  expect(apiErrorText(error, "fallback")).toEqual({
    message: "This service is temporarily unavailable. Try again.",
    reference: bodyId,
  });
});

test("a rebuilt, sanitized error keeps the ID of the error or response it came from", () => {
  // Adapters replace server words with their own; the reference must survive.
  const caught = new ApiError(
    500,
    "Private",
    undefined,
    undefined,
    undefined,
    bodyId,
  );
  expect(
    apiErrorReference(
      keepRequestId(
        new ApiError(500, "Request could not be completed"),
        caught,
      ),
    ),
  ).toBe(bodyId);
  const response = new Response(null, {
    status: 502,
    headers: { "X-Request-ID": headerId },
  });
  expect(
    apiErrorReference(
      keepRequestId(
        new ApiError(502, "Request could not be completed"),
        response,
      ),
    ),
  ).toBe(headerId);
  // A local refusal has no request behind it, so it keeps no reference.
  expect(
    apiErrorReference(keepRequestId(new ApiError(409, "Post changed"), null)),
  ).toBeUndefined();
  // A non-ID header is not kept (S1-C6).
  expect(
    apiErrorReference(
      keepRequestId(
        new ApiError(502, "x"),
        new Response(null, {
          status: 502,
          headers: { "X-Request-ID": "db:5432 x" },
        }),
      ),
    ),
  ).toBeUndefined();
});

function reference(props: Parameters<typeof ErrorReferenceView>[0]): string {
  return staticMarkup(ErrorReferenceView, props).replace(/ class="[^"]*"/g, "");
}

test("a reference shows the last eight characters, a named Copy control and the sentence", () => {
  const markup = reference({ id: bodyId, copy: "idle", onCopy: () => {} });
  expect(markup).toContain(">Reference<");
  // The last eight characters, with the full ID in the title.
  expect(markup).toContain(
    '<code title="019a4c2e-7b1d-7c3e-9f00-4f9c2e1a0b2c">2e1a0b2c</code>',
  );
  expect(markup).toContain('aria-label="Copy reference"');
  expect(markup).toContain(">Copy</button>");
  expect(markup).toContain(">Give this reference to your administrator.<");
  // The confirmation slot is present and empty from the first render.
  expect(markup).toContain('<span role="status"></span>');
  expect(markup).not.toContain(bodyId + "<");
});

test("a copied reference says so in its status slot", () => {
  const markup = reference({ id: bodyId, copy: "copied", onCopy: () => {} });
  expect(markup).toContain('<span role="status">Reference copied</span>');
  expect(markup).toContain('aria-label="Copy reference"');
});

test("a refused copy offers the full ID to select", () => {
  const markup = reference({ id: bodyId, copy: "failed", onCopy: () => {} });
  expect(markup).toContain(
    '<span role="status">Copy failed. Select the reference below.</span>',
  );
  expect(markup).toContain(`>${bodyId}</code>`);
});

test("no request ID renders nothing at all", () => {
  for (const id of [undefined, null, ""])
    expect(reference({ id, copy: "idle", onCopy: () => {} })).toBe("");
});

test("a reference uses phrasing markup, so it is valid inside a paragraph", () => {
  // S1-C4, D1.2: a header subtitle or an error line can be a <p>; a <div> or
  // <p> inside it is invalid nesting. The reference keeps its two lines.
  for (const copy of ["idle", "copied", "failed"] as const) {
    const markup = reference({ id: bodyId, copy, onCopy: () => {} });
    expect(markup).toMatch(/^<span data-slot="error-reference">/);
    expect(markup).not.toMatch(/<(div|p)[ >]/);
  }
});

test("a picker's error line ends with its reference, after Retry", () => {
  // S1-C4, D1.4: one reference per failed request, the last part of the
  // error container; S1-C5: none without an ID.
  const markup = staticMarkup(SearchSelectError, {
    message: "People could not be loaded.",
    reference: bodyId,
    onRetry: () => {},
  }).replace(/ class="[^"]*"/g, "");
  expect(markup).toMatch(
    /^<div role="alert"><p>People could not be loaded\.<\/p><button[^>]*>Retry<\/button><span data-slot="error-reference">.*2e1a0b2c/,
  );
  const plain = staticMarkup(SearchSelectError, {
    message: "People could not be loaded.",
    reference: undefined,
  }).replace(/ class="[^"]*"/g, "");
  expect(plain).toBe(
    '<div role="alert"><p>People could not be loaded.</p></div>',
  );
});

test("an error toast carries its reference; a toast without one does not", () => {
  toast.resumeWorkspace();
  const calls: Parameters<typeof toast.add>[0][] = [];
  const original = toast.add;
  toast.add = (options) => {
    calls.push(options);
    return original(options);
  };
  try {
    reportError("The report could not be archived.", bodyId);
    reportError("Could not copy the link");
    expect(calls.map((call) => [call.title, call.reference])).toEqual([
      ["The report could not be archived.", bodyId],
      ["Could not copy the link", undefined],
    ]);
  } finally {
    toast.add = original;
    toast.clearWorkspace();
  }
});

test("a screen's error state keeps the message and the reference of its cause together", () => {
  const caught = new ApiError(
    503,
    "Busy",
    undefined,
    undefined,
    undefined,
    bodyId,
  );
  expect(
    errorTextFor("The backup request could not be confirmed.", caught),
  ).toEqual({
    message: "The backup request could not be confirmed.",
    reference: bodyId,
  });
  // Local validation has no cause and no reference; an empty message clears.
  expect(errorTextFor("Enter a name.")).toEqual({
    message: "Enter a name.",
    reference: undefined,
  });
  expect(errorTextFor("", caught)).toBeNull();
});
