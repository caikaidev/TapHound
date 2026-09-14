export interface TargetProjectInspection {
  settingsFile?: string | undefined;
  hasWrapperEntry: boolean;
  hasWrapperProperties: boolean;
  hasModuleBuildFile: boolean;
  rootProjectName?: string | undefined;
  settingsSha256?: string | undefined;
}

export interface TargetProjectInspectorPort {
  inspect: (root: string) => Promise<TargetProjectInspection>;
}
