import { access, cp, mkdir, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  SkillInstallResult,
  SkillInstallerPort
} from "../../ports/skill-installer.js";

const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../.."
);

const SKILLS_DIR = resolve(
  PACKAGE_ROOT,
  "assets",
  "skills"
);

export class SkillPayloadMissingError extends Error {
  public override readonly name = "SkillPayloadMissingError";

  public constructor(public readonly payloadPath: string) {
    super(`Skill payload not found at ${payloadPath}`);
  }
}

export class NoSkillsFoundError extends Error {
  public override readonly name = "NoSkillsFoundError";

  public constructor(public readonly scannedDir: string) {
    super(`No skills (directories with SKILL.md) found under ${scannedDir}`);
  }
}

export class FileSystemSkillInstaller implements SkillInstallerPort {
  public async listSkillNames(): Promise<readonly string[]> {
    const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
    const skillNames: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const skillMd = join(SKILLS_DIR, entry.name, "SKILL.md");
      try {
        await access(skillMd, constants.R_OK);
        skillNames.push(entry.name);
      } catch {
        // Not a skill directory (no SKILL.md), skip
      }
    }
    if (skillNames.length === 0) {
      throw new NoSkillsFoundError(SKILLS_DIR);
    }
    return skillNames;
  }

  public async installTo(
    skillName: string,
    targetDir: string
  ): Promise<SkillInstallResult> {
    const payloadPath = resolve(SKILLS_DIR, skillName);
    try {
      await access(payloadPath, constants.R_OK);
      const stats = await stat(payloadPath);
      if (!stats.isDirectory()) {
        throw new SkillPayloadMissingError(payloadPath);
      }
    } catch {
      throw new SkillPayloadMissingError(payloadPath);
    }

    const resolvedTarget = resolve(targetDir);

    if (resolvedTarget === resolve(payloadPath)) {
      return { targetPath: resolvedTarget, skipped: true };
    }

    await mkdir(dirname(resolvedTarget), { recursive: true });
    await cp(payloadPath, resolvedTarget, {
      recursive: true,
      force: true
    });

    return { targetPath: resolvedTarget, skipped: false };
  }
}
