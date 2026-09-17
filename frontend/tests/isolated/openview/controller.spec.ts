import { expect, test } from "@playwright/test";
import { createSampleRuntime } from "../../../src/components/sample/sample-runtime";
import { saveReportTemplateRecipe } from "../../../src/components/sample/openview/controller";
import { decodeSampleStoredValue } from "../../../src/components/sample/sample-state";
import {
  decodeReport,
  decodeReports,
  projectAudienceLookup,
} from "../../../src/components/sample/openview/model";
import {
  initialPeople,
  initialRoles,
} from "../../../src/components/sample/access/model";
import {
  initialReport,
  initialReportTemplates,
} from "../../../src/components/sample/openview/seeds";

const lookup = projectAudienceLookup(initialRoles, initialPeople);

function report(id: string, name: string) {
  return {
    ...decodeReport(initialReport, lookup),
    id,
    name,
    fields: ["title"],
  };
}

test("report template save atomically keeps the selected identity through create, restore, update, and rejection", () => {
  const created = report("report:repair", "Repair queue");
  const runtime = createSampleRuntime(decodeSampleStoredValue, {
    "access-roles": initialRoles,
    "access-people": initialPeople,
    "views-report-templates": initialReportTemplates,
    "views-report-draft": initialReport,
  });

  expect(runtime.commit(saveReportTemplateRecipe({ report: created }))).toEqual(
    {
      ok: true,
      value: created,
    },
  );
  const createdSnapshot = runtime.getSnapshot();
  expect(createdSnapshot["views-report-template-selected"]).toBe(created.id);
  expect(
    decodeReports(createdSnapshot["views-report-templates"], lookup),
  ).toEqual([created]);
  expect(decodeReport(createdSnapshot["views-report-draft"], lookup)).toEqual(
    created,
  );

  const restoredRuntime = createSampleRuntime(
    decodeSampleStoredValue,
    createdSnapshot,
  );
  const updated = { ...created, name: "Repair queue weekly" };
  expect(
    restoredRuntime.commit(
      saveReportTemplateRecipe({
        report: updated,
        expectedId: created.id,
        expected: created,
      }),
    ),
  ).toEqual({ ok: true, value: updated });
  const updatedSnapshot = restoredRuntime.getSnapshot();
  expect(updatedSnapshot["views-report-template-selected"]).toBe(created.id);
  expect(
    decodeReports(updatedSnapshot["views-report-templates"], lookup),
  ).toEqual([updated]);

  const beforeRejectedSave = structuredClone(updatedSnapshot);
  expect(
    restoredRuntime.commit(
      saveReportTemplateRecipe({
        report: { ...updated, name: "Should not overwrite" },
        expectedId: updated.id,
        expected: created,
      }),
    ),
  ).toEqual({
    ok: false,
    error:
      "This report template changed while it was being saved. Keep the editor open and try again.",
  });
  expect(restoredRuntime.getSnapshot()).toEqual(beforeRejectedSave);
});
