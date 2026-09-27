import type { Design } from "./model";

/**
 * The module the Build view selects when no link names one: the first module
 * of the busiest department (most modules plus relationships that touch
 * them), so the first view shows tables and the lines between them. The
 * canvas opens on the selected module's department, so both panes agree.
 */
export function openingModuleId(
  design: Pick<Design, "departments" | "modules" | "relationships">,
): string | null {
  let best: { id: string; score: number } | null = null;
  for (const department of design.departments) {
    const ids = new Set(
      design.modules
        .filter((item) => item.department === department.id)
        .map((item) => item.id),
    );
    if (ids.size === 0) continue;
    const lines = design.relationships.filter(
      (item) => ids.has(item.source) || ids.has(item.target),
    ).length;
    const score = ids.size + lines;
    if (best === null || score > best.score)
      best = { id: department.id, score };
  }
  const department = best?.id;
  return (
    design.modules.find((item) => item.department === department)?.id ??
    design.modules[0]?.id ??
    null
  );
}
