import type { LayoutElement } from "../../domain/layout.js";

export interface LayoutEntry {
  element: LayoutElement;
  ancestors: readonly LayoutElement[];
}

export function flattenLayout(
  elements: readonly LayoutElement[],
  ancestors: readonly LayoutElement[] = []
): LayoutEntry[] {
  return elements.flatMap((element) => [
    { element, ancestors },
    ...flattenLayout(element.children, [...ancestors, element])
  ]);
}
