import { expect, test } from "@playwright/test";
import { toast } from "../../../src/components/ui/toast";
import { reportDone, reportError } from "../../../src/lib/feedback";

test("errors merge until close while each success remains independent", () => {
  toast.resumeWorkspace();
  const calls: Parameters<typeof toast.add>[0][] = [];
  const original = toast.add;
  toast.add = (options) => {
    calls.push(options);
    return original(options);
  };
  try {
    reportError("Could not save this item.");
    reportError("Could not save this item.");
    expect(calls).toHaveLength(1);
    calls[0].onClose?.();
    reportError("Could not save this item.");
    expect(calls).toHaveLength(2);
    reportDone("Item saved.");
    reportDone("Item saved.");
    expect(calls.slice(2).map((item) => item.type)).toEqual([
      "success",
      "success",
    ]);
  } finally {
    toast.add = original;
    toast.clearWorkspace();
  }
});
