export interface SkillInstallResult {
  readonly targetPath: string;
  readonly skipped: boolean;
}

export interface SkillInstallerPort {
  findPayload: () => Promise<string>;
  installTo: (targetDir: string) => Promise<SkillInstallResult>;
}
