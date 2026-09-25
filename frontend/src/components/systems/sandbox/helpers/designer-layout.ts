import { compactDefaultLayout, type Design } from "../domain/model";
import type { SandboxCanvasLayout } from "@/lib/sandbox/model";

export function arrangedLayout(design: Design): SandboxCanvasLayout {
  const current = design.layout ?? compactDefaultLayout;
  const layout: SandboxCanvasLayout = {};
  let departmentY = 24;
  for (const department of design.departments) {
    const modules = design.modules.filter(
      (item) => item.department === department.id,
    );
    const rowHeights: number[] = [];
    modules.forEach((moduleItem, index) => {
      const row = Math.floor(index / 2);
      rowHeights[row] = Math.max(
        rowHeights[row] ?? 0,
        current[moduleItem.id]?.height ?? 176,
      );
    });
    const rowOffsets = rowHeights.map((_, row) =>
      rowHeights
        .slice(0, row)
        .reduce((total, height) => total + height + 28, 0),
    );
    const departmentHeight = Math.max(
      176,
      76 +
        rowHeights.reduce((total, height) => total + height, 0) +
        Math.max(0, rowHeights.length - 1) * 28,
    );
    layout[department.id] = {
      x: 24,
      y: departmentY,
      width: 680,
      height: departmentHeight,
    };
    modules.forEach((moduleItem, index) => {
      const existing = current[moduleItem.id];
      layout[moduleItem.id] = {
        x: 48 + (index % 2) * 328,
        y: departmentY + 48 + rowOffsets[Math.floor(index / 2)],
        width: existing?.width ?? 304,
        height: existing?.height ?? 176,
      };
    });
    departmentY += departmentHeight + 32;
  }
  return layout;
}

export function resetLayout(design: Design): SandboxCanvasLayout {
  const arranged = arrangedLayout(design);
  return Object.fromEntries(
    Object.keys(arranged).map((id) => [
      id,
      compactDefaultLayout[id] ?? arranged[id],
    ]),
  );
}
