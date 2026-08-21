import { createHash } from "node:crypto";

import {
  FlowNameSchema,
  FlowSchema,
  JourneySourcePathSchema,
  JourneyResolutionManifestSchema,
  JourneySourceSchema,
  type Flow,
  type JourneyResolutionManifest,
  type JourneySource
} from "../../domain/journey-composition.js";
import {
  JourneySchema,
  type Journey,
  type JourneyStep
} from "../../domain/journey.js";
import {
  FLOWS_DIR
} from "../../domain/workspace.js";
import type {
  JourneyCompositionStore
} from "../../ports/journey-composition-store.js";

const MAX_COMPOSITION_BYTES = 1024 * 1024;

export type JourneyCompositionErrorCode =
  | "SOURCE_INVALID"
  | "FLOW_INVALID"
  | "FLOW_NOT_FOUND"
  | "FLOW_CYCLE"
  | "FLOW_DUPLICATE"
  | "ACTIVITY_BOUNDARY_MISMATCH";

export class JourneyCompositionError extends Error {
  public override readonly name = "JourneyCompositionError";

  public constructor(
    public readonly code: JourneyCompositionErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

export interface JourneyResolveInput {
  projectRoot: string;
  sourcePath: string;
}

export interface JourneyResolution {
  journey: Journey;
  manifest: JourneyResolutionManifest;
}

export interface FlowCatalogEntry {
  name: string;
  path: string;
  status: "valid" | "invalid";
  entryActivity?: string | undefined;
  exitActivity?: string | undefined;
  stepCount?: number | undefined;
  resolutionSha256?: string | undefined;
  failure?: {
    code: string;
    message: string;
  } | undefined;
}

interface LoadedFlow {
  path: string;
  bytes: Buffer;
  flow: Flow;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashCanonical(value: unknown): string {
  return sha256(JSON.stringify(canonicalize(value)));
}

function parseJson(bytes: Buffer, label: string): unknown {
  if (bytes.byteLength > MAX_COMPOSITION_BYTES) {
    throw new JourneyCompositionError(
      label === "Journey source" ? "SOURCE_INVALID" : "FLOW_INVALID",
      `${label} exceeds ${String(MAX_COMPOSITION_BYTES)} bytes`
    );
  }
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new JourneyCompositionError(
      label === "Journey source" ? "SOURCE_INVALID" : "FLOW_INVALID",
      `${label} is not valid JSON`,
      { cause: error }
    );
  }
}

function flowPath(name: string): string {
  return `${FLOWS_DIR}/${FlowNameSchema.parse(name)}.json`;
}

function normalizedSourcePath(path: string): string {
  try {
    return JourneySourcePathSchema.parse(path);
  } catch (error) {
    throw new JourneyCompositionError(
      "SOURCE_INVALID",
      "Journey source must be a normalized JSON file under .taphound/sources",
      { cause: error }
    );
  }
}

function assertActivityBoundaries(steps: readonly JourneyStep[]): void {
  for (let index = 1; index < steps.length; index += 1) {
    const previous = steps[index - 1];
    const current = steps[index];
    if (
      previous !== undefined
      && current !== undefined
      && previous.activity.after !== current.activity.before
    ) {
      throw new JourneyCompositionError(
        "ACTIVITY_BOUNDARY_MISMATCH",
        `Step ${String(index - 1)} ends at ${previous.activity.after}, but step ${String(index)} starts at ${current.activity.before}`
      );
    }
  }
}

function errorDetails(error: unknown): { code: string; message: string } {
  if (error instanceof JourneyCompositionError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "FLOW_INVALID",
    message: error instanceof Error ? error.message : String(error)
  };
}

export class JourneyResolver {
  public constructor(
    private readonly store: Pick<
      JourneyCompositionStore,
      "read" | "listFlowPaths"
    >
  ) {}

  public readonly resolve = async (
    input: JourneyResolveInput
  ): Promise<JourneyResolution> => {
    const sourcePath = normalizedSourcePath(input.sourcePath);
    let sourceBytes: Buffer;
    try {
      sourceBytes = await this.store.read({
        projectRoot: input.projectRoot,
        relativePath: sourcePath
      });
    } catch (error) {
      throw new JourneyCompositionError(
        "SOURCE_INVALID",
        `Unable to read Journey source ${sourcePath}`,
        { cause: error }
      );
    }
    let source: JourneySource;
    try {
      source = JourneySourceSchema.parse(
        parseJson(sourceBytes, "Journey source")
      );
    } catch (error) {
      throw error instanceof JourneyCompositionError
        ? error
        : new JourneyCompositionError(
            "SOURCE_INVALID",
            `Journey source ${sourcePath} is invalid`,
            { cause: error }
          );
    }
    return this.resolveDocument(input.projectRoot, sourcePath, sourceBytes, source);
  };

  public readonly resolveFlow = async (
    input: { projectRoot: string; name: string }
  ): Promise<JourneyResolution> => {
    const name = FlowNameSchema.parse(input.name);
    const path = flowPath(name);
    const loaded = await this.loadFlow(input.projectRoot, name);
    const source: JourneySource = {
      version: 1,
      kind: "journeySource",
      name,
      includes: loaded.flow.includes,
      steps: loaded.flow.steps
    };
    return this.resolveDocument(
      input.projectRoot,
      path,
      loaded.bytes,
      source,
      name
    );
  };

  public readonly listFlows = async (
    projectRoot: string
  ): Promise<FlowCatalogEntry[]> => {
    const paths = [...await this.store.listFlowPaths(projectRoot)].sort();
    const entries: FlowCatalogEntry[] = [];
    for (const path of paths) {
      try {
        const bytes = await this.store.read({ projectRoot, relativePath: path });
        const flow = FlowSchema.parse(parseJson(bytes, "Flow"));
        const expectedPath = flowPath(flow.name);
        if (path !== expectedPath) {
          throw new JourneyCompositionError(
            "FLOW_INVALID",
            `Flow ${flow.name} must be stored at ${expectedPath}`
          );
        }
        const resolution = await this.resolveFlow({
          projectRoot,
          name: flow.name
        });
        entries.push({
          name: flow.name,
          path,
          status: "valid",
          entryActivity: resolution.journey.steps[0]?.activity.before,
          exitActivity: resolution.journey.steps.at(-1)?.activity.after,
          stepCount: resolution.journey.steps.length,
          resolutionSha256: resolution.manifest.resolutionSha256
        });
      } catch (error) {
        entries.push({
          name: path.slice(`${FLOWS_DIR}/`.length, -".json".length),
          path,
          status: "invalid",
          failure: errorDetails(error)
        });
      }
    }
    return entries;
  };

  private readonly resolveDocument = async (
    projectRoot: string,
    sourcePath: string,
    sourceBytes: Buffer,
    source: JourneySource,
    rootFlowName?: string
  ): Promise<JourneyResolution> => {
    const steps: JourneyStep[] = [];
    const dependencies: Array<{
      name: string;
      path: string;
      sha256: string;
      stepCount: number;
    }> = [];
    const expanded = new Set<string>();
    const stack: string[] = [];

    const expand = async (name: string): Promise<void> => {
      if (stack.includes(name)) {
        throw new JourneyCompositionError(
          "FLOW_CYCLE",
          `Flow cycle detected: ${[...stack, name].join(" -> ")}`
        );
      }
      if (expanded.has(name)) {
        throw new JourneyCompositionError(
          "FLOW_DUPLICATE",
          `Flow ${name} is included more than once`
        );
      }
      stack.push(name);
      const loaded = await this.loadFlow(projectRoot, name);
      for (const dependency of loaded.flow.includes) {
        await expand(dependency);
      }
      stack.pop();
      expanded.add(name);
      steps.push(...loaded.flow.steps);
      dependencies.push({
        name,
        path: loaded.path,
        sha256: sha256(loaded.bytes),
        stepCount: loaded.flow.steps.length
      });
    };

    if (rootFlowName === undefined) {
      for (const name of source.includes) {
        await expand(name);
      }
      steps.push(...source.steps);
    } else {
      await expand(rootFlowName);
    }

    assertActivityBoundaries(steps);
    const journey = JourneySchema.parse({
      version: 1,
      name: source.name,
      steps
    });
    const unsignedManifest = {
      version: 1 as const,
      source: {
        path: sourcePath,
        sha256: sha256(sourceBytes)
      },
      flows: dependencies,
      expansion: dependencies.map((dependency) => dependency.name),
      journey: {
        name: journey.name,
        sha256: hashCanonical(journey),
        stepCount: journey.steps.length
      }
    };
    return {
      journey,
      manifest: JourneyResolutionManifestSchema.parse({
        ...unsignedManifest,
        resolutionSha256: hashCanonical(unsignedManifest)
      })
    };
  };

  private readonly loadFlow = async (
    projectRoot: string,
    name: string
  ): Promise<LoadedFlow> => {
    const path = flowPath(name);
    let bytes: Buffer;
    try {
      bytes = await this.store.read({ projectRoot, relativePath: path });
    } catch (error) {
      throw new JourneyCompositionError(
        "FLOW_NOT_FOUND",
        `Unable to read Flow ${name} at ${path}`,
        { cause: error }
      );
    }
    let flow: Flow;
    try {
      flow = FlowSchema.parse(parseJson(bytes, "Flow"));
    } catch (error) {
      throw error instanceof JourneyCompositionError
        ? error
        : new JourneyCompositionError(
            "FLOW_INVALID",
            `Flow ${name} is invalid`,
            { cause: error }
          );
    }
    if (flow.name !== name) {
      throw new JourneyCompositionError(
        "FLOW_INVALID",
        `Flow at ${path} declares name ${flow.name}`
      );
    }
    return { path, bytes, flow };
  };
}
