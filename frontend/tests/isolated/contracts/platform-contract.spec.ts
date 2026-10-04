import {
  changeAccountPassword,
  endAccountSession,
  endOtherAccountSessions,
  listAccountSessions,
} from "../../../src/components/systems/platform/adapters/account-api";
import { readPlatformSearch } from "../../../src/components/systems/platform/adapters/platform-search-api";
import {
  prepareRecordCsv,
  sendImportBatch,
} from "../../../src/components/systems/platform/adapters/record-import-api";
import type { OpenViewQueryDefinition } from "../../../src/components/systems/openview/adapters/views-schemas";
import { describeContracts } from "./openapi-contract";

const sessionId = "00000000-0000-4000-8000-000000000001";
const moduleId = "00000000-0000-4000-8000-000000000002";
const fieldId = "00000000-0000-4000-8000-000000000003";

const definition: OpenViewQueryDefinition = {
  version: 1,
  logic: "and",
  columns: [{ fieldId, expectedType: "text" }],
  filters: [],
  sort: [],
  deleted: "exclude",
  search: "",
  searchFields: [],
};

describeContracts("Platform", [
  { name: "listAccountSessions", run: () => listAccountSessions() },
  {
    name: "changeAccountPassword",
    run: () => changeAccountPassword("old-password", "new-password-123"),
    // The backend declares an untyped dict[str, bool]; the adapter names its
    // keys and accepts only the signed-in outcome.
    responses: {
      "POST /api/auth/password/change": {
        authenticated: true,
        setup_required: false,
      },
    },
  },
  { name: "endAccountSession", run: () => endAccountSession(sessionId) },
  { name: "endOtherAccountSessions", run: () => endOtherAccountSessions() },
  {
    name: "readPlatformSearch",
    run: () => readPlatformSearch("pump", "record", 0),
    responses: {
      // The adapter checks that each hit is the requested kind with its own
      // destination ids, and that the page echoes the request.
      "GET /api/search": {
        items: [{ kind: "record", module_id: moduleId, board_id: null }],
        pagination: { limit: 10, offset: 0, count: 1, total: 1 },
      },
    },
  },
  {
    name: "sendImportBatch",
    run: () =>
      sendImportBatch({
        mode: "preview",
        module_id: moduleId,
        headers: ["Name"],
        mapping: [{ column_index: 0, field_id: fieldId }],
        defaults: { [fieldId]: "Pump" },
        schema_digest: null,
        rows: [{ row_number: 2, cells: ["Pump"] }],
      }),
    responses: {
      // The adapter checks the result row by row against the previewed batch.
      "POST /api/records/import": {
        mode: "preview",
        schema_digest: "a".repeat(64),
        rows: [{ row_number: 2, status: "valid", record_id: null, errors: [] }],
        valid_count: 1,
        invalid_count: 0,
        created_count: 0,
      },
    },
  },
  {
    name: "prepareRecordCsv",
    run: () =>
      prepareRecordCsv(moduleId, definition, new AbortController().signal),
    requestOnly: "The response is a CSV file, not JSON",
  },
]);
