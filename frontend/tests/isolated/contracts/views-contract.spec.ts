import {
  createOpenViewSavedView,
  getOpenViewSavedView,
  updateOpenViewSavedView,
} from "../../../src/components/systems/openview/adapters/views-api";
import type { OpenViewDataSourceField } from "../../../src/components/systems/openview/adapters/views-api";
import {
  emptyDefinition,
  emptyPresentation,
} from "../../../src/components/systems/openview/domain/server-view-draft";
import { describeContracts } from "./openapi-contract";

const viewId = "00000000-0000-4000-8000-000000000011";
const moduleId = "00000000-0000-4000-8000-000000000012";
const fields: OpenViewDataSourceField[] = [
  {
    id: "00000000-0000-4000-8000-000000000013",
    moduleId,
    name: "Name",
    type: "text",
    required: false,
    position: 0,
    config: {},
  },
];

// The adapter refuses a pinned field that is not a visible column and an
// "equals" filter with no value, which the generated sample does not avoid.
const pinnedVisible = {
  definition: { filters: [] },
  presentation: { pinned_field_ids: [] },
};

// A saved View's presentation is `extra="forbid"` on the server, so a key the
// backend no longer declares is a 422 there and a contract problem here.
describeContracts("OpenView saved views", [
  {
    name: "getOpenViewSavedView",
    run: () => getOpenViewSavedView(viewId),
    responses: { "GET /api/views/{view_id}": pinnedVisible },
  },
  {
    name: "createOpenViewSavedView",
    run: () =>
      createOpenViewSavedView({
        moduleId,
        name: "Open requests",
        isDefault: false,
        definition: emptyDefinition(fields),
        presentation: { ...emptyPresentation(fields), layout: "gallery" },
      }),
    responses: { "POST /api/views": pinnedVisible },
  },
  {
    name: "updateOpenViewSavedView",
    run: () =>
      updateOpenViewSavedView({
        id: viewId,
        revision: 2,
        presentation: emptyPresentation(fields),
      }),
    responses: { "PATCH /api/views/{view_id}": pinnedVisible },
  },
]);
