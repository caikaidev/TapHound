import { describe, expect, it } from "vitest";

import {
  configMismatchMessage,
  uiBackendMismatchMessage
} from "../../../src/application/generation/binding-mismatch.js";

describe("Generation binding mismatch messages", () => {
  it("names the session and current config hashes and the remedy", () => {
    expect(configMismatchMessage("a".repeat(64), "b".repeat(64))).toBe(
      "Generation configuration does not match the authoritative session"
      + " (session config sha256 aaaaaaaaaaaa…, current bbbbbbbbbbbb…);"
      + " rerun with the same --config (and ui.backend) used at generation start"
    );
  });

  it("names the session and current UI backends", () => {
    expect(uiBackendMismatchMessage(
      {
        id: "system-uiautomator",
        adapterVersion: "1",
        configSha256: "c".repeat(64)
      },
      {
        id: "appium-uiautomator2",
        adapterVersion: "2",
        configSha256: "d".repeat(64)
      }
    )).toBe(
      "Generation UI backend does not match the authoritative session"
      + " (session system-uiautomator 1 config cccccccccccc…,"
      + " current appium-uiautomator2 2 config dddddddddddd…);"
      + " rerun with the same --config (and ui.backend) used at generation start"
    );
  });
});
