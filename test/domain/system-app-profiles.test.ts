import { describe, expect, it } from "vitest";

import {
  SYSTEM_APP_PACKAGES,
  isKnownSystemPackage,
  isSystemScenario
} from "../../src/domain/system-app-profiles.js";

describe("SYSTEM_APP_PACKAGES", () => {
  it("defines package lists for photoCapture, pickImage, and pickFile", () => {
    expect(SYSTEM_APP_PACKAGES.photoCapture).toContain("com.android.camera");
    expect(SYSTEM_APP_PACKAGES.pickImage).toContain(
      "com.google.android.apps.photos"
    );
    expect(SYSTEM_APP_PACKAGES.pickFile).toContain("com.android.documentsui");
  });

  it("does not define a custom scenario list", () => {
    expect(SYSTEM_APP_PACKAGES).not.toHaveProperty("custom");
  });
});

describe("isKnownSystemPackage", () => {
  it("returns true for a known photoCapture package", () => {
    expect(isKnownSystemPackage("photoCapture", "com.android.camera")).toBe(
      true
    );
  });

  it("returns false for an unknown package", () => {
    expect(isKnownSystemPackage("photoCapture", "com.evil.camera")).toBe(false);
  });

  it("returns false for a known package in the wrong scenario", () => {
    expect(
      isKnownSystemPackage("photoCapture", "com.android.documentsui")
    ).toBe(false);
  });
});

describe("isSystemScenario", () => {
  it.each(["photoCapture", "pickImage", "pickFile"])(
    "returns true for %s",
    (scenario) => {
      expect(isSystemScenario(scenario)).toBe(true);
    }
  );

  it("returns false for custom", () => {
    expect(isSystemScenario("custom")).toBe(false);
  });

  it("returns false for an unknown scenario string", () => {
    expect(isSystemScenario("videoCapture")).toBe(false);
  });
});
