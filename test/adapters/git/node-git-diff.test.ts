import { describe, expect, it, vi } from "vitest";

import { NodeGitDiff } from "../../../src/adapters/git/node-git-diff.js";
import { commandResult } from "../../fakes/process-runner.js";

function runner(stdout: string): {
  run: ReturnType<typeof vi.fn>;
} {
  return {
    run: vi.fn(() => Promise.resolve(commandResult({ stdout })))
  };
}

describe("NodeGitDiff", () => {
  it("parses modified, added, and deleted entries", async () => {
    const processRunner = runner([
      "M\tapp/src/main/res/layout/activity_main.xml",
      "A\tapp/src/main/java/dev/taphound/demo/SearchActivity.kt",
      "D\tdocs/old.md"
    ].join("\n"));
    const diff = new NodeGitDiff(processRunner as never);

    const result = await diff.diff({
      projectRoot: "/project",
      base: "origin/main",
      head: "HEAD"
    });

    expect(processRunner.run).toHaveBeenCalledWith({
      executable: "git",
      args: [
        "-C",
        "/project",
        "diff",
        "--name-status",
        "-M",
        "--no-ext-diff",
        "origin/main...HEAD"
      ],
      signal: undefined
    });
    expect(result.files).toEqual([{
      path: "app/src/main/res/layout/activity_main.xml",
      status: "modified"
    }, {
      path: "app/src/main/java/dev/taphound/demo/SearchActivity.kt",
      status: "added"
    }, {
      path: "docs/old.md",
      status: "deleted"
    }]);
  });

  it("parses rename entries with old and new paths", async () => {
    const processRunner = runner(
      "R100\tapp/src/main/java/OldActivity.kt\tapp/src/main/java/NewActivity.kt"
    );
    const diff = new NodeGitDiff(processRunner as never);

    const result = await diff.diff({
      projectRoot: "/project",
      base: "origin/main",
      head: "HEAD"
    });

    expect(result.files).toEqual([{
      path: "app/src/main/java/NewActivity.kt",
      oldPath: "app/src/main/java/OldActivity.kt",
      status: "renamed"
    }]);
  });

  it("reports GIT_ROOT_NOT_FOUND when projectRoot is not a Git work tree", async () => {
    const processRunner = {
      run: vi.fn(() => Promise.resolve(commandResult({
        exitCode: 128,
        stderr: "not a git repository"
      })))
    };
    const diff = new NodeGitDiff(processRunner as never);

    await expect(diff.diff({
      projectRoot: "/project",
      base: "origin/main",
      head: "HEAD"
    })).rejects.toMatchObject({ code: "GIT_ROOT_NOT_FOUND" });
  });

  it("reports GIT_REF_INVALID for an unknown base ref", async () => {
    const processRunner = {
      run: vi.fn()
        .mockResolvedValueOnce(commandResult({ exitCode: 0 }))
        .mockResolvedValueOnce(commandResult({
          exitCode: 128,
          stderr: "fatal: ambiguous argument"
        }))
    };
    const diff = new NodeGitDiff(processRunner as never);

    await expect(diff.diff({
      projectRoot: "/project",
      base: "does-not-exist",
      head: "HEAD"
    })).rejects.toMatchObject({ code: "GIT_REF_INVALID" });
  });

  it("fails when the diff exits nonzero after refs validate", async () => {
    const processRunner = {
      run: vi.fn()
        .mockResolvedValueOnce(commandResult({ exitCode: 0 }))
        .mockResolvedValueOnce(commandResult({ exitCode: 0 }))
        .mockResolvedValueOnce(commandResult({ exitCode: 0 }))
        .mockResolvedValueOnce(commandResult({
          exitCode: 128,
          stderr: "fatal: bad ref"
        }))
    };
    const diff = new NodeGitDiff(processRunner as never);

    await expect(diff.diff({
      projectRoot: "/project",
      base: "origin/main",
      head: "HEAD"
    })).rejects.toThrow("fatal: bad ref");
  });

  it("reports GIT_REF_INVALID for an unknown head ref", async () => {
    const processRunner = {
      run: vi.fn()
        .mockResolvedValueOnce(commandResult({ exitCode: 0 }))
        .mockResolvedValueOnce(commandResult({ exitCode: 0 }))
        .mockResolvedValueOnce(commandResult({
          exitCode: 128,
          stderr: "fatal: ambiguous argument"
        }))
    };
    const diff = new NodeGitDiff(processRunner as never);

    await expect(diff.diff({
      projectRoot: "/project",
      base: "origin/main",
      head: "does-not-exist"
    })).rejects.toMatchObject({ code: "GIT_REF_INVALID" });
  });

  it("diff(base, WORKTREE) includes staged and unstaged changes in one run", async () => {
    const processRunner = {
      run: vi.fn(() => Promise.resolve(commandResult({
        stdout: [
          "M\tapp/src/main/res/layout/activity_main.xml",
          "A\tdocs/new.md"
        ].join("\n")
      })))
    };
    const diff = new NodeGitDiff(processRunner as never);

    const result = await diff.diff({
      projectRoot: "/project",
      base: "origin/main",
      head: "WORKTREE"
    });

    expect(processRunner.run).toHaveBeenCalledWith({
      executable: "git",
      args: [
        "-C",
        "/project",
        "diff",
        "--name-status",
        "-M",
        "--no-ext-diff",
        "origin/main"
      ],
      signal: undefined
    });
    expect(result.head).toBe("WORKTREE");
    expect(result.files).toMatchObject([{
      path: "app/src/main/res/layout/activity_main.xml",
      status: "modified"
    }, {
      path: "docs/new.md",
      status: "added"
    }]);
  });
});