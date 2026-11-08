import type { SkillProfile } from "../domain/init.js";

export interface SkillInstallResult {
  readonly targetPath: string;
  readonly skipped: boolean;
}

export interface SkillInstallerPort {
  listSkillNames: (profile?: SkillProfile) => Promise<readonly string[]>;
  installTo: (skillName: string, targetDir: string, profile?: SkillProfile) => Promise<SkillInstallResult>;
  /** Validate every installation root before writing any skills. */
  checkConflicts?: (profile: SkillProfile, targetDirs: readonly string[]) => Promise<void>;
}
