import { isAbsolute, resolve } from "node:path";

interface ArtifactCandidate {
  path: string;
  context: Set<string>;
}

interface MetadataValueCandidate {
  value: string;
  context: Set<string>;
}

export interface ArtifactSelector {
  projectDir: string;
  target: string;
  variant: string;
}

export function extractDescriptionPaths(stdout: string): string[] {
  const trimmed = stdout.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        return parsed.filter((item) => item.endsWith(".json"));
      }
    } catch {
      // Fall through to line parsing so diagnostics remain tolerable.
    }
  }

  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^["']|["']$/g, ""))
    .filter((line) => line.endsWith(".json"));
}

function scalarContext(value: Record<string, unknown>): string[] {
  return Object.entries(value).flatMap(([key, item]) => {
    if (typeof item === "string" && !item.toLowerCase().endsWith(".apk")) {
      return [key.toLowerCase(), item.toLowerCase()];
    }
    return [key.toLowerCase()];
  });
}

function collectCandidates(
  value: unknown,
  context: readonly string[],
  candidates: ArtifactCandidate[]
): void {
  if (typeof value === "string") {
    if (value.toLowerCase().endsWith(".apk")) {
      candidates.push({
        path: value,
        context: new Set([
          ...context,
          ...value.toLowerCase().split(/[\\/._-]+/)
        ])
      });
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectCandidates(item, [...context, String(index)], candidates);
    });
    return;
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const localContext = [...context, ...scalarContext(record)];
    for (const [key, item] of Object.entries(record)) {
      collectCandidates(item, [...localContext, key.toLowerCase()], candidates);
    }
  }
}

function collectApplicationIds(
  value: unknown,
  context: readonly string[],
  candidates: MetadataValueCandidate[]
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectApplicationIds(item, [...context, String(index)], candidates);
    });
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;
  const localContext = [...context, ...scalarContext(record)];
  for (const [key, item] of Object.entries(record)) {
    const normalizedKey = key.toLowerCase().replaceAll(/[-_]/g, "");
    if (normalizedKey === "applicationid" && typeof item === "string") {
      candidates.push({ value: item, context: new Set(localContext) });
    }
    collectApplicationIds(item, [...localContext, key.toLowerCase()], candidates);
  }
}

export function selectApkArtifact(
  documents: readonly unknown[],
  selector: ArtifactSelector
): string {
  const candidates: ArtifactCandidate[] = [];
  for (const document of documents) {
    collectCandidates(document, [], candidates);
  }

  const target = selector.target.toLowerCase();
  const variant = selector.variant.toLowerCase();
  const matches = candidates.filter(
    (candidate) => candidate.context.has(target) && candidate.context.has(variant)
  );

  if (matches.length === 0) {
    throw new Error(
      `No APK artifact matches target ${selector.target} and variant ${selector.variant}`
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous APK artifact for target ${selector.target} and variant ${selector.variant}`
    );
  }

  const artifactPath = matches[0]?.path;
  if (artifactPath === undefined) {
    throw new Error("No APK artifact selected");
  }
  return isAbsolute(artifactPath)
    ? artifactPath
    : resolve(selector.projectDir, artifactPath);
}

export function selectApplicationId(
  documents: readonly unknown[],
  selector: ArtifactSelector
): string | undefined {
  const candidates: MetadataValueCandidate[] = [];
  for (const document of documents) {
    collectApplicationIds(document, [], candidates);
  }
  const target = selector.target.toLowerCase();
  const variant = selector.variant.toLowerCase();
  const matches = [...new Set(candidates
    .filter((candidate) => (
      candidate.context.has(target) && candidate.context.has(variant)
    ))
    .map((candidate) => candidate.value))];
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous Application ID for target ${selector.target} and variant ${selector.variant}`
    );
  }
  return matches[0];
}
