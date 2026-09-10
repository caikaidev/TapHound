import { homedir } from "node:os";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve } from "node:path";

import type {
  ResolvedPath,
  TargetPathResolverPort
} from "../../ports/path-resolver.js";
import { TargetError } from "../../domain/target.js";
import { isErrnoException } from "../../shared/errors.js";
import { hasAndroidProjectStructure } from "./android-project-detection.js";

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/;

export interface TargetPathResolverDependencies {
  env: Record<string, string | undefined>;
  home?: string | undefined;
}

function expandEnvironment(input: string, env: Record<string, string | undefined>): string {
  return input.replace(
    ENV_PATTERN,
    (_match, braced: string | undefined, bare: string | undefined): string => {
      const name = braced ?? bare ?? "";
      const value = env[name];
      if (value === undefined || value.length === 0) {
        throw new TargetError(
          "LOCAL_TARGET_ENV_MISSING",
          `Environment variable ${name} is not defined. Configure the target with an explicit path or export ${name}.`
        );
      }
      return value;
    }
  );
}

function expandHome(input: string, home: string): string {
  if (input === "~") {
    return home;
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(home, input.slice(2));
  }
  return input;
}

export class TargetPathResolver implements TargetPathResolverPort {
  public constructor(
    private readonly dependencies: TargetPathResolverDependencies
  ) {}

  public readonly resolve = async (
    input: string,
    baseDir: string
  ): Promise<ResolvedPath> => {
    const home = this.dependencies.home ?? homedir();
    const expanded = expandEnvironment(input, this.dependencies.env);
    const expandedHome = expandHome(expanded, home);
    const candidate = isAbsolute(expandedHome)
      ? normalize(expandedHome)
      : resolve(baseDir, expandedHome);

    let canonical: string;
    try {
      canonical = await realpath(candidate);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT") {
        throw error;
      }
      throw new TargetError(
        "LOCAL_TARGET_SYMLINK_BROKEN",
        `The configured path does not resolve to an existing directory: ${input}`
      );
    }
    const stats = await stat(canonical);
    if (!stats.isDirectory()) {
      throw new TargetError(
        "LOCAL_TARGET_NOT_DIRECTORY",
        `The configured path is not a directory: ${canonical}`
      );
    }
    if (!(await hasAndroidProjectStructure(canonical))) {
      throw new TargetError(
        "LOCAL_TARGET_NOT_ANDROID_PROJECT",
        `The configured path is not an Android/Gradle project: ${canonical}`
      );
    }
    return { configuredPath: input, resolvedPath: canonical };
  };
}