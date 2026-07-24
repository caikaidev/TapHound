import type { LayoutElement } from "../../domain/layout.js";

function flatten(elements: readonly LayoutElement[]): LayoutElement[] {
  return elements.flatMap((element) => [
    element,
    ...flatten(element.children)
  ]);
}

export function hasExactlyOneEnabledFocusedElement(
  layout: readonly LayoutElement[]
): boolean {
  return flatten(layout).filter(
    (element) => element.enabled && element.focused === true
  ).length === 1;
}
