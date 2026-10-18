"use client";

import {
  createContext,
  memo,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  getSmoothStepPath,
  Handle,
  Position,
  type EdgeProps,
  type NodeProps,
} from "@xyflow/react";

import { FIELD_TYPE_META } from "@/lib/sandbox/model";
import {
  DEPARTMENT_HEAD_HEIGHT,
  MODULE_TABLE,
  moduleTableHeight,
  relationshipLineAttrs,
  truncateLabel,
} from "@/lib/sandbox/canvas-geometry";
import type {
  DepartmentFlowNode,
  ModuleFlowNode,
  RelationshipFlowEdge,
} from "./sandbox-flow-model";
import {
  fieldMarkDescription,
  useFieldMarks,
  useTraceMark,
  type SandboxCanvasTraceStore,
} from "./sandbox-canvas-trace";

/**
 * Node and line views for the Sandbox canvas. Each draws the same SVG the
 * look stylesheets target (`data-sandbox-*` hooks, colors as presentation
 * attributes so the cascade can override them). Views are memoized and read
 * the canvas actions from one stable context.
 */

export interface CanvasEditRequest {
  target: "department" | "module" | "field";
  property: "name" | "type";
  id: string;
  nodeId: string;
  rowIndex?: number;
}

export interface SandboxCanvasActions {
  trace: SandboxCanvasTraceStore;
  openEditor: (request: CanvasEditRequest) => void;
  startResize: (departmentId: string, event: PointerEvent<SVGElement>) => void;
  resizeByKey: (departmentId: string, event: KeyboardEvent<SVGElement>) => void;
}

const SandboxCanvasActionsContext = createContext<SandboxCanvasActions | null>(
  null,
);

export const SandboxCanvasActionsProvider =
  SandboxCanvasActionsContext.Provider;

function useCanvasActions(): SandboxCanvasActions {
  const actions = useContext(SandboxCanvasActionsContext);
  if (actions === null)
    throw new Error("Sandbox canvas nodes need SandboxCanvasActionsProvider.");
  return actions;
}

/** A pointer event in the node's own canvas units, at any zoom. */
export function nodePoint(
  element: Element,
  clientX: number,
  clientY: number,
  width: number,
): { x: number; y: number } {
  const box = element.getBoundingClientRect();
  const scale = box.width > 0 ? box.width / width : 1;
  return { x: (clientX - box.left) / scale, y: (clientY - box.top) / scale };
}

const CANVAS_NODE_ACTIVE = "var(--primary)";

function DepartmentNodeView({
  id,
  data,
  width = 0,
  height = 0,
}: NodeProps<DepartmentFlowNode>) {
  const actions = useCanvasActions();
  const { name, moduleCount, tone, selected, feedback } = data;
  const moving = feedback === "moving";
  const dropTarget = feedback === "drop";
  const active = dropTarget || selected;
  return (
    <svg
      data-sandbox-node={id}
      width={width}
      height={height}
      overflow="visible"
      className="block"
      onDoubleClick={(event) => {
        const point = nodePoint(
          event.currentTarget,
          event.clientX,
          event.clientY,
          width,
        );
        if (point.y > 36) return;
        event.stopPropagation();
        actions.openEditor({
          target: "department",
          property: "name",
          id,
          nodeId: id,
        });
      }}
    >
      <rect
        // Theme skin hooks (src/app/themes).
        data-sandbox-body="true"
        data-sandbox-kind="department"
        data-selected={selected ? "true" : "false"}
        data-feedback={feedback ?? ""}
        width={width}
        height={height}
        // Corners come from the look's --radius in CSS (globals.css); these
        // are the Slate values for a missing stylesheet.
        rx={14}
        ry={14}
        fill={
          moving
            ? "var(--canvas-moving)"
            : dropTarget
              ? "var(--canvas-drop)"
              : selected
                ? "var(--accent)"
                : `var(--dept-${tone}-sheet)`
        }
        stroke={
          moving
            ? "var(--warning)"
            : active
              ? CANVAS_NODE_ACTIVE
              : "var(--canvas-dept-frame)"
        }
        strokeWidth={moving || active ? 2 : 1}
      />
      {/* The head band, top edge, and identity mark exist in every theme;
          each theme colors them through --dept-n-band and --dept-n. */}
      <rect
        data-sandbox-part="band"
        x={1}
        y={1}
        width={Math.max(width - 2, 0)}
        height={DEPARTMENT_HEAD_HEIGHT - 1}
        fill={`var(--dept-${tone}-band, transparent)`}
        pointerEvents="none"
      />
      {/* The department color as a 3px top edge that follows the frame's
          corners: the frame's shape, clipped to its top in CSS. A state
          stroke runs along the top too, so the edge takes its color. */}
      <rect
        data-sandbox-part="edge"
        width={width}
        height={height}
        rx={14}
        ry={14}
        fill={
          moving
            ? "var(--warning)"
            : active
              ? CANVAS_NODE_ACTIVE
              : `var(--dept-${tone})`
        }
        pointerEvents="none"
      />
      <rect
        data-sandbox-part="identity"
        x={16}
        y={16}
        width={10}
        height={10}
        rx={3}
        fill={`var(--dept-${tone})`}
        pointerEvents="none"
      />
      <text
        // Set in the look's display face (globals.css).
        data-sandbox-part="department-name"
        x={34}
        y={21}
        dominantBaseline="central"
        fontSize={15}
        fontWeight={700}
        fill={
          moving
            ? "var(--warning)"
            : active
              ? CANVAS_NODE_ACTIVE
              : "var(--canvas-dept-name)"
        }
        pointerEvents="none"
      >
        {truncateLabel(name, 30)}
      </text>
      <text
        x={width - 16}
        y={21}
        textAnchor="end"
        dominantBaseline="central"
        fontSize={12}
        fill="var(--canvas-dept-ink)"
        pointerEvents="none"
      >
        {`${moduleCount} ${moduleCount === 1 ? "module" : "modules"}`}
      </text>
      {selected ? (
        <>
          <rect
            className="nodrag nopan"
            data-department-resize="true"
            role="button"
            tabIndex={0}
            aria-label="Resize department"
            x={width - 24}
            y={height - 24}
            width={24}
            height={24}
            rx={4}
            fill="transparent"
            cursor="nwse-resize"
            style={{ touchAction: "none" }}
            onPointerDown={(event) => actions.startResize(id, event)}
            onKeyDown={(event) => actions.resizeByKey(id, event)}
            onDoubleClick={(event) => event.stopPropagation()}
          />
          <path
            d={`M${width - 17} ${height - 7}l10 -10 M${width - 11} ${height - 7}l4 -4`}
            stroke={CANVAS_NODE_ACTIVE}
            strokeWidth={2}
            fill="none"
            pointerEvents="none"
          />
        </>
      ) : null}
    </svg>
  );
}

/** The table glyph beside a module name (16px box, as on the website). */
function tableGlyphPath(x: number, y: number): string {
  return (
    `M${x + 4} ${y + 2.5}h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z` +
    `M${x + 2} ${y + 6.5}h12M${x + 6.5} ${y + 6.5}v7`
  );
}

const TYPE_INK = "var(--canvas-type-ink)";

function ModuleNodeView({ id, data }: NodeProps<ModuleFlowNode>) {
  const actions = useCanvasActions();
  const trace = useTraceMark(actions.trace, id);
  const marks = useFieldMarks(actions.trace);
  const { name, rows, tone, selected, selectedFieldId, feedback } = data;
  const { width, headerHeight, rowHeight, splitX } = MODULE_TABLE;
  const height = moduleTableHeight(rows.length);
  const rowCount = Math.max(rows.length, 1);
  const portsVisible = selected || selectedFieldId !== null;
  return (
    <>
      <svg
        data-sandbox-node={id}
        data-trace={trace ?? undefined}
        width={width}
        height={height}
        overflow="visible"
        className="block"
        onDoubleClick={(event) => {
          const point = nodePoint(
            event.currentTarget,
            event.clientX,
            event.clientY,
            width,
          );
          event.stopPropagation();
          if (point.y < headerHeight) {
            actions.openEditor({
              target: "module",
              property: "name",
              id,
              nodeId: id,
            });
            return;
          }
          const rowIndex = Math.floor((point.y - headerHeight) / rowHeight);
          const field = rows[rowIndex];
          if (field === undefined) return;
          actions.openEditor({
            target: "field",
            property: point.x >= splitX ? "type" : "name",
            id: field.id,
            nodeId: id,
            rowIndex,
          });
        }}
      >
        <rect
          // Theme skin hooks (src/app/themes).
          data-sandbox-body="true"
          data-sandbox-kind="module"
          data-selected={selected ? "true" : "false"}
          data-feedback={feedback ?? ""}
          width={width}
          height={height}
          // Corners come from the look's --radius in CSS (globals.css).
          rx={10}
          ry={10}
          fill={
            feedback === "moving"
              ? "var(--canvas-moving)"
              : feedback === "drop"
                ? "var(--canvas-drop)"
                : selected
                  ? "var(--accent)"
                  : `var(--dept-${tone}-module)`
          }
          stroke={
            feedback === "moving"
              ? "var(--warning)"
              : feedback === "drop" || selected
                ? CANVAS_NODE_ACTIVE
                : "var(--canvas-module-frame)"
          }
          strokeWidth={feedback === null && !selected ? 1 : 2}
        />
        <rect
          // The header follows the body's corner shape.
          data-sandbox-part="header"
          data-selected={selected ? "true" : "false"}
          width={width}
          height={headerHeight}
          rx={10}
          ry={10}
          fill={
            feedback === "moving"
              ? "var(--warning)"
              : selected || feedback === "drop"
                ? "var(--accent)"
                : `var(--dept-${tone}-card)`
          }
        />
        <path
          data-sandbox-part="glyph"
          aria-hidden="true"
          d={tableGlyphPath(10, headerHeight / 2 - 8)}
          fill="none"
          stroke={TYPE_INK}
          strokeWidth={1.4}
          pointerEvents="none"
        />
        <text
          // The header bar under it takes the pointer, so the whole header
          // is one target.
          x={32}
          y={headerHeight / 2}
          dominantBaseline="central"
          fontSize={13}
          fontWeight={600}
          fill="var(--canvas-module-ink)"
          pointerEvents="none"
        >
          {truncateLabel(name, 24)}
        </text>
        {Array.from({ length: rowCount }, (_, index) => {
          const field = rows[index];
          const rowTop = headerHeight + index * rowHeight;
          const rowCenter = rowTop + rowHeight / 2;
          const last = index === rowCount - 1;
          const fieldSelected =
            field !== undefined && field.id === selectedFieldId;
          const mark =
            field === undefined ? undefined : marks?.[field.id] || undefined;
          return (
            <g key={field?.id ?? "empty"}>
              <rect
                x={1}
                y={rowTop}
                width={width - 2}
                height={rowHeight - (last ? 1 : 0)}
                rx={last ? 9 : 0}
                fill={
                  fieldSelected
                    ? "var(--accent)"
                    : index % 2 === 1
                      ? `var(--dept-${tone}-stripe)`
                      : `var(--dept-${tone}-module)`
                }
                stroke={fieldSelected ? CANVAS_NODE_ACTIVE : "none"}
                strokeWidth={fieldSelected ? 1 : 0}
                tabIndex={field === undefined ? -1 : 0}
                role={field === undefined ? "presentation" : "button"}
                data-field-id={field?.id ?? ""}
                data-selected={fieldSelected ? "true" : "false"}
                data-feedback={fieldSelected ? "selected" : ""}
                data-test-mark={mark}
                aria-description={
                  mark === undefined ? undefined : fieldMarkDescription(mark)
                }
                aria-pressed={
                  field === undefined
                    ? undefined
                    : fieldSelected
                      ? "true"
                      : "false"
                }
                aria-label={
                  field === undefined
                    ? "No fields yet"
                    : `${field.name}, ${FIELD_TYPE_META[field.type].label}, ${field.required ? "required" : "optional"}`
                }
              />
              <line
                x1={0}
                y1={rowTop}
                x2={width}
                y2={rowTop}
                stroke="var(--canvas-row-rule)"
                strokeWidth={1}
                pointerEvents="none"
              />
              {field === undefined ? null : (
                // Required fields have a filled marker, optional fields a
                // hollow one; the canvas key names both.
                <circle
                  aria-hidden="true"
                  cx={14}
                  cy={rowCenter}
                  r={3}
                  fill={field.required ? TYPE_INK : "none"}
                  stroke={TYPE_INK}
                  strokeWidth={1.25}
                  pointerEvents="none"
                />
              )}
              <text
                data-sandbox-part="field-name"
                x={26}
                y={rowCenter}
                dominantBaseline="central"
                fontSize={12}
                fill={
                  field === undefined ? TYPE_INK : "var(--canvas-field-ink)"
                }
                fontStyle={field === undefined ? "italic" : "normal"}
                pointerEvents="none"
              >
                {field === undefined
                  ? "No fields yet"
                  : truncateLabel(field.name, 18)}
              </text>
              {field === undefined ? null : (
                <text
                  // Field types are data, set in the look's code face; the
                  // same words the Properties panel uses.
                  data-sandbox-part="field-type"
                  x={width - 10}
                  y={rowCenter}
                  textAnchor="end"
                  dominantBaseline="central"
                  fontSize={12}
                  fill={TYPE_INK}
                  pointerEvents="none"
                >
                  {FIELD_TYPE_META[field.type].label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {/* Connection points: hidden until the module is hovered or selected,
          or while a connection is being drawn (globals.css). */}
      <Handle
        type="target"
        position={Position.Left}
        id="in"
        className="sandbox-port"
        data-visible={portsVisible ? "true" : "false"}
      />
      <Handle
        type="source"
        position={Position.Right}
        id="out"
        className="sandbox-port"
        data-visible={portsVisible ? "true" : "false"}
      />
    </>
  );
}

/** Line arrowheads, one per line color; ids are shared by every line. */
export function RelationshipMarkers() {
  return (
    <svg aria-hidden="true" width={0} height={0} className="absolute">
      <defs>
        {(
          [
            ["relationship", relationshipLineAttrs(false, false).stroke],
            ["handoff", relationshipLineAttrs(false, true).stroke],
            ["selected", relationshipLineAttrs(true, false).stroke],
          ] as const
        ).map(([kind, color]) => (
          <marker
            key={kind}
            id={`sandbox-arrow-${kind}`}
            viewBox="0 0 8 7"
            refX={8}
            refY={3.5}
            markerWidth={8}
            markerHeight={7}
            markerUnits="userSpaceOnUse"
            orient="auto"
          >
            <path d="M0 0L8 3.5L0 7Z" fill={color} />
          </marker>
        ))}
      </defs>
    </svg>
  );
}

const LABEL_PADDING = { x: 7, y: 3 } as const;

function LineLabel({
  x,
  y,
  text,
  handoff,
}: {
  x: number;
  y: number;
  text: string;
  handoff: boolean;
}) {
  const textRef = useRef<SVGTextElement | null>(null);
  // Approximate from the 12px text until the look's face can be measured.
  const [size, setSize] = useState({ width: text.length * 6.6, height: 15 });
  useLayoutEffect(() => {
    const box = textRef.current?.getBBox();
    if (box && box.width > 0)
      setSize((current) =>
        current.width === box.width && current.height === box.height
          ? current
          : { width: box.width, height: box.height },
      );
  }, [text]);
  const width = size.width + LABEL_PADDING.x * 2;
  const height = size.height + LABEL_PADDING.y * 2;
  return (
    <g transform={`translate(${x} ${y})`} pointerEvents="none">
      <rect
        // Corners come from the look's --radius (globals.css).
        data-sandbox-part="line-label"
        x={-width / 2}
        y={-height / 2}
        width={width}
        height={height}
        rx={6}
        ry={6}
        fill="var(--canvas-label-fill)"
        stroke="var(--canvas-label-frame)"
        strokeWidth={1}
      />
      <text
        ref={textRef}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={12}
        fontWeight={500}
        // A relationship's label takes its line's action ink.
        fill={handoff ? "var(--canvas-label-ink)" : "var(--action-text)"}
      >
        {text}
      </text>
    </g>
  );
}

function RelationshipEdgeView({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<RelationshipFlowEdge>) {
  const actions = useCanvasActions();
  const trace = useTraceMark(actions.trace, id);
  const selected = data?.selected ?? false;
  const handoff = data?.handoff ?? false;
  const line = relationshipLineAttrs(selected, handoff);
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 8,
    offset: 24,
  });
  return (
    <g data-sandbox-edge={id} data-trace={trace ?? undefined}>
      {/* A wide transparent stroke so a 1.6px line is easy to click. */}
      <path d={path} fill="none" stroke="transparent" strokeWidth={16} />
      <path
        d={path}
        fill="none"
        data-sandbox-line={line["data-sandbox-line"]}
        data-sandbox-edge-kind={line["data-sandbox-edge-kind"]}
        stroke={line.stroke}
        strokeWidth={line.strokeWidth}
        strokeDasharray={line.strokeDasharray || undefined}
        strokeLinecap="round"
        markerEnd={`url(#sandbox-arrow-${selected ? "selected" : handoff ? "handoff" : "relationship"})`}
      />
      {data?.label ? (
        <LineLabel x={labelX} y={labelY} text={data.label} handoff={handoff} />
      ) : null}
    </g>
  );
}

export const SANDBOX_NODE_TYPES = {
  department: memo(DepartmentNodeView),
  module: memo(ModuleNodeView),
};

export const SANDBOX_EDGE_TYPES = {
  relationship: memo(RelationshipEdgeView),
};
