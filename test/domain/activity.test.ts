import { describe, expect, it } from "vitest";

import { normalizeActivity } from "../../src/domain/activity.js";

describe("normalizeActivity", () => {
  it("expands a relative Activity with the configured package", () => {
    expect(normalizeActivity("com.example.app", ".MainActivity"))
      .toBe("com.example.app.MainActivity");
  });

  it("keeps a fully qualified Activity", () => {
    expect(normalizeActivity("com.example.app", "com.example.app.SearchActivity"))
      .toBe("com.example.app.SearchActivity");
  });

  it("normalizes an ADB component", () => {
    expect(normalizeActivity("com.example.app", "com.example.app/.SearchActivity"))
      .toBe("com.example.app.SearchActivity");
  });

  it("rejects a component from another package", () => {
    expect(() => normalizeActivity("com.example.app", "com.other/.MainActivity"))
      .toThrow(/package/i);
  });

  it("rejects an unqualified Activity without a leading dot", () => {
    expect(() => normalizeActivity("com.example.app", "MainActivity"))
      .toThrow(/activity/i);
  });
});
