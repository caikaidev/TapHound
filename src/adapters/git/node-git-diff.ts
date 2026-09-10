import { ChangeSetSchema, type ChangeSet, type ChangedFile } from "../../domain/impact.js";
import type { GitDiffPort } from "../../ports/git-diff.js";
import type { ProcessRunner } from "../../ports/process-runner.js";

const NAME_STATUS_RE = /^(\w+)\t(.*)$/;

function parseStatus(token: string): ChangedFile["status"] {
  if (token.startsWith("A")) return "added";
  if (token.startsWith("D")) return "deleted";
  if (token.startsWith("R")) return "renamed";
  if (token.startsWith("C")) return "added";
  return "modified";
}

export class NodeGitDiff implements GitDiffPort {
  public constructor(private readonly runner: ProcessRunner) {}

  public async diff(input: {
    projectRoot: string;
    base: string;
    head: string;
    signal?: AbortSignal | undefined;
  }): Promise<ChangeSet> {
    const result = await this.runner.run({
      executable: "git",
      args: [
        "-C",
        input.projectRoot,
        "diff",
        "--name-status",
        "-M",
        "--no-ext-diff",
        `${input.base}...${input.head}`
      ],
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    if (result.exitCode !== 0 || result.timedOut || result.cancelled) {
      throw new Error(
        result.stderr.trim()
          || result.spawnError
          || `git diff ${input.base}...${input.head} failed`
      );
    }
    const files: ChangedFile[] = [];
    for (const line of result.stdout.split("\n")) {
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
    return ChangeSetSchema.parse({
      version: 1,
      base: input.base,
      head: input.head,
      files
    });
  }
}