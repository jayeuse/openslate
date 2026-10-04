import {
  assignOpenViewRecordLink,
  createOpenViewRecord,
  deleteOpenViewRecord,
  getOpenViewRecord,
  linkOpenViewRecords,
  listOpenViewFieldLinks,
  listOpenViewRecordHistory,
  listOpenViewRecordLinks,
  listOpenViewRelationshipFields,
  previewRecordPurge,
  purgeRecord,
  restoreOpenViewRecord,
  searchOpenViewLinkTargets,
  unlinkOpenViewRecords,
  updateOpenViewRecord,
} from "../../../src/components/systems/openview/adapters/records-api";
import type { OpenViewQueryDefinition } from "../../../src/components/systems/openview/adapters/views-schemas";
import { describeContracts } from "./openapi-contract";

const recordId = "00000000-0000-4000-8000-000000000001";
const moduleId = "00000000-0000-4000-8000-000000000002";
const fieldId = "00000000-0000-4000-8000-000000000003";
const targetId = "00000000-0000-4000-8000-000000000004";
const departmentId = "00000000-0000-4000-8000-000000000005";

const definition: OpenViewQueryDefinition = {
  version: 1,
  logic: "and",
  columns: [{ fieldId, expectedType: "text" }],
  filters: [
    { fieldId, expectedType: "text", operator: "contains", value: "pump" },
  ],
  sort: [{ fieldId, expectedType: "text", direction: "asc" }],
  deleted: "exclude",
  search: "pump",
  searchFields: [{ fieldId, expectedType: "text" }],
};

// The adapter checks that a purge preview and result describe this record;
// the frontend also narrows the digest to the SHA-256 hex the backend emits.
const recordPurgeImpact = {
  impact: {
    target_type: "record",
    target_id: recordId,
    operation: "purge",
    impact_digest: "a".repeat(64),
  },
};

describeContracts("Records and relationships", [
  { name: "getOpenViewRecord", run: () => getOpenViewRecord(recordId) },
  {
    name: "createOpenViewRecord",
    run: () => createOpenViewRecord({ moduleId, data: { name: "Pump" } }),
  },
  {
    name: "updateOpenViewRecord",
    run: () =>
      updateOpenViewRecord({
        recordId,
        revision: "2026-01-02T03:04:05Z",
        data: { name: "Pump" },
      }),
  },
  { name: "deleteOpenViewRecord", run: () => deleteOpenViewRecord(recordId) },
  { name: "restoreOpenViewRecord", run: () => restoreOpenViewRecord(recordId) },
  {
    name: "previewRecordPurge",
    run: () => previewRecordPurge(recordId),
    responses: {
      // The adapter requires the confirmation name to be the record id.
      "POST /api/records/{record_id}/purge/preview": {
        ...recordPurgeImpact,
        confirmation_name: recordId,
      },
    },
  },
  {
    name: "purgeRecord",
    run: () =>
      purgeRecord(recordId, {
        token: "token",
        confirmationName: recordId,
        password: "password",
      }),
    responses: { "POST /api/records/{record_id}/purge": recordPurgeImpact },
  },
  {
    name: "listOpenViewRelationshipFields",
    run: () => listOpenViewRelationshipFields(moduleId),
    // The adapter asks for relationship fields only; its schema accepts no other type.
    responses: { "GET /api/fields": { items: [{ type: "relationship" }] } },
  },
  {
    name: "listOpenViewRecordLinks",
    run: () => listOpenViewRecordLinks(recordId),
  },
  {
    name: "listOpenViewFieldLinks",
    run: () => listOpenViewFieldLinks(fieldId, { limit: 25, offset: 0 }),
  },
  {
    name: "linkOpenViewRecords",
    run: () =>
      linkOpenViewRecords({
        fieldId,
        sourceRecordId: recordId,
        targetRecordId: targetId,
      }),
  },
  {
    name: "assignOpenViewRecordLink",
    run: () =>
      assignOpenViewRecordLink({
        fieldId,
        sourceRecordId: recordId,
        targetRecordId: targetId,
      }),
  },
  {
    name: "unlinkOpenViewRecords",
    run: () => unlinkOpenViewRecords(recordId),
  },
  {
    name: "searchOpenViewLinkTargets",
    run: () => searchOpenViewLinkTargets({ moduleId, definition }),
  },
  {
    name: "listOpenViewRecordHistory",
    run: () => listOpenViewRecordHistory({ recordId, departmentId }),
  },
]);
