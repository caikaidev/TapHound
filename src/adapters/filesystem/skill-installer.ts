import { access, cp, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SKILL_DIRECTORY_NAME } from "../../domain/init.js";
import type {
  SkillInstallResult,
  SkillInstallerPort
} from "../../ports/skill-installer.js";

const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../.."
);

const PAYLOAD_PATH = resolve(
  PACKAGE_ROOT,
  "assets",
  "skills",
  SKILL_DIRECTORY_NAME
);

export class SkillPayloadMissingError extends Error {
  public override readonly name = "SkillPayloadMissingError";

  public constructor(public readonly payloadPath: string) {
    super(`Skill payload not found at ${payloadPath}`);
  }
}

export class FileSystemSkillInstaller implements SkillInstallerPort {
  public async findPayload(): Promise<string> {
    try {
      await access(PAYLOAD_PATH, constants.R_OK);
    } catch {
      throw new SkillPayloadMissingError(PAYLOAD_PATH);
    }
    return PAYLOAD_PATH;
  }

  public async installTo(targetDir: string): Promise<SkillInstallResult> {
    const payloadPath = await this.findPayload();
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
