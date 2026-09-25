import { z } from "zod";

import {
  BoundsSchema,
  type Bounds
} from "../../domain/layout.js";

const RawBoundsSchema = z.strictObject({
  left: z.number().int().nonnegative(),
  top: z.number().int().nonnegative(),
  right: z.number().int().nonnegative(),
  bottom: z.number().int().nonnegative()
});

export function normalizeResourceId(
  value: string | undefined
): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const separator = value.lastIndexOf(":id/");
  return separator >= 0 ? value.slice(separator + 4) : value;
}

function isEdge(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Hot-path variant for already-numeric edges (one call per parsed node).
 * Enforces the same contract as `RawBoundsSchema` plus `BoundsSchema`
 * without allocating Zod issues for valid input.
 */
export function normalizeBoundsEdges(
  left: number,
  top: number,
  right: number,
  bottom: number
): Bounds | undefined {
  if (!isEdge(left) || !isEdge(top) || !isEdge(right) || !isEdge(bottom)) {
    return normalizeBounds({ left, top, right, bottom });
  }
  if (right < left || bottom < top) {
    throw new Error("Bounds edges are reversed");
  }
  if (right === left || bottom === top) {
    return undefined;
  }
  return { left, top, right, bottom };
}

export function normalizeBounds(value: unknown): Bounds | undefined {
  const raw = RawBoundsSchema.parse(value);
  if (raw.right < raw.left || raw.bottom < raw.top) {
    throw new Error("Bounds edges are reversed");
  }
  if (raw.right === raw.left || raw.bottom === raw.top) {
    return undefined;
  }
  return BoundsSchema.parse(raw);
}
