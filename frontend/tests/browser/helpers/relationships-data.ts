export const DEPARTMENT_ID = "11111111-1111-4111-8111-111111111111";

export const OTHER_DEPARTMENT_ID = "22222222-2222-4222-8222-222222222222";

export const SOURCE_MODULE_ID = "33333333-3333-4333-8333-333333333333";

export const TARGET_MODULE_ID = "44444444-4444-4444-8444-444444444444";

export const CONTACTS_MODULE_ID = "55555555-5555-4555-8555-555555555555";

export const EXTERNAL_MODULE_ID = "66666666-6666-4666-8666-666666666666";

export const SOURCE_RECORD_ID = "77777777-7777-4777-8777-777777777777";

export const TARGET_RECORD_ID = "88888888-8888-4888-8888-888888888888";

export const SECOND_TARGET_RECORD_ID = "99999999-9999-4999-8999-999999999999";

export const ARCHIVED_TARGET_RECORD_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

export const INCOMING_SOURCE_RECORD_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

export const NAME_FIELD_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

export const NOTES_FIELD_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

export const OWNER_FIELD_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

export const CONTACTS_FIELD_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

export const INCOMING_FIELD_ID = "10101010-1010-4010-8010-101010101010";

export const OWNER_EDGE_ID = "12121212-1212-4121-8121-121212121212";

export const CONTACT_EDGE_ID = "13131313-1313-4131-8131-131313131313";

export const HIDDEN_EDGE_ID = "14141414-1414-4141-8141-141414141414";

export const INCOMING_EDGE_ID = "15151515-1515-4151-8151-151515151515";

export const NEW_OWNER_RECORD_ID = "20202020-2020-4020-8020-202020202020";

export const NEW_TARGET_RECORD_ID = "21212121-2121-4121-8121-212121212121";

export const OWNER_NAME_FIELD_ID = "23232323-2323-4232-8232-232323232323";

export const CONTACT_NAME_FIELD_ID = "24242424-2424-4242-8242-242424242424";

export type JsonObject = { [key: string]: unknown };

export type BaseEntityFixture = {
  id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  is_deleted: boolean;
  performed_by: string | null;
};

export type ModuleFixture = BaseEntityFixture & {
  department_id: string;
  module_name: string;
  is_schema_accepted: boolean;
};

export type FieldFixture = BaseEntityFixture & {
  module_id: string;
  name: string;
  type: string;
  required: boolean;
  position: number;
  audit_redacted?: boolean;
  config: JsonObject;
  relationship_target_module_id: string | null;
  relationship_multiple_targets: boolean | null;
  relationship_multiple_sources: boolean | null;
};

export type RecordFixture = BaseEntityFixture & {
  module_id: string;
  data: JsonObject;
};

export type RelationshipFixture = BaseEntityFixture & {
  field_id: string;
  source_record_id: string;
  target_record_id: string;
  visibility: "available" | "hidden";
  hidden_reasons: string[];
};

export type FixtureState = {
  modules: ModuleFixture[];
  fields: FieldFixture[];
  records: RecordFixture[];
  relationships: RelationshipFixture[];
  acceptanceError?: string;
  targetRecordsFailures?: number;
};

export type CapturedRequest = {
  method: string;
  path: string;
  url: string;
  body: unknown;
};

export type PaginationOverrides = Partial<{
  limit: number;
  offset: number;
  total: number;
  has_more: boolean;
}>;

export const CREATED_AT = "2026-01-01T00:00:00.000Z";

export function baseEntity(id: string, isDeleted = false): BaseEntityFixture {
  return {
    id,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    deleted_at: isDeleted ? "2026-01-02T00:00:00.000Z" : null,
    is_deleted: isDeleted,
    performed_by: null,
  };
}

export function moduleFixture(
  id: string,
  departmentId: string,
  moduleName: string,
  isSchemaAccepted = true,
): ModuleFixture {
  return {
    ...baseEntity(id),
    department_id: departmentId,
    module_name: moduleName,
    is_schema_accepted: isSchemaAccepted,
  };
}

export function primitiveField(
  id: string,
  moduleId: string,
  name: string,
  position: number,
): FieldFixture {
  return {
    ...baseEntity(id),
    module_id: moduleId,
    name,
    type: "text",
    required: false,
    position,
    config: {},
    relationship_target_module_id: null,
    relationship_multiple_targets: null,
    relationship_multiple_sources: null,
  };
}

export function relationshipField(
  id: string,
  moduleId: string,
  name: string,
  position: number,
  targetModuleId: string,
  multipleTargets: boolean,
  multipleSources: boolean,
): FieldFixture {
  return {
    ...baseEntity(id),
    module_id: moduleId,
    name,
    type: "relationship",
    required: false,
    position,
    config: {},
    relationship_target_module_id: targetModuleId,
    relationship_multiple_targets: multipleTargets,
    relationship_multiple_sources: multipleSources,
  };
}

export function recordFixture(
  id: string,
  moduleId: string,
  data: JsonObject,
  isDeleted = false,
): RecordFixture {
  return { ...baseEntity(id, isDeleted), module_id: moduleId, data };
}

export function relationshipFixture(
  id: string,
  fieldId: string,
  sourceRecordId: string,
  targetRecordId: string,
  visibility: "available" | "hidden" = "available",
  hiddenReasons: string[] = [],
  isDeleted = false,
): RelationshipFixture {
  return {
    ...baseEntity(id, isDeleted),
    field_id: fieldId,
    source_record_id: sourceRecordId,
    target_record_id: targetRecordId,
    visibility,
    hidden_reasons: hiddenReasons,
  };
}

export function makeState(): FixtureState {
  return {
    modules: [
      moduleFixture(SOURCE_MODULE_ID, DEPARTMENT_ID, "Assets"),
      moduleFixture(TARGET_MODULE_ID, DEPARTMENT_ID, "Owners"),
      moduleFixture(CONTACTS_MODULE_ID, DEPARTMENT_ID, "Contacts"),
      moduleFixture(EXTERNAL_MODULE_ID, OTHER_DEPARTMENT_ID, "External"),
    ],
    fields: [
      primitiveField(NAME_FIELD_ID, SOURCE_MODULE_ID, "Name", 0),
      primitiveField(NOTES_FIELD_ID, SOURCE_MODULE_ID, "Notes", 1),
      relationshipField(
        OWNER_FIELD_ID,
        SOURCE_MODULE_ID,
        "Owner",
        2,
        TARGET_MODULE_ID,
        false,
        false,
      ),
      relationshipField(
        CONTACTS_FIELD_ID,
        SOURCE_MODULE_ID,
        "Related contacts",
        3,
        CONTACTS_MODULE_ID,
        true,
        true,
      ),
      relationshipField(
        INCOMING_FIELD_ID,
        TARGET_MODULE_ID,
        "Linked asset",
        0,
        SOURCE_MODULE_ID,
        false,
        true,
      ),
      primitiveField(OWNER_NAME_FIELD_ID, TARGET_MODULE_ID, "Name", 0),
      primitiveField(CONTACT_NAME_FIELD_ID, CONTACTS_MODULE_ID, "Name", 0),
    ],
    records: [
      recordFixture(SOURCE_RECORD_ID, SOURCE_MODULE_ID, {
        [NAME_FIELD_ID]: "Asset Alpha",
        [NOTES_FIELD_ID]: "Initial notes",
      }),
      recordFixture(TARGET_RECORD_ID, TARGET_MODULE_ID, {
        [OWNER_NAME_FIELD_ID]: "Owner One",
      }),
      recordFixture(NEW_OWNER_RECORD_ID, TARGET_MODULE_ID, {
        [OWNER_NAME_FIELD_ID]: "Owner Two",
      }),
      recordFixture(SECOND_TARGET_RECORD_ID, CONTACTS_MODULE_ID, {
        [CONTACT_NAME_FIELD_ID]: "Contact Two",
      }),
      recordFixture(NEW_TARGET_RECORD_ID, CONTACTS_MODULE_ID, {
        [CONTACT_NAME_FIELD_ID]: "Contact Three",
      }),
      recordFixture(
        ARCHIVED_TARGET_RECORD_ID,
        CONTACTS_MODULE_ID,
        {
          [CONTACT_NAME_FIELD_ID]: "Archived Contact",
        },
        true,
      ),
      recordFixture(INCOMING_SOURCE_RECORD_ID, TARGET_MODULE_ID, {
        [NAME_FIELD_ID]: "Incoming Owner",
      }),
    ],
    relationships: [
      relationshipFixture(
        OWNER_EDGE_ID,
        OWNER_FIELD_ID,
        SOURCE_RECORD_ID,
        TARGET_RECORD_ID,
      ),
      relationshipFixture(
        CONTACT_EDGE_ID,
        CONTACTS_FIELD_ID,
        SOURCE_RECORD_ID,
        SECOND_TARGET_RECORD_ID,
      ),
      relationshipFixture(
        HIDDEN_EDGE_ID,
        CONTACTS_FIELD_ID,
        SOURCE_RECORD_ID,
        ARCHIVED_TARGET_RECORD_ID,
        "hidden",
        ["target_record_archived"],
      ),
      relationshipFixture(
        INCOMING_EDGE_ID,
        INCOMING_FIELD_ID,
        INCOMING_SOURCE_RECORD_ID,
        SOURCE_RECORD_ID,
      ),
    ],
  };
}
