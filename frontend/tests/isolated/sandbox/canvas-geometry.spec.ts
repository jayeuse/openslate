import { expect, test } from "@playwright/test";

import type {
  SandboxCanvasLayout,
  SandboxState,
} from "../../../src/lib/sandbox/model";
import {
  DEPARTMENT_MIN,
  designInView,
  MODULE_TABLE,
  moduleTableHeight,
  resizeFrame,
  resolveDrop,
} from "../../../src/lib/sandbox/canvas-geometry";
import {
  canvasBoxes,
  deriveFlowEdges,
  deriveFlowNodes,
  fitFlowFrames,
  placeFlowNode,
  readCanvasLayout,
  reparentFlowNode,
} from "../../../src/components/sandbox/sandbox-flow-model";

// The canvas keeps modules as children of their department frame, with
// positions relative to the frame. The owner's layout, drops, and the view
// API use absolute canvas positions. These tests own that conversion and the
// rules that keep a module still on screen while frames change.

function sample(): SandboxState {
  return {
    departments: [
      { id: "sales", name: "Sales", moduleIds: ["customers", "orders"] },
      { id: "stock", name: "Stock", moduleIds: ["products"] },
    ],
    modules: [
      {
        id: "customers",
        departmentId: "sales",
        name: "Customers",
        fieldIds: ["name", "email"],
      },
      {
        id: "orders",
        departmentId: "sales",
        name: "Orders",
        fieldIds: ["total"],
      },
      {
        id: "products",
        departmentId: "stock",
        name: "Products",
        fieldIds: [],
      },
    ],
    fields: [
      {
        id: "name",
        moduleId: "customers",
        name: "Name",
        type: "text",
        required: true,
        description: "",
      },
      {
        id: "email",
        moduleId: "customers",
        name: "Email",
        type: "email",
        required: false,
        description: "",
      },
      {
        id: "total",
        moduleId: "orders",
        name: "Total",
        type: "decimal",
        required: false,
        description: "",
      },
    ],
    links: [
      {
        id: "places",
        sourceModuleId: "customers",
        targetModuleId: "orders",
        label: "places",
        direction: "directed",
      },
      {
        id: "ships",
        sourceModuleId: "orders",
        targetModuleId: "products",
        label: "",
        direction: "directed",
      },
    ],
    selectedCellId: null,
  };
}

const layout: SandboxCanvasLayout = {
  sales: { x: 48, y: 48, width: 680, height: 400 },
  customers: { x: 96, y: 120, width: 232, height: moduleTableHeight(2) },
  orders: { x: 408, y: 120, width: 232, height: moduleTableHeight(1) },
  stock: { x: 808, y: 48, width: 400, height: 240 },
  products: { x: 856, y: 120, width: 232, height: moduleTableHeight(0) },
};

test("modules sit inside their frame and the layout reads back absolute", () => {
  const nodes = deriveFlowNodes({ state: sample(), previous: [], layout });
  const customers = nodes.find((node) => node.id === "customers");
  expect(customers?.parentId).toBe("sales");
  expect(customers?.position).toEqual({ x: 48, y: 72 });
  // Parents come before their children, as React Flow requires.
  expect(nodes.findIndex((node) => node.id === "sales")).toBeLessThan(
    nodes.findIndex((node) => node.id === "customers"),
  );
  expect(readCanvasLayout(nodes)).toEqual(layout);
});

test("nothing changed returns the same nodes and edges", () => {
  const state = sample();
  const nodes = deriveFlowNodes({ state, previous: [], layout });
  expect(deriveFlowNodes({ state: sample(), previous: nodes })).toBe(nodes);
  const edges = deriveFlowEdges(state, []);
  expect(deriveFlowEdges(sample(), edges)).toBe(edges);
});

test("selecting a field re-renders only its module", () => {
  const nodes = deriveFlowNodes({ state: sample(), previous: [], layout });
  const next = deriveFlowNodes({
    state: { ...sample(), selectedCellId: "email" },
    previous: nodes,
  });
  const changed = next.filter((node, index) => node !== nodes[index]);
  expect(changed.map((node) => node.id)).toEqual(["customers"]);
  expect(changed[0]?.data).toMatchObject({ selectedFieldId: "email" });
});

test("a new layout moves nodes; without one, the shown geometry stays", () => {
  const nodes = deriveFlowNodes({ state: sample(), previous: [], layout });
  const moved = placeFlowNode(nodes, "orders", { x: 432, y: 144 });
  expect(deriveFlowNodes({ state: sample(), previous: moved })).toBe(moved);
  const restored = deriveFlowNodes({
    state: sample(),
    previous: moved,
    layout,
  });
  expect(readCanvasLayout(restored)).toEqual(layout);
});

test("a frame growing left or up leaves its modules where they are", () => {
  const nodes = deriveFlowNodes({ state: sample(), previous: [], layout });
  // A module dragged past the top-left corner of its frame.
  const dragged = placeFlowNode(nodes, "customers", { x: 24, y: 0 });
  const fitted = readCanvasLayout(fitFlowFrames(dragged));
  expect(fitted.customers).toEqual({ ...layout.customers, x: 24, y: 0 });
  expect(fitted.orders).toEqual(layout.orders);
  expect(fitted.sales).toEqual({ x: 0, y: -48, width: 728, height: 496 });
});

test("frames start small when empty and grow to their modules", () => {
  const state = sample();
  const nodes = deriveFlowNodes({ state, previous: [] });
  const stock = readCanvasLayout(nodes).stock;
  expect(stock?.width).toBeGreaterThanOrEqual(DEPARTMENT_MIN.width);
  const boxes = canvasBoxes(nodes);
  for (const { box, departmentId } of boxes.modules) {
    const frame = boxes.departments.find((item) => item.id === departmentId);
    expect(frame?.id).toBe(departmentId);
    expect(box.x).toBeGreaterThanOrEqual(frame!.box.x);
    expect(box.y).toBeGreaterThanOrEqual(frame!.box.y);
    expect(box.x + box.width).toBeLessThanOrEqual(
      frame!.box.x + frame!.box.width,
    );
  }
});

test("moving a module to another department keeps it still on screen", () => {
  const nodes = deriveFlowNodes({ state: sample(), previous: [], layout });
  const moved = reparentFlowNode(nodes, "orders", "stock");
  const orders = moved.find((node) => node.id === "orders");
  expect(orders?.parentId).toBe("stock");
  expect(readCanvasLayout(moved).orders).toEqual(layout.orders);
});

test("a resized frame snaps to the grid but never cuts a module", () => {
  const frame = layout.sales!;
  const modules = [layout.customers!, layout.orders!];
  // Orders' right edge (640) and Customers' bottom, plus the 24px margin.
  expect(resizeFrame(frame, modules, 100, 100, false)).toEqual({
    width: 640 - 48 + 24,
    height: 120 + moduleTableHeight(2) - 48 + 24,
  });
  expect(resizeFrame(frame, modules, 1010, 500, false)).toEqual({
    width: 1008,
    height: 504,
  });
  expect(resizeFrame(frame, modules, 1010, 500, true)).toEqual({
    width: 1010,
    height: 500,
  });
});

test("palette drops follow the containment rules", () => {
  const boxes = canvasBoxes(
    deriveFlowNodes({ state: sample(), previous: [], layout }),
  );
  const insideCustomers = { x: 100, y: 130 };
  const insideSalesOnly = { x: 60, y: 400 };
  expect(resolveDrop(boxes, "field", insideCustomers)).toEqual({
    parentId: "customers",
    targetId: "customers",
    error: null,
  });
  expect(resolveDrop(boxes, "module", insideCustomers).parentId).toBe("sales");
  expect(resolveDrop(boxes, "module", insideSalesOnly).parentId).toBe("sales");
  expect(resolveDrop(boxes, "field", insideSalesOnly).error).toBe(
    "Fields can only be added inside a module.",
  );
  expect(resolveDrop(boxes, "department", { x: 2000, y: 2000 })).toEqual({
    parentId: null,
    targetId: null,
    error: null,
  });
});

test("a line between departments is a handoff and keeps its label", () => {
  const edges = deriveFlowEdges({ ...sample(), selectedCellId: "ships" }, []);
  expect(edges.map((edge) => [edge.id, edge.data])).toEqual([
    ["places", { label: "places", handoff: false, selected: false }],
    ["ships", { label: "", handoff: true, selected: true }],
  ]);
  expect(edges[0]).toMatchObject({
    source: "customers",
    target: "orders",
    sourceHandle: "out",
    targetHandle: "in",
  });
  expect(MODULE_TABLE.width).toBe(232);
});

test("the whole design is in view only when every edge shows", () => {
  const bounds = { x: 100, y: 50, width: 400, height: 300 };
  const view = { width: 600, height: 400 };
  for (const [viewport, inView, reason] of [
    [{ x: -50, y: 0, zoom: 1 }, true, "fitted inside the view"],
    [{ x: -100, y: -50, zoom: 1 }, true, "edges touch the view edges"],
    [{ x: -101, y: 0, zoom: 1 }, false, "panned past the left edge"],
    [{ x: 0, y: 51, zoom: 1 }, false, "panned past the bottom edge"],
    [{ x: -100, y: -50, zoom: 1.5 }, false, "zoomed in"],
    [{ x: 0, y: 0, zoom: 0.5 }, true, "zoomed out"],
  ] as const)
    expect(designInView(bounds, viewport, view), reason).toBe(inView);
  // An empty design and a canvas that has not measured yet need no minimap.
  expect(designInView(null, { x: 0, y: 0, zoom: 1 }, view)).toBe(true);
  expect(
    designInView(bounds, { x: 0, y: 0, zoom: 1 }, { width: 0, height: 0 }),
  ).toBe(true);
});

test("the minimap state holds near the view edge until a clear margin", () => {
  const bounds = { x: 0, y: 0, width: 400, height: 300 };
  const view = { width: 600, height: 400 };
  for (const [viewport, previous, inView, reason] of [
    [{ x: 4, y: 4, zoom: 1 }, false, false, "just inside: stays shown"],
    [{ x: 100, y: 50, zoom: 1 }, false, true, "well inside: hides"],
    [{ x: -4, y: 4, zoom: 1 }, true, true, "just past an edge: stays hidden"],
    [{ x: -40, y: 4, zoom: 1 }, true, false, "well past an edge: shows"],
  ] as const)
    expect(designInView(bounds, viewport, view, previous), reason).toBe(inView);
});
