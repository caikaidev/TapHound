import { describe, expect, it, vi } from "vitest";

import { GradleAdapter } from "../../../src/adapters/gradle/gradle-adapter.js";
import { processRunner } from "../../fakes/process-runner.js";

describe("GradleAdapter", () => {
  it("runs the configured task through the project Gradle Wrapper", async () => {
    const runner = processRunner();
    const adapter = new GradleAdapter(runner);

    await adapter.build({
      projectDir: "/project",
      task: ":app:assembleDebug"
    });

    expect(vi.mocked(runner.run)).toHaveBeenCalledWith({
      executable: "./gradlew",
      args: [":app:assembleDebug"],
      cwd: "/project"
    });
  });
});
