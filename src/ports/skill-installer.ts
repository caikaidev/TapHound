export interface SkillInstallResult {
  readonly targetPath: string;
  readonly skipped: boolean;
}

export interface SkillInstallerPort {
  listSkillNames: () => Promise<readonly string[]>;
  installTo: (skillName: string, targetDir: string) => Promise<SkillInstallResult>;
}
