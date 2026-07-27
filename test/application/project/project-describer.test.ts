import { describe, expect, it } from "vitest";

import { ProjectDescriber } from "../../../src/application/project/project-describer.js";
import { runtimeConfig } from "../../fakes/runtime-fixture.js";

describe("ProjectDescriber", () => {
  it("returns project root, package name, and normalized launch activity", async () => {
    const result = await new ProjectDescriber().describe({
      projectRoot: "/project",
      config: runtimeConfig
    });

    expect(result).toEqual({
      projectRoot: "/project",
      packageName: "com.example.app",
      launchActivity: "com.example.app.MainActivity"
    });
  });

  it("normalizes a fully qualified launch activity", async () => {
    const result = await new ProjectDescriber().describe({
      projectRoot: "/project",
      config: {
        ...runtimeConfig,
        run: {
          packageName: "com.example.app",
          activity: "com.example.app.SearchActivity"
        }
      }
    });

    expect(result).toEqual({
      projectRoot: "/project",
      packageName: "com.example.app",
      launchActivity: "com.example.app.SearchActivity"
    });
  });

  it("forwards the cancellation signal unchanged", async () => {
    const signal = new AbortController().signal;

    const result = await new ProjectDescriber().describe({
      projectRoot: "/project",
      config: runtimeConfig,
      signal
    });

    expect(result).toEqual({
      projectRoot: "/project",
      packageName: "com.example.app",
      launchActivity: "com.example.app.MainActivity"
    });
  });
});
