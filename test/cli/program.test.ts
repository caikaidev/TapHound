import { describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/program.js";

describe("createProgram", () => {
  it("publishes the doctor, record, and verify commands", () => {
    const names = createProgram().commands.map((command) => command.name());

    expect(names).toEqual(["doctor", "record", "verify"]);
  });
});
