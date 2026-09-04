import { defaultExclude, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...defaultExclude, "**/.worktrees/**"],
    // Generation lifecycle tests use many atomic filesystem transitions and
    // exceed Vitest's 5s default on slower local disks while still completing
    // deterministically. Keep a finite suite-wide timeout for real hangs.
    testTimeout: 30_000,
    globalSetup: ["./test/global-setup.ts"]
  }
});
