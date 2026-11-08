import { access, cp, lstat, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { SkillProfile } from "../../domain/init.js";
import type {
  SkillInstallResult,
  SkillInstallerPort
} from "../../ports/skill-installer.js";

const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../.."
);

const LEGACY_SKILLS_DIR = resolve(PACKAGE_ROOT, "assets", "skills");
const FIELD_SKILLS_DIR = resolve(PACKAGE_ROOT, "field-skills");
const LEGACY_ONLY = [
  "taphound-bug-fix", "taphound-verify-change", "taphound-case-suite",
  "taphound-journey-generator", "taphound-journey-brief-author"
] as const;
const FIELD_ONLY = ["tap-check", "tap-fix"] as const;
const FIELD_VERSION = /version:\s*["']?\d+\.\d+-copy-ready/;
function skillRoot(profile: SkillProfile): string {
  return profile === "field" ? FIELD_SKILLS_DIR : LEGACY_SKILLS_DIR;
}
async function installedSkill(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** A Field Skill reinstall is safe only when the existing payload is byte-identical.
 * Otherwise require an explicit backup/move to avoid silently overwriting customizations
 * or leaving removed scripts from previous versions in place.
 */
async function samePayloadTree(source: string, destination: string): Promise<boolean> {
  const [sourceEntries, destinationEntries] = await Promise.all([
    readdir(source, { withFileTypes: true }),
    readdir(destination, { withFileTypes: true })
  ]);
  if (sourceEntries.length !== destinationEntries.length) return false;
  const byName = new Map(destinationEntries.map(entry => [entry.name, entry]));
  for (const entry of sourceEntries) {
    const oldEntry = byName.get(entry.name);
    if (oldEntry === undefined || entry.isSymbolicLink() || oldEntry.isSymbolicLink()) return false;
    const src = join(source, entry.name), dst = join(destination, entry.name);
    if (entry.isDirectory() && oldEntry.isDirectory()) {
      if (!await samePayloadTree(src, dst)) return false;
    } else if (entry.isFile() && oldEntry.isFile()) {
      if (!(await readFile(src)).equals(await readFile(dst))) return false;
    } else {
      return false;
    }
  }
  return true;
}
async function hasExistingPath(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

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

export class SkillProfileConflictError extends Error {
  public override readonly name = "SkillProfileConflictError";
  public constructor(
    public readonly profile: SkillProfile,
    public readonly conflicts: readonly string[]
  ) {
    super("Cannot install " + profile + " skills alongside a conflicting profile: "
      + conflicts.join(", ") + ". Move conflicting Skill directories outside the agent's skills folder, "
      + "back up customizations, then retry; no Skill files were changed.");
  }
}

export class FileSystemSkillInstaller implements SkillInstallerPort {
  /** Refuse mixed profiles before writing to any agent directory. */
  public async checkConflicts(profile: SkillProfile, targetDirs: readonly string[]): Promise<void> {
    const roots = new Set(targetDirs.map((targetDir) => dirname(resolve(targetDir))));
    const conflicts: string[] = [];
    for (const root of roots) {
      for (const name of (profile === "field" ? LEGACY_ONLY : FIELD_ONLY)) {
        const file = join(root, name, "SKILL.md");
        if (await installedSkill(file) !== undefined) conflicts.push(file);
      }
      const flashPath = join(root, "taphound-flash", "SKILL.md");
      const flash = await installedSkill(flashPath);
      if (flash !== undefined && FIELD_VERSION.test(flash) !== (profile === "field")) {
        conflicts.push(flashPath);
      }
      if (profile === "field") {
        for (const targetDir of targetDirs.filter(dir => dirname(resolve(dir)) === root)) {
          const target = resolve(targetDir);
          const source = join(FIELD_SKILLS_DIR, basename(target));
          if (await hasExistingPath(target) && !await samePayloadTree(source, target)) {
            conflicts.push(target + " (different files: move the existing directory aside before reinstalling)");
          }
        }
      }
    }
    if (conflicts.length > 0) throw new SkillProfileConflictError(profile, conflicts);
  }

  public async listSkillNames(profile: SkillProfile = "legacy"): Promise<readonly string[]> {
    const root = skillRoot(profile);
    const entries = await readdir(root, { withFileTypes: true });
    const skillNames: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const skillMd = join(root, entry.name, "SKILL.md");
      try {
        await access(skillMd, constants.R_OK);
        skillNames.push(entry.name);
      } catch {
        // Not a skill directory (no SKILL.md), skip
      }
    }
    if (skillNames.length === 0) {
      throw new NoSkillsFoundError(root);
    }
    return skillNames;
  }

  public async installTo(
    skillName: string,
    targetDir: string,
    profile: SkillProfile = "legacy"
  ): Promise<SkillInstallResult> {
    if (!/^[a-z0-9-]+$/.test(skillName)) throw new SkillPayloadMissingError(skillName);
    const payloadPath = resolve(skillRoot(profile), skillName);
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
    if (profile === "field" && await hasExistingPath(resolvedTarget) &&
        !await samePayloadTree(payloadPath, resolvedTarget)) {
      throw new SkillProfileConflictError(profile, [resolvedTarget + " (existing payload differs)"]);
    }

    await mkdir(dirname(resolvedTarget), { recursive: true });
    await cp(payloadPath, resolvedTarget, {
      recursive: true,
      force: true
    });

    return { targetPath: resolvedTarget, skipped: false };
  }
}
