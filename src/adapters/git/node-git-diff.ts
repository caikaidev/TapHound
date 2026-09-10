import { ChangeSetSchema, type ChangeSet, type ChangedFile } from "../../domain/impact.js";
import type { FailureCode } from "../../domain/failure.js";
import type { GitDiffPort } from "../../ports/git-diff.js";
import type { ProcessRunner, CommandResult } from "../../ports/process-runner.js";

const NAME_STATUS_RE = /^(\w+)\t(.*)$/;

function parseStatus(token: string): ChangedFile["status"] {
  if (token.startsWith("A")) return "added";
  if (token.startsWith("D")) return "deleted";
  if (token.startsWith("R")) return "renamed";
  if (token.startsWith("C")) return "added";
  return "modified";
}

class GitDiffError extends Error {
  public readonly code: FailureCode;

  public constructor(code: FailureCode, message: string) {
    super(message);
    this.name = "GitDiffError";
    this.code = code;
  }
}

function failed(
  result: {
    exitCode: number | null;
    stderr: string;
    spawnError?: string | undefined;
    timedOut: boolean;
    cancelled: boolean;
  }
): string | undefined {
  if (result.exitCode !== 0 || result.timedOut || result.cancelled) {
    return result.stderr.trim()
      || result.spawnError
      || "git command failed";
  }
  return undefined;
}

export class NodeGitDiff implements GitDiffPort {
  public constructor(private readonly runner: ProcessRunner) {}

  public async diff(input: {
    projectRoot: string;
    base: string;
    head: string;
    signal?: AbortSignal | undefined;
  }): Promise<ChangeSet> {
    const root = input.projectRoot;
    const signal = input.signal;
    await this.assertGitRoot(root, signal);
    await this.assertRef(root, input.base, signal);

    const head = input.head;
    if (head !== "WORKTREE") {
      await this.assertRef(root, head, signal);
    }
    const diffArg = head === "WORKTREE"
      ? input.base
      : `${input.base}...${head}`;
    const result = await this.runGit(
      root,
      ["diff", "--name-status", "-M", "--no-ext-diff", diffArg],
      signal
    );
    const message = failed(result);
    if (message !== undefined) {
      throw new Error(message);
    }
    const files = this.parse(result.stdout);
    if (files.length === 0) {
      return { version: 1, base: input.base, head, files };
    }
    return ChangeSetSchema.parse({
      version: 1,
      base: input.base,
      head,
      files
    });
  }

  private readonly assertGitRoot = async (
    root: string,
    signal?: AbortSignal
  ): Promise<void> => {
    const result = await this.runGit(
      root,
      ["rev-parse", "--is-inside-work-tree"],
      signal
    );
    const message = failed(result);
    if (message !== undefined) {
      throw new GitDiffError(
        "GIT_ROOT_NOT_FOUND",
        `${root} is not inside a Git work tree`
      );
    }
  };

  private readonly assertRef = async (
    root: string,
    ref: string,
    signal?: AbortSignal
  ): Promise<void> => {
    const result = await this.runGit(
      root,
      ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      signal
    );
    const message = failed(result);
    if (message !== undefined) {
      throw new GitDiffError(
        "GIT_REF_INVALID",
        `${ref} is not a valid Git ref`
      );
    }
  };

  private readonly runGit = (
    root: string,
    args: readonly string[],
    signal?: AbortSignal
  ): Promise<CommandResult> => this.runner.run({
    executable: "git",
    args: ["-C", root, ...args],
    ...(signal === undefined ? {} : { signal })
  });

  private readonly parse = (stdout: string): ChangedFile[] => {
    const files: ChangedFile[] = [];
    for (const line of stdout.split("\n")) {
      if (line === "") continue;
      const match = NAME_STATUS_RE.exec(line);
      if (match === null) {
        throw new Error(`git diff returned an unparsable line: ${line}`);
      }
      const statusToken = match[1];
      const rest = match[2];
      if (statusToken === undefined || rest === undefined) {
        throw new Error(`git diff returned a malformed line: ${line}`);
      }
      const status = parseStatus(statusToken);
      if (status === "renamed") {
        const separator = rest.indexOf("\t");
        if (separator === -1) {
          throw new Error(`git diff returned a malformed rename line: ${line}`);
        }
        files.push({
          path: rest.slice(separator + 1),
          oldPath: rest.slice(0, separator),
          status
        });
      } else {
        files.push({ path: rest, status });
      }
    }
    return files;
  };
}