export interface AppProcess {
  pid: number;
  name: string;
}

export function isAppProcessName(
  name: string,
  packageName: string
): boolean {
  return name === packageName || name.startsWith(`${packageName}:`);
}

export function primaryAppPid(
  processes: readonly AppProcess[],
  packageName: string
): number | null {
  const exact = processes.find((process) => process.name === packageName);
  return exact?.pid ?? processes[0]?.pid ?? null;
}

export function appProcessPids(
  processes: readonly AppProcess[]
): readonly number[] {
  return processes.map((process) => process.pid);
}
