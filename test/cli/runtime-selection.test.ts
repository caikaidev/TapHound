import { describe, expect, it } from "vitest";

import {
  RUNTIME_BACKEND_ENV_VAR,
  RuntimeBackendConfigError,
  RuntimeBackendSelectionError,
  readRuntimeBackendChoice,
  resolveRuntimeBackendChoiceFromInvocation
} from "../../src/cli/runtime-selection.js";

function invocation(overrides: {
  env?: Record<string, string | undefined>;
  argv?: readonly string[];
  files?: Record<string, string>;
  cwd?: string;
} = {}): {
  env: Record<string, string | undefined>;
  argv: readonly string[];
  cwd: string;
  readConfigFile: (path: string) => Promise<string>;
} {
  const files = overrides.files ?? {};
  return {
    env: overrides.env ?? {},
    argv: overrides.argv ?? [],
    cwd: overrides.cwd ?? "/project",
    readConfigFile: (path): Promise<string> => {
      const content = files[path];
      return content === undefined
        ? Promise.reject(new Error("ENOENT"))
        : Promise.resolve(content);
    }
  };
}

const CONFIG_AT_DEFAULT = "/project/.taphound/config.json";

describe("readRuntimeBackendChoice", () => {
  it("defaults to auto when the environment variable is unset or blank", () => {
    expect(readRuntimeBackendChoice({})).toBe("auto");
    expect(readRuntimeBackendChoice({
      [RUNTIME_BACKEND_ENV_VAR]: ""
    })).toBe("auto");
    expect(readRuntimeBackendChoice({
      [RUNTIME_BACKEND_ENV_VAR]: "   "
    })).toBe("auto");
  });

  it("accepts every documented choice and trims surrounding whitespace", () => {
    expect(readRuntimeBackendChoice({
      [RUNTIME_BACKEND_ENV_VAR]: "auto"
    })).toBe("auto");
    expect(readRuntimeBackendChoice({
      [RUNTIME_BACKEND_ENV_VAR]: "adb"
    })).toBe("adb");
    expect(readRuntimeBackendChoice({
      [RUNTIME_BACKEND_ENV_VAR]: "mobile-mcp"
    })).toBe("mobile-mcp");
    expect(readRuntimeBackendChoice({
      [RUNTIME_BACKEND_ENV_VAR]: " mobile-mcp "
    })).toBe("mobile-mcp");
  });

  it("rejects unsupported values with the valid choices listed", () => {
    expect(() => readRuntimeBackendChoice({
      [RUNTIME_BACKEND_ENV_VAR]: "ios"
    })).toThrow(RuntimeBackendSelectionError);
    expect(() => readRuntimeBackendChoice({
      [RUNTIME_BACKEND_ENV_VAR]: "Mobile-MCP"
    })).toThrow(RuntimeBackendSelectionError);
    expect(() => readRuntimeBackendChoice({
      [RUNTIME_BACKEND_ENV_VAR]: "appium"
    })).toThrow(
      'TAPHOUND_RUNTIME_BACKEND must be one of "auto", "adb", "mobile-mcp", received "appium"'
    );
  });

  it("names the error for clean CLI handling", () => {
    const error = new RuntimeBackendSelectionError("typo");
    expect(error.name).toBe("RuntimeBackendSelectionError");
    expect(error.message).toContain("typo");
  });
});

describe("resolveRuntimeBackendChoiceFromInvocation", () => {
  it("returns the explicit environment choice over the config file", async () => {
    const choice = await resolveRuntimeBackendChoiceFromInvocation(invocation({
      env: { [RUNTIME_BACKEND_ENV_VAR]: "adb" },
      files: {
        [CONFIG_AT_DEFAULT]: JSON.stringify({
          runtime: { backend: "mobile-mcp" }
        })
      }
    }));

    expect(choice).toBe("adb");
  });

  it("reads the config choice when the environment is auto", async () => {
    const withEnvAuto = await resolveRuntimeBackendChoiceFromInvocation(
      invocation({
        env: { [RUNTIME_BACKEND_ENV_VAR]: "auto" },
        files: {
          [CONFIG_AT_DEFAULT]: JSON.stringify({
            runtime: { backend: "mobile-mcp" }
          })
        }
      })
    );
    const withoutEnv = await resolveRuntimeBackendChoiceFromInvocation(
      invocation({
        files: {
          [CONFIG_AT_DEFAULT]: JSON.stringify({
            runtime: { backend: "adb" }
          })
        }
      })
    );

    expect(withEnvAuto).toBe("mobile-mcp");
    expect(withoutEnv).toBe("adb");
  });

  it("honors --project and --config in both argument forms, last wins", async () => {
    const choice = await resolveRuntimeBackendChoiceFromInvocation(invocation({
      argv: [
        "node",
        "taphound",
        "--project",
        "/other",
        "--project=/final",
        "doctor",
        "--config=custom.json"
      ],
      files: {
        "/final/custom.json": JSON.stringify({
          runtime: { backend: "mobile-mcp" }
        })
      }
    }));

    expect(choice).toBe("mobile-mcp");
  });

  it("falls back to auto for missing or malformed configs", async () => {
    const missing = await resolveRuntimeBackendChoiceFromInvocation(
      invocation({ files: {} })
    );
    const malformed = await resolveRuntimeBackendChoiceFromInvocation(
      invocation({ files: { [CONFIG_AT_DEFAULT]: "{not json" } })
    );
    const withoutRuntime = await resolveRuntimeBackendChoiceFromInvocation(
      invocation({
        files: { [CONFIG_AT_DEFAULT]: JSON.stringify({ version: 1 }) }
      })
    );

    expect(missing).toBe("auto");
    expect(malformed).toBe("auto");
    expect(withoutRuntime).toBe("auto");
  });

  it("rejects an invalid config runtime backend with the config path", async () => {
    await expect(resolveRuntimeBackendChoiceFromInvocation(invocation({
      files: {
        [CONFIG_AT_DEFAULT]: JSON.stringify({
          runtime: { backend: "emulator" }
        })
      }
    }))).rejects.toThrow(RuntimeBackendConfigError);
    await expect(resolveRuntimeBackendChoiceFromInvocation(invocation({
      files: {
        [CONFIG_AT_DEFAULT]: JSON.stringify({
          runtime: { backend: "emulator" }
        })
      }
    }))).rejects.toThrow(
      `runtime.backend in ${CONFIG_AT_DEFAULT} must be one of "auto", "adb", "mobile-mcp", received "emulator"`
    );
  });

  it("propagates invalid environment values before reading config", async () => {
    await expect(resolveRuntimeBackendChoiceFromInvocation(invocation({
      env: { [RUNTIME_BACKEND_ENV_VAR]: "ios" },
      files: {
        [CONFIG_AT_DEFAULT]: JSON.stringify({
          runtime: { backend: "mobile-mcp" }
        })
      }
    }))).rejects.toThrow(RuntimeBackendSelectionError);
  });
});
