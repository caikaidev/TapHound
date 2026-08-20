import { defaultExclude, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...defaultExclude, "**/.worktrees/**"],
    globalSetup: ["./test/global-setup.ts"]
  }
});
