import type { LayoutElement, Locator } from "./layout.js";

export const LOCATOR_FIELDS = [
  "resourceId",
  "text",
  "contentDescription"
] as const satisfies readonly (keyof Locator)[];

export type LocatorField = (typeof LOCATOR_FIELDS)[number];

export interface LocatedElement {
  element: LayoutElement;
  field: LocatorField;
  value: string;
}
