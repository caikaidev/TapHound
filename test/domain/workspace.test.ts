import { describe, expect, it } from "vitest";

import {
  legacyWorkspaceMessage
} from "../../src/domain/workspace.js";

describe("legacyWorkspaceMessage", () => {
  it("provides a build/runs migration target for stray root Verify runs", () => {
    const run = ".taphound/2026-08-06T12-34-56.789Z-123e4567-e89b-42d3-a456-426614174000";

    expect(legacyWorkspaceMessage([run])).toContain(
      `mv ${run} .taphound/build/runs/${run.slice(".taphound/".length)}`
    );
  });
});
