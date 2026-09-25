import type { LayoutElement } from "../../domain/layout.js";

export interface LayoutEntry {
  element: LayoutElement;
  ancestors: readonly LayoutElement[];
}

/**
 * Pre-order (document order) flattening. Siblings share one ancestor array,
 * and entries are appended to a single result instead of re-spreading every
 * subtree at each level.
 */
export function flattenLayout(
  elements: readonly LayoutElement[],
  ancestors: readonly LayoutElement[] = []
): LayoutEntry[] {
  const entries: LayoutEntry[] = [];
  const visit = (
    siblings: readonly LayoutElement[],
    parents: readonly LayoutElement[]
  ): void => {
    for (const element of siblings) {
      entries.push({ element, ancestors: parents });
      if (element.children.length > 0) {
        visit(element.children, [...parents, element]);
      }
    }
  };
  visit(elements, ancestors);
  return entries;
}
