const PACKAGE_NAME = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const QUALIFIED_ACTIVITY = /^(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*$/;

function assertPackageName(packageName: string): void {
  if (!PACKAGE_NAME.test(packageName)) {
    throw new Error(`Invalid package name: ${packageName}`);
  }
}

function assertBelongsToPackage(packageName: string, activity: string): void {
  if (!activity.startsWith(`${packageName}.`)) {
    throw new Error(
      `Activity ${activity} does not belong to package ${packageName}`
    );
  }
}

export function normalizeActivity(
  packageName: string,
  activityOrComponent: string
): string {
  assertPackageName(packageName);

  const value = activityOrComponent.trim();
  if (value.includes("/")) {
    const parts = value.split("/");
    if (parts.length !== 2) {
      throw new Error(`Invalid Activity component: ${value}`);
    }

    const [componentPackage, componentActivity] = parts;
    if (componentPackage !== packageName || componentActivity === undefined) {
      throw new Error(
        `Activity component package does not match ${packageName}`
      );
    }

    const normalized = componentActivity.startsWith(".")
      ? `${componentPackage}${componentActivity}`
      : componentActivity;
    if (!QUALIFIED_ACTIVITY.test(normalized)) {
      throw new Error(`Invalid Activity: ${componentActivity}`);
    }
    assertBelongsToPackage(packageName, normalized);
    return normalized;
  }

  if (value.startsWith(".")) {
    const normalized = `${packageName}${value}`;
    if (!QUALIFIED_ACTIVITY.test(normalized)) {
      throw new Error(`Invalid Activity: ${value}`);
    }
    return normalized;
  }

  if (!QUALIFIED_ACTIVITY.test(value)) {
    throw new Error(`Invalid Activity: ${value}`);
  }

  assertBelongsToPackage(packageName, value);
  return value;
}

export function normalizeObservedActivityComponent(component: string): string {
  const value = component.trim();
  const parts = value.split("/");
  if (parts.length !== 2) {
    throw new Error(`Invalid Activity component: ${value}`);
  }
  const [componentPackage, componentActivity] = parts;
  if (
    componentPackage === undefined
    || componentActivity === undefined
    || !PACKAGE_NAME.test(componentPackage)
  ) {
    throw new Error(`Invalid Activity component: ${value}`);
  }
  const normalized = componentActivity.startsWith(".")
    ? `${componentPackage}${componentActivity}`
    : componentActivity;
  if (!QUALIFIED_ACTIVITY.test(normalized)) {
    throw new Error(`Invalid Activity component: ${value}`);
  }
  return normalized;
}
