import { describe, expect, it } from "vitest";

import {
  RUNTIME_BACKEND_ENV_VAR,
  RuntimeBackendSelectionError,
  readRuntimeBackendChoice
} from "../../src/cli/runtime-selection.js";

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
