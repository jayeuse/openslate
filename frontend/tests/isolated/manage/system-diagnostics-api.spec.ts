import { expect, test } from "@playwright/test";

import {
  downloadInstallationDiagnostics,
  downloadOrganizationDiagnostics,
} from "../../../src/components/systems/manage/adapters/system-diagnostics-api";
import { ApiContractError, ApiError } from "../../../src/lib/api";
import { apiErrorReference } from "../../../src/lib/api-errors";
import { installFetch } from "../helpers/fake-fetch";

// The support file behind System health block 6 (docs/specs/system-health.md,
// API contract "Diagnostics downloads", S6-C2 and S6-C3, D19.4): one JSON
// file per role, saved under the name the server sets.

const reference = "019a4c2e-7b1d-7c3e-9f00-4f9c2e1a0b2c";
const fileBody = '{"summary":{"generated_at":"2026-11-05T10:42:00Z"}}';

function attachment(
  filename: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(fileBody, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Request-ID": reference,
      ...headers,
    },
  });
}

test("S6-C2, S6-C3: each role downloads its own file under the server's name", async () => {
  for (const [scope, download, filename] of [
    [
      "installation",
      downloadInstallationDiagnostics,
      "slateops-diagnostics-installation-20261105-1042Z.json",
    ],
    [
      "organization",
      downloadOrganizationDiagnostics,
      "slateops-diagnostics-organization-20261105-1042Z.json",
    ],
  ] as const) {
    const fetchStub = installFetch(() => attachment(filename));
    try {
      const file = await download();
      expect(file.filename).toBe(filename);
      expect(await file.blob.text()).toBe(fileBody);
      expect(file.blob.type).toBe("application/json");
      expect(String(fetchStub.requests[0].input)).toBe(
        `/api/system/diagnostics/${scope}`,
      );
    } finally {
      fetchStub.restore();
    }
  }
});

test("S6-C3: a file that is not the requested one, or not private, is refused", async () => {
  for (const response of [
    // The other role's file.
    attachment("slateops-diagnostics-installation-20261105-1042Z.json"),
    attachment("../slateops-diagnostics-organization-20261105-1042Z.json"),
    attachment("slateops-diagnostics-organization.json"),
    attachment("slateops-diagnostics-organization-20261105-1042Z.json", {
      "Cache-Control": "max-age=60",
    }),
    attachment("slateops-diagnostics-organization-20261105-1042Z.json", {
      "Content-Type": "text/html",
    }),
  ]) {
    const fetchStub = installFetch(() => response);
    try {
      const failure = await downloadOrganizationDiagnostics().catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ApiContractError);
      expect(apiErrorReference(failure)).toBe(reference);
    } finally {
      fetchStub.restore();
    }
  }
});

test("S6-C4, D19.4: a refused or failed download keeps its status and reference", async () => {
  for (const status of [403, 500]) {
    const fetchStub = installFetch(
      () =>
        new Response(
          JSON.stringify({ detail: "Forbidden", request_id: reference }),
          {
            status,
            headers: {
              "Content-Type": "application/json",
              "X-Request-ID": reference,
            },
          },
        ),
    );
    try {
      const failure = await downloadOrganizationDiagnostics().catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ApiError);
      expect((failure as ApiError).status).toBe(status);
      expect(apiErrorReference(failure)).toBe(reference);
    } finally {
      fetchStub.restore();
    }
  }
});
