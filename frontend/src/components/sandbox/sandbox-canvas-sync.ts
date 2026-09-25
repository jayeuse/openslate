import { Point, routerPresets } from "@antv/x6";
import type { Graph, History, Node } from "@antv/x6";
import {
  fieldsForModule,
  type SandboxCanvasLayout,
  type SandboxState,
} from "@/lib/sandbox/model";
import {
  getModulePorts,
  MODULE_TABLE,
  moduleTableAttrs,
  moduleTableHeight,
  moduleTableMarkup,
  relationshipLineAttrs,
  toCells,
} from "@/lib/sandbox/x6-adapter";
import {
  departmentHeight,
  departmentNodeAttrs,
  departmentPosition,
  DEPARTMENT_WIDTH,
  fitDepartmentFrames,
  modulePosition,
  nodeKindOf,
  type CanvasFeedback,
  type CanvasPosition,
} from "./sandbox-canvas-graph";

type MutableCurrent<T> = { current: T };

interface SandboxCanvasSynchronization {
  graph: Graph;
  history: History;
  state: SandboxState;
  layout: SandboxCanvasLayout | undefined;
  movingNodeId: string | null;
  dropTargetId: string | null;
  pendingPositions: MutableCurrent<Map<string, CanvasPosition>>;
  appliedLayout: MutableCurrent<SandboxCanvasLayout | undefined>;
  syncing: MutableCurrent<boolean>;
}

export function synchronizeSandboxCanvas({
  graph,
  history,
  state,
  layout,
  movingNodeId,
  dropTargetId,
  pendingPositions,
  appliedLayout,
  syncing,
}: SandboxCanvasSynchronization): void {
  const fieldsById = new Map(state.fields.map((field) => [field.id, field]));

  syncing.current = true;
  history.disable();
  try {
    graph.options.interacting = { edgeLabelMovable: false };

    const descriptors = toCells(state);
    const descriptorIds = new Set(descriptors.map((cell) => cell.id));
    for (const edge of graph.getEdges()) {
      if (!descriptorIds.has(edge.id)) {
        edge.remove();
      }
    }
    for (const node of graph.getNodes()) {
      if (!descriptorIds.has(node.id)) {
        node.remove();
      }
    }

    const departmentNodes = new Map<string, Node>();
    const moduleNodes = new Map<string, Node>();
    for (const [index, department] of state.departments.entries()) {
      const departmentModules = state.modules.filter(
        (sandboxModule) => sandboxModule.departmentId === department.id,
      );
      const moduleHeights = departmentModules.map((sandboxModule) =>
        moduleTableHeight(sandboxModule.fieldIds.length),
      );
      const height =
        departmentModules.length === 0 ? 144 : departmentHeight(moduleHeights);
      const departmentFeedback: CanvasFeedback =
        movingNodeId === department.id
          ? "moving"
          : dropTargetId === department.id
            ? "drop"
            : null;
      const departmentSelected = state.selectedCellId === department.id;
      const departmentAttrs = departmentNodeAttrs(
        department.name,
        department.moduleIds.length,
        height,
        departmentSelected,
        departmentFeedback,
      );
      const existing = graph.getCellById(department.id);
      const departmentNode =
        existing !== null && existing.isNode()
          ? existing
          : graph.addNode({
              id: department.id,
              shape: "rect",
              ...(pendingPositions.current.get(department.id) ??
                departmentPosition(index)),
              width: departmentModules.length === 0 ? 336 : DEPARTMENT_WIDTH,
              height,
              markup: [
                { tagName: "rect", selector: "body" },
                { tagName: "text", selector: "heading" },
                { tagName: "text", selector: "subheading" },
                { tagName: "rect", selector: "resizeGrip" },
                { tagName: "path", selector: "resizeLines" },
              ],
              attrs: departmentAttrs,
              data: { kind: "department", departmentId: department.id },
            });

      if (existing !== null && !existing.isNode()) {
        existing.remove();
      }
      pendingPositions.current.delete(department.id);

      const frameSize = departmentNode.getSize();
      departmentNode.setAttrs({
        ...departmentAttrs,
        body: { ...departmentAttrs.body, ...frameSize },
        subheading: {
          ...departmentAttrs.subheading,
          x: frameSize.width - 12,
        },
      });
      departmentNode.setData({
        kind: "department",
        departmentId: department.id,
      });
      departmentNodes.set(department.id, departmentNode);
    }

    for (const department of state.departments) {
      const departmentNode = departmentNodes.get(department.id);
      if (departmentNode === undefined) {
        continue;
      }
      const departmentModules = state.modules.filter(
        (sandboxModule) => sandboxModule.departmentId === department.id,
      );
      for (const [index, sandboxModule] of departmentModules.entries()) {
        const moduleFields = fieldsForModule(
          sandboxModule.id,
          sandboxModule.fieldIds,
          fieldsById,
        );
        const moduleHeight = moduleTableHeight(moduleFields.length);
        const existing = graph.getCellById(sandboxModule.id);
        let moduleNode: Node;
        if (existing !== null && existing.isNode()) {
          moduleNode = existing;
        } else {
          if (existing !== null) {
            existing.remove();
          }
          const pendingPosition = pendingPositions.current.get(
            sandboxModule.id,
          );
          moduleNode = graph.addNode({
            id: sandboxModule.id,
            shape: "rect",
            ...(pendingPosition ??
              modulePosition(
                departmentNode,
                index,
                departmentModules.map((item) =>
                  moduleTableHeight(item.fieldIds.length),
                ),
              )),
            width: MODULE_TABLE.width,
            height: moduleHeight,
            markup: moduleTableMarkup(moduleFields.length),
            attrs: moduleTableAttrs(
              sandboxModule.name,
              moduleFields,
              state.selectedCellId,
              state.selectedCellId === sandboxModule.id,
              movingNodeId === sandboxModule.id
                ? "moving"
                : dropTargetId === sandboxModule.id
                  ? "drop"
                  : null,
            ),
            ports: {
              ...getModulePorts(state.selectedCellId === sandboxModule.id),
              items: [
                { id: `${sandboxModule.id}-in`, group: "in" },
                { id: `${sandboxModule.id}-out`, group: "out" },
              ],
            },
            data: {
              kind: "module",
              moduleId: sandboxModule.id,
              departmentId: sandboxModule.departmentId,
            },
          });
          pendingPositions.current.delete(sandboxModule.id);
        }

        const parent = moduleNode.getParent();
        if (parent?.id !== departmentNode.id) {
          const position = moduleNode.getPosition();
          departmentNode.addChild(moduleNode, { ui: true });
          moduleNode.setPosition(position);
        }
        moduleNode.setSize(MODULE_TABLE.width, moduleHeight);
        moduleNode.setMarkup(moduleTableMarkup(moduleFields.length));
        moduleNode.setAttrs(
          moduleTableAttrs(
            sandboxModule.name,
            moduleFields,
            state.selectedCellId,
            state.selectedCellId === sandboxModule.id,
            movingNodeId === sandboxModule.id
              ? "moving"
              : dropTargetId === sandboxModule.id
                ? "drop"
                : null,
          ),
        );
        moduleNode.setData({
          kind: "module",
          moduleId: sandboxModule.id,
          departmentId: sandboxModule.departmentId,
        });
        for (const portId of [
          `${sandboxModule.id}-in`,
          `${sandboxModule.id}-out`,
        ]) {
          if (!moduleNode.hasPort(portId)) {
            moduleNode.addPort({
              id: portId,
              group: portId.endsWith("-in") ? "in" : "out",
            });
          }
          moduleNode.setPortProp(portId, ["attrs", "circle", "magnet"], true);
          moduleNode.setPortProp(
            portId,
            ["attrs", "circle", "opacity"],
            state.selectedCellId === sandboxModule.id ||
              moduleFields.some((field) => field.id === state.selectedCellId)
              ? 1
              : 0,
          );
        }
        moduleNodes.set(sandboxModule.id, moduleNode);
      }
    }

    // Apply external restores once. Selection/rename and in-flight drag
    // feedback must never reset a node to the last persisted coordinates.
    if (layout !== undefined && layout !== appliedLayout.current) {
      for (const [id, box] of Object.entries(layout)) {
        const node = graph.getCellById(id);
        if (!node?.isNode()) continue;
        // Child positions are absolute, so restore frames without translating children.
        node.setPosition(box.x, box.y, { deep: false });
        if (nodeKindOf(node) === "department")
          node.setSize(box.width, box.height);
      }
      appliedLayout.current = layout;
    }
    if (movingNodeId === null) fitDepartmentFrames(graph);

    for (const link of state.links) {
      const sourceNode = moduleNodes.get(link.sourceModuleId);
      const targetNode = moduleNodes.get(link.targetModuleId);
      if (sourceNode === undefined || targetNode === undefined) {
        continue;
      }
      const relationshipRouter = {
        name: "manhattan",
        args: {
          // A 24px halo on both cards closes the compact 48px corridor.
          padding: 12,
          startDirections: ["right"],
          endDirections: ["left"],
          excludeNodes: state.departments.map((department) => department.id),
          // Overlapping cards have no obstacle-free route. X6's route-level
          // fallback handles that normal editing state before its warning.
          fallbackRoute: () => {
            const view = graph.findViewByCell(link.id);
            if (!view?.isEdgeView()) return [];
            return routerPresets.orth
              .call(view, [], { padding: 12 }, view)
              .map((point) => Point.create(point));
          },
        },
      };
      const source = {
        cell: link.sourceModuleId,
        port: `${link.sourceModuleId}-out`,
      };
      const target = {
        cell: link.targetModuleId,
        port: `${link.targetModuleId}-in`,
      };
      const linkAttrs = {
        line: relationshipLineAttrs(state.selectedCellId === link.id),
      };
      const linkLabels =
        link.label.trim() === ""
          ? []
          : [
              {
                markup: [
                  { tagName: "rect", selector: "body" },
                  { tagName: "text", selector: "label" },
                ],
                attrs: {
                  label: {
                    fontSize: 10,
                    fill: "var(--card-foreground, #20242c)",
                    pointerEvents: "none",
                    text: link.label,
                  },
                  body: {
                    ref: "label",
                    fill: "var(--card, #ffffff)",
                    stroke: "var(--border, #e4e7ec)",
                    strokeWidth: 1,
                    rx: 3,
                    ry: 3,
                    refWidth: 10,
                    refHeight: 6,
                    refX: -5,
                    refY: -3,
                  },
                },
              },
            ];
      const existing = graph.getCellById(link.id);
      const edge =
        existing !== null && existing.isEdge()
          ? existing
          : graph.addEdge({
              id: link.id,
              source,
              target,
              router: relationshipRouter,
              connector: { name: "normal" },
              attrs: linkAttrs,
              labels: linkLabels,
              data: { kind: "link", linkId: link.id },
            });
      if (existing !== null && !existing.isEdge()) {
        existing.remove();
      }
      edge.setSource(source);
      edge.setTarget(target);
      edge.setRouter(relationshipRouter);
      edge.setConnector({ name: "normal" });
      edge.setAttrs(linkAttrs);
      edge.setLabels(linkLabels);
      edge.setData({ kind: "link", linkId: link.id });
    }

    graph.cleanSelection();
    if (state.selectedCellId === null) {
      graph.cleanSelection();
    } else {
      const selectedField = fieldsById.get(state.selectedCellId);
      const selectedId = selectedField?.moduleId ?? state.selectedCellId;
      if (graph.getCellById(selectedId) !== null) {
        graph.select(selectedId);
      }
    }
  } finally {
    history.enable();
    syncing.current = false;
  }
}
