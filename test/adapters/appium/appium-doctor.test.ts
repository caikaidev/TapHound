import { afterEach, describe, expect, it, vi } from "vitest";

import {
  checkAppiumUiAutomator2
} from "../../../src/adapters/appium/appium-doctor.js";
import { commandResult, processRunner } from "../../fakes/process-runner.js";

afterEach(() => vi.unstubAllGlobals());

describe("checkAppiumUiAutomator2", () => {
  it("reports locked server/driver versions and the loopback startup command", async () => {
    const runner = processRunner();
    vi.mocked(runner.run).mockImplementation((spec) => Promise.resolve(
      spec.args[0] === "--version"
        ? commandResult({ stdout: "3.0.0\n" })
        : commandResult({ stdout: JSON.stringify({
          uiautomator2: { version: "5.1.0" }
        }) })
    ));
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(
      JSON.stringify({ value: { build: { version: "3.0.0" } } }),
      { status: 200 }
    ))));

    await expect(checkAppiumUiAutomator2(runner)).resolves.toEqual({
      status: "passed",
      version: "3.0.0",
      message: "UiAutomator2 5.1.0; server 3.0.0; start: appium --address 127.0.0.1 --port 4723"
    });
  });

  it("fails closed when UiAutomator2 is absent or the server is not started", async () => {
    const runner = processRunner();
    vi.mocked(runner.run).mockImplementation((spec) => Promise.resolve(
      spec.args[0] === "--version"
        ? commandResult({ stdout: "3.0.0\n" })
        : commandResult({ stdout: "{}" })
    ));
    await expect(checkAppiumUiAutomator2(runner)).resolves.toMatchObject({
      status: "failed",
      message: "Appium UiAutomator2 driver is not installed"
    });
  });
});
