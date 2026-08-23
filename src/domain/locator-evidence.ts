import { createHash } from "node:crypto";

import {
  LocatorEvidenceSchema,
  type LayoutElement,
  type LocatorEvidence
} from "./layout.js";

interface SemanticElement {
  resourceId?: string | undefined;
  text?: string | undefined;
  contentDescription?: string | undefined;
  clickable?: true | undefined;
  longClickable?: true | undefined;
  scrollable?: true | undefined;
  focusable?: true | undefined;
  enabled: boolean;
  children: SemanticElement[];
}

function semanticElement(element: LayoutElement): SemanticElement {
  return {
    ...(element.resourceId === undefined
      ? {}
      : { resourceId: element.resourceId }),
    ...(element.text === undefined ? {} : { text: element.text }),
    ...(element.contentDescription === undefined
      ? {}
      : { contentDescription: element.contentDescription }),
    ...(element.clickable === true ? { clickable: true as const } : {}),
    ...(element.longClickable === true
      ? { longClickable: true as const }
      : {}),
    ...(element.scrollable === true ? { scrollable: true as const } : {}),
    ...(element.focusable === true ? { focusable: true as const } : {}),
    enabled: element.enabled,
    children: element.children.map(semanticElement)
  };
}

function semanticSha256ForElement(element: LayoutElement): string {
  return createHash("sha256")
    .update(JSON.stringify(semanticElement(element)))
    .digest("hex");
}

export function locatorEvidenceForElement(
  element: LayoutElement
): LocatorEvidence {
  return LocatorEvidenceSchema.parse({
    version: 1,
    semanticSha256: semanticSha256ForElement(element)
  });
}

export function locatorEvidenceMatches(
  element: LayoutElement,
  evidence: LocatorEvidence
): boolean {
  // Future evidence versions must branch before changing hash semantics.
  return semanticSha256ForElement(element) === evidence.semanticSha256;
}
