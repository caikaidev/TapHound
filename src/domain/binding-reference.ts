import { z } from "zod";

export const BINDING_REFERENCE = /^\$\{([a-z][a-zA-Z0-9_]{0,31})\}$/;

export function bindingName(value: string): string | undefined {
  return BINDING_REFERENCE.exec(value)?.[1];
}

export function checkBindingReferences(
  value: unknown,
  context: z.RefinementCtx,
  allowed: readonly (readonly (string | number)[])[],
  path: (string | number)[] = []
): void {
  if (typeof value === "string") {
    if (value.includes("${") && (
      bindingName(value) === undefined
      || !allowed.some((candidate) => (
        candidate.length === path.length
        && candidate.every((item, index) => item === path[index])
      ))
    )) {
      context.addIssue({
        code: "custom",
        path,
        message: "Binding references are permitted only as exact values in approved fields"
      });
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    checkBindingReferences(
      item,
      context,
      allowed,
      [...path, ...(Array.isArray(value) ? [Number(key)] : [key])]
    );
  }
}
