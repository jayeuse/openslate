import { expect, test } from "@playwright/test";
import { ApiContractError, ApiError } from "../../../src/lib/api";
import {
  archiveOpenViewSavedView,
  createOpenViewSavedView,
  getOpenViewConflict,
  getOpenViewSavedView,
  listOpenViewAudienceOptions,
  listOpenViewDataSourceFields,
  listOpenViewDataSources,
  listOpenViewPersonalDefaults,
  listOpenViewSavedViews,
  queryOpenViewRecords,
  restoreOpenViewSavedView,
  setOpenViewPersonalDefault,
  unsetOpenViewPersonalDefault,
  updateOpenViewSavedView,
  type OpenViewQueryDefinition,
  type OpenViewSavedView,
} from "../../../src/components/systems/openview/adapters/views-api";

const moduleId = "00000000-0000-4000-8000-000000000001";
const fieldId = "00000000-0000-4000-8000-000000000002";
const roleId = "00000000-0000-4000-8000-000000000003";
const userId = "00000000-0000-4000-8000-000000000004";
const viewId = "00000000-0000-4000-8000-000000000005";
const departmentId = "00000000-0000-4000-8000-000000000007";
const timelineStartFieldId = "00000000-0000-4000-8000-000000000008";
const timelineEndFieldId = "00000000-0000-4000-8000-000000000009";

type CapturedRequest = { input: RequestInfo | URL; init?: RequestInit };

function installFetch(
  responder: (input: RequestInfo | URL, init?: RequestInit) => Response,
) {
  const original = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init });
    return Promise.resolve(responder(input, init));
  }) as typeof fetch;
  return {
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const definition: OpenViewQueryDefinition = {
  version: 1,
  logic: "or",
  columns: [{ fieldId, expectedType: "text" }],
  filters: [
    {
      fieldId,
      expectedType: "text",
      operator: "suffix",
      value: "urgent",
    },
  ],
  sort: [{ fieldId, expectedType: "text", direction: "desc" }],
  deleted: "exclude",
  search: "pump",
  searchFields: [{ fieldId, expectedType: "text" }],
};

const timelineDefinition: OpenViewQueryDefinition = {
  ...definition,
  columns: [
    ...definition.columns,
    { fieldId: timelineStartFieldId, expectedType: "date" },
    { fieldId: timelineEndFieldId, expectedType: "datetime" },
  ],
};

const presentation = {
  version: 1 as const,
  layout: "table" as const,
  columnFieldIds: [fieldId],
  pinnedFieldIds: [fieldId],
  density: "comfortable" as const,
  wrap: true,
  cardSize: "compact" as const,
  primaryFieldId: fieldId,
  secondaryFieldId: null,
  dateFieldId: null,
  groupByFieldId: null,
  timelineStartFieldId: null,
  timelineEndFieldId: null,
  timelineDeadlineFieldId: null,
  timelineProgressFieldId: null,
  dateRange: "month" as const,
  scale: null,
};

const timelinePresentation = {
  ...presentation,
  layout: "timeline" as const,
  timelineStartFieldId,
  timelineEndFieldId,
};

const viewResponse = {
  id: viewId,
  module_id: moduleId,
  owner_id: userId,
  name: "Urgent queue",
  audience: { kind: "user", role_id: null, user_id: userId },
  visibility: "workspace",
  definition: {
    version: 1,
    logic: "or",
    columns: [{ field_id: fieldId, expected_type: "text" }],
    filters: [
      {
        field_id: fieldId,
        expected_type: "text",
        operator: "suffix",
        value: "urgent",
      },
    ],
    sort: [{ field_id: fieldId, expected_type: "text", direction: "desc" }],
    deleted: "exclude",
    search: "pump",
    search_fields: [{ field_id: fieldId, expected_type: "text" }],
  },
  presentation: {
    version: 1,
    layout: "table",
    column_field_ids: [fieldId],
    pinned_field_ids: [fieldId],
    density: "comfortable",
    wrap: true,
    card_size: "compact",
    primary_field_id: fieldId,
    secondary_field_id: null,
    date_field_id: null,
    group_by_field_id: null,
    timeline_start_field_id: null,
    timeline_end_field_id: null,
    timeline_deadline_field_id: null,
    timeline_progress_field_id: null,
    date_range: "month",
    scale: null,
  },
  can_edit: true,
  revision: 7,
  is_deleted: false,
  created_at: "2026-09-23T00:00:00Z",
  updated_at: "2026-09-23T00:00:00Z",
};

const timelineViewResponse = {
  ...viewResponse,
  definition: {
    ...viewResponse.definition,
    columns: [
      ...viewResponse.definition.columns,
      { field_id: timelineStartFieldId, expected_type: "date" },
      { field_id: timelineEndFieldId, expected_type: "datetime" },
    ],
  },
  presentation: {
    ...viewResponse.presentation,
    layout: "timeline",
    timeline_start_field_id: timelineStartFieldId,
    timeline_end_field_id: timelineEndFieldId,
  },
};

const pagination = {
  limit: 20,
  offset: 0,
  count: 1,
  total: 1,
  has_more: false,
};

test("maps validated catalog, audience, saved-view, default, and record pages", async () => {
  const responses: unknown[] = [
    {
      items: [{ id: moduleId, name: "Equipment", department_id: departmentId }],
      pagination,
    },
    {
      items: [
        {
          id: fieldId,
          module_id: moduleId,
          name: "Name",
          type: "text",
          required: true,
          position: 0,
          config: { choices: ["active", "retired"] },
        },
        {
          id: timelineStartFieldId,
          module_id: moduleId,
          name: "Start date",
          type: "date",
          required: false,
          position: 1,
          config: {},
        },
        {
          id: timelineEndFieldId,
          module_id: moduleId,
          name: "End date",
          type: "datetime",
          required: false,
          position: 2,
          config: {},
        },
      ],
      pagination,
    },
    {
      items: [{ kind: "role", id: roleId, label: "Operations" }],
      pagination,
    },
    {
      items: [{ kind: "user", id: userId, label: "Nina Santos" }],
      pagination,
    },
    { items: [viewResponse], pagination },
    viewResponse,
    {
      items: [{ module_id: moduleId, view_id: viewId, revision: 3 }],
      pagination,
    },
    {
      items: [
        {
          id: "00000000-0000-4000-8000-000000000006",
          module_id: moduleId,
          data: { [fieldId]: "Pump 04" },
          created_at: "2026-09-23T00:00:00Z",
          updated_at: "2026-09-23T00:00:00Z",
          deleted_at: null,
          is_deleted: false,
          performed_by: null,
        },
      ],
      pagination: { ...pagination, limit: 25 },
    },
  ];
  const mock = installFetch(() => Response.json(responses.shift()));
  try {
    await expect(listOpenViewDataSources()).resolves.toEqual({
      items: [{ id: moduleId, name: "Equipment", departmentId }],
      pagination: { limit: 20, offset: 0, count: 1, total: 1, hasMore: false },
    });
    await expect(listOpenViewDataSourceFields(moduleId)).resolves.toEqual({
      items: [
        {
          id: fieldId,
          moduleId,
          name: "Name",
          type: "text",
          required: true,
          position: 0,
          config: { choices: ["active", "retired"] },
        },
        {
          id: timelineStartFieldId,
          moduleId,
          name: "Start date",
          type: "date",
          required: false,
          position: 1,
          config: {},
        },
        {
          id: timelineEndFieldId,
          moduleId,
          name: "End date",
          type: "datetime",
          required: false,
          position: 2,
          config: {},
        },
      ],
      pagination: { limit: 20, offset: 0, count: 1, total: 1, hasMore: false },
    });
    await expect(listOpenViewAudienceOptions("role")).resolves.toEqual({
      items: [{ kind: "role", id: roleId, label: "Operations" }],
      pagination: { limit: 20, offset: 0, count: 1, total: 1, hasMore: false },
    });
    await expect(listOpenViewAudienceOptions("user")).resolves.toEqual({
      items: [{ kind: "identity", id: userId, label: "Nina Santos" }],
      pagination: { limit: 20, offset: 0, count: 1, total: 1, hasMore: false },
    });
    await expect(listOpenViewSavedViews({ moduleId })).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: viewId,
          moduleId,
          ownerId: userId,
          audience: { kind: "identity", id: userId },
          visibility: "workspace",
          canEdit: true,
          revision: 7,
          definition,
          presentation,
        }),
      ],
      pagination: { limit: 20, offset: 0, count: 1, total: 1, hasMore: false },
    });
    await expect(getOpenViewSavedView(viewId)).resolves.toMatchObject({
      audience: { kind: "identity", id: userId },
      visibility: "workspace",
      definition,
      presentation,
    });
    await expect(listOpenViewPersonalDefaults()).resolves.toEqual({
      items: [{ moduleId, viewId, revision: 3 }],
      pagination: { limit: 20, offset: 0, count: 1, total: 1, hasMore: false },
    });
    await expect(
      queryOpenViewRecords({ moduleId, definition, limit: 25, offset: 0 }),
    ).resolves.toMatchObject({
      items: [
        {
          moduleId,
          data: { [fieldId]: "Pump 04" },
          isDeleted: false,
        },
      ],
      pagination: { limit: 25, offset: 0, count: 1, total: 1, hasMore: false },
    });
    expect(mock.requests.map(({ input }) => String(input))).toEqual([
      "/api/views/data-sources?limit=20&offset=0",
      `/api/views/data-sources/${moduleId}/fields?limit=20&offset=0`,
      "/api/views/audience-options?kind=role&limit=20&offset=0",
      "/api/views/audience-options?kind=user&limit=20&offset=0",
      `/api/views?module_id=${moduleId}&limit=20&offset=0`,
      `/api/views/${viewId}`,
      "/api/views/defaults?limit=20&offset=0",
      "/api/records/query",
    ]);
    expect(mock.requests[7]?.init?.body).toBe(
      JSON.stringify({
        module_id: moduleId,
        definition: {
          version: 1,
          logic: "or",
          columns: [{ field_id: fieldId, expected_type: "text" }],
          filters: [
            {
              field_id: fieldId,
              expected_type: "text",
              operator: "suffix",
              value: "urgent",
            },
          ],
          sort: [
            { field_id: fieldId, expected_type: "text", direction: "desc" },
          ],
          deleted: "exclude",
          search: "pump",
          search_fields: [{ field_id: fieldId, expected_type: "text" }],
        },
        limit: 25,
        offset: 0,
      }),
    );
  } finally {
    mock.restore();
  }
});

test("maps legacy visibility-only saved-view responses and omitted timeline fields", async () => {
  const legacyPresentation = Object.fromEntries(
    Object.entries(viewResponse.presentation).filter(
      ([key]) => !key.startsWith("timeline_"),
    ),
  );
  const legacyPresentationDomain = Object.fromEntries(
    Object.entries(presentation).filter(([key]) => !key.startsWith("timeline")),
  );
  const legacyView = {
    ...viewResponse,
    audience: undefined,
    presentation: legacyPresentation,
  };
  const mock = installFetch(() => Response.json(legacyView));
  try {
    const savedView = await getOpenViewSavedView(viewId);
    expect(savedView).toMatchObject({
      audience: { kind: "everyone" },
      visibility: "workspace",
    });
    expect(savedView.presentation).toEqual(legacyPresentationDomain);
    expect(savedView.presentation).not.toHaveProperty("timelineStartFieldId");
    expect(savedView.presentation).not.toHaveProperty("timelineEndFieldId");
    expect(savedView.presentation).not.toHaveProperty(
      "timelineDeadlineFieldId",
    );
    expect(savedView.presentation).not.toHaveProperty(
      "timelineProgressFieldId",
    );
  } finally {
    mock.restore();
  }
});

test("defaults omitted Timeline presentation fields to null on the wire", async () => {
  const legacyPresentation = {
    version: 1 as const,
    layout: "table" as const,
    columnFieldIds: [fieldId],
    pinnedFieldIds: [fieldId],
    density: "comfortable" as const,
    wrap: true,
    cardSize: "compact" as const,
    primaryFieldId: fieldId,
    secondaryFieldId: null,
    dateFieldId: null,
    groupByFieldId: null,
    dateRange: "month" as const,
    scale: null,
  };
  const mock = installFetch(() => Response.json(viewResponse));
  try {
    await createOpenViewSavedView({
      moduleId,
      name: "Legacy layout",
      audience: { kind: "private" },
      definition,
      presentation: legacyPresentation,
    });
    expect(
      JSON.parse(String(mock.requests[0]?.init?.body)).presentation,
    ).toMatchObject({
      timeline_start_field_id: null,
      timeline_end_field_id: null,
      timeline_deadline_field_id: null,
      timeline_progress_field_id: null,
    });
  } finally {
    mock.restore();
  }
});

test("requests archived saved views when the restore list includes deleted views", async () => {
  const mock = installFetch(() =>
    Response.json({
      items: [],
      pagination: { ...pagination, count: 0, total: 0 },
    }),
  );
  try {
    await expect(
      listOpenViewSavedViews({ moduleId, deleted: "include" }),
    ).resolves.toEqual({
      items: [],
      pagination: { limit: 20, offset: 0, count: 0, total: 0, hasMore: false },
    });
    expect(String(mock.requests[0]?.input)).toBe(
      `/api/views?module_id=${moduleId}&limit=20&offset=0&deleted=include`,
    );
  } finally {
    mock.restore();
  }
});

test("sends a backend-valid Timeline view and personal-default commands with explicit revisions", async () => {
  const saved: OpenViewSavedView = {
    id: viewId,
    moduleId,
    ownerId: userId,
    name: "Urgent queue",
    audience: { kind: "role", id: roleId },
    visibility: "workspace",
    definition: timelineDefinition,
    presentation: timelinePresentation,
    canEdit: true,
    revision: 7,
    isDeleted: false,
    createdAt: "2026-09-23T00:00:00Z",
    updatedAt: "2026-09-23T00:00:00Z",
  };
  const mock = installFetch((_input, init) => {
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (init?.method === "PUT") {
      return Response.json({
        module_id: moduleId,
        view_id: viewId,
        revision: 7,
      });
    }
    return Response.json(timelineViewResponse);
  });
  try {
    const createdView = await createOpenViewSavedView({
      moduleId,
      name: saved.name,
      audience: saved.audience,
      definition: timelineDefinition,
      presentation: timelinePresentation,
    });
    expect(createdView.definition).toEqual(timelineDefinition);
    expect(createdView.presentation).toMatchObject(timelinePresentation);
    await updateOpenViewSavedView({
      id: viewId,
      revision: 7,
      name: "Updated queue",
      audience: { kind: "everyone" },
      definition: timelineDefinition,
      presentation: timelinePresentation,
    });
    await archiveOpenViewSavedView({ id: viewId, revision: 7 });
    await restoreOpenViewSavedView({ id: viewId, revision: 8 });
    await setOpenViewPersonalDefault({ moduleId, viewId });
    await unsetOpenViewPersonalDefault(moduleId);

    expect(
      mock.requests.map(({ input, init }) => [String(input), init?.method]),
    ).toEqual([
      ["/api/views", "POST"],
      [`/api/views/${viewId}`, "PATCH"],
      [`/api/views/${viewId}?revision=7`, "DELETE"],
      [`/api/views/${viewId}/restore`, "POST"],
      [`/api/views/defaults/${moduleId}`, "PUT"],
      [`/api/views/defaults/${moduleId}`, "DELETE"],
    ]);
    expect(mock.requests[0]?.init?.body).toBe(
      JSON.stringify({
        module_id: moduleId,
        name: "Urgent queue",
        audience: { kind: "role", role_id: roleId },
        definition: {
          version: 1,
          logic: "or",
          columns: [
            { field_id: fieldId, expected_type: "text" },
            { field_id: timelineStartFieldId, expected_type: "date" },
            { field_id: timelineEndFieldId, expected_type: "datetime" },
          ],
          filters: [
            {
              field_id: fieldId,
              expected_type: "text",
              operator: "suffix",
              value: "urgent",
            },
          ],
          sort: [
            { field_id: fieldId, expected_type: "text", direction: "desc" },
          ],
          deleted: "exclude",
          search: "pump",
          search_fields: [{ field_id: fieldId, expected_type: "text" }],
        },
        presentation: {
          version: 1,
          layout: "timeline",
          column_field_ids: [fieldId],
          pinned_field_ids: [fieldId],
          density: "comfortable",
          wrap: true,
          card_size: "compact",
          primary_field_id: fieldId,
          secondary_field_id: null,
          date_field_id: null,
          timeline_start_field_id: timelineStartFieldId,
          timeline_end_field_id: timelineEndFieldId,
          timeline_deadline_field_id: null,
          timeline_progress_field_id: null,
          group_by_field_id: null,
          date_range: "month",
          scale: null,
        },
      }),
    );
    expect(mock.requests[1]?.init?.body).toBe(
      JSON.stringify({
        revision: 7,
        name: "Updated queue",
        audience: { kind: "everyone" },
        definition: JSON.parse(String(mock.requests[0]?.init?.body)).definition,
        presentation: JSON.parse(String(mock.requests[0]?.init?.body))
          .presentation,
      }),
    );
    expect(mock.requests[3]?.init?.body).toBe(JSON.stringify({ revision: 8 }));
    expect(mock.requests[4]?.init?.body).toBe(
      JSON.stringify({ view_id: viewId }),
    );
  } finally {
    mock.restore();
  }
});

test("rejects malformed payloads, relationship fields, and preserves conflicts", async () => {
  const malformed = installFetch(() =>
    Response.json({
      items: [{ id: "not-a-uuid", name: "Broken" }],
      pagination,
    }),
  );
  try {
    await expect(listOpenViewDataSources()).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    malformed.restore();
  }

  const malformedPagination = installFetch(() =>
    Response.json({
      items: [{ id: moduleId, name: "Equipment", department_id: departmentId }],
      pagination: { ...pagination, limit: 0 },
    }),
  );
  try {
    await expect(listOpenViewDataSources()).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    malformedPagination.restore();
  }

  const relationship = installFetch(() =>
    Response.json({
      items: [
        {
          id: fieldId,
          module_id: moduleId,
          name: "Related item",
          type: "relationship",
          required: false,
          position: 0,
          config: {},
        },
      ],
      pagination,
    }),
  );
  try {
    await expect(listOpenViewDataSourceFields(moduleId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    relationship.restore();
  }

  const conflict = installFetch(() =>
    Response.json(
      {
        detail: {
          code: "stale_revision",
          message: "View changed; reload before saving",
          current_revision: 9,
        },
      },
      { status: 409 },
    ),
  );
  try {
    await expect(
      updateOpenViewSavedView({ id: viewId, revision: 7, name: "Stale" }),
    ).rejects.toBeInstanceOf(ApiError);
    let conflictError: unknown;
    try {
      await updateOpenViewSavedView({ id: viewId, revision: 7, name: "Stale" });
    } catch (error) {
      conflictError = error;
    }
    expect(getOpenViewConflict(conflictError)).toEqual({
      code: "stale_revision",
      message: "View changed; reload before saving",
      currentRevision: 9,
    });
  } finally {
    conflict.restore();
  }

  const invalidRequest = installFetch(() => Response.json({}));
  try {
    await expect(
      listOpenViewSavedViews({ moduleId: "not-a-uuid" }),
    ).rejects.toThrow();
    await expect(
      listOpenViewSavedViews({ moduleId, limit: 0 }),
    ).rejects.toThrow();
    expect(invalidRequest.requests).toHaveLength(0);
  } finally {
    invalidRequest.restore();
  }
});

test("keeps durable API commands independent of sample-provider values", async () => {
  const mock = installFetch(() => Response.json(viewResponse));
  try {
    await createOpenViewSavedView({
      moduleId,
      name: "API-only view",
      audience: { kind: "private" },
      definition,
      presentation,
    });
    const body = String(mock.requests[0]?.init?.body);
    expect(body).not.toContain("sample-sr-");
    expect(body).not.toContain("service-requests");
  } finally {
    mock.restore();
  }
});
