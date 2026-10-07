import { writeFile } from "node:fs/promises";
import path from "node:path";

import { TwinError } from "../../domain/errors.js";
import type { TwinConfig } from "../../domain/twinConfig.js";
import { detectStack } from "../../infra/stack/detectStack.js";
import { TWIN_CONFIG_FILENAME } from "../../infra/config/loadTwinConfig.js";
import type { Logger } from "../../ports/logger.js";

const SCAFFOLD_SCENARIO = `name: starter
version: 1
steps:
  - id: health-check
    kind: request
    request: { method: GET, path: /health }
    expect: { status: 200 }

# This is a no-op starter - it proves Twin can boot your app and talk to it,
# but doesn't exercise anything yet. Add steps that create state via one
# instance and read it back via the other to catch real multi-instance bugs:
#
#   - id: login
#     kind: request
#     via: A
#     request: { method: POST, path: /login, json: { email: "...", password: "..." } }
#     expect: { status: 200 }
#   - id: me-check
#     kind: request
#     via: B
#     request: { method: GET, path: /me }
#     expect: { status: 200 }
#     check: session-survives-switch
#
# Built-in checks you can tag a step with: session-survives-switch,
# data-consistency, file-consistency, restart-persistence.
# Full step/check reference: docs/scenario.schema.json.
`;

export interface InitOptions {
  projectDir: string;
  /** Relative to projectDir unless absolute. */
  scenarioPath: string;
  force: boolean;
}

async function writeIfAbsent(filePath: string, contents: string, force: boolean, logger: Logger, label: string): Promise<boolean> {
  if (!force) {
    try {
      await writeFile(filePath, contents, { encoding: "utf8", flag: "wx" });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        logger.info(`${label} already exists - not overwriting`, { path: filePath, hint: "pass --force to replace it" });
        return false;
      }
      throw err;
    }
  }
  await writeFile(filePath, contents, "utf8");
  return true;
}

/** `twin init`: scaffolds a starter scenario.yaml and a twin.config.json so a bare `twin run` works afterward. */
export async function initCommand(options: InitOptions, logger: Logger): Promise<void> {
  const scenarioPath = path.isAbsolute(options.scenarioPath) ? options.scenarioPath : path.join(options.projectDir, options.scenarioPath);
  const scenarioRelPath = path.relative(options.projectDir, scenarioPath);

  const wroteScenario = await writeIfAbsent(scenarioPath, SCAFFOLD_SCENARIO, options.force, logger, "scenario file");
  if (wroteScenario) logger.info("wrote scenario", { path: scenarioPath });

  // Both are best-effort: a scaffold is still useful on a project Twin can't
  // identify, as long as it says so clearly instead of writing a wrong guess.
  let stack: string | undefined;
  let start: string | undefined;
  try {
    const detected = await detectStack(options.projectDir);
    stack = detected.profile.id;
    start = detected.startCommand;
    logger.info(`detected a ${detected.profile.displayName} project`);
    if (start === undefined) {
      logger.warn(`couldn't tell how to start it - add a "start" command to ${TWIN_CONFIG_FILENAME}`);
    }
  } catch (err) {
    if (!TwinError.isTwinError(err)) throw err;
    logger.warn(`couldn't identify the stack (${err.message}) - set "stack" and "start" in ${TWIN_CONFIG_FILENAME}`);
  }

  const config: TwinConfig = {
    scenario: scenarioRelPath,
    ...(stack !== undefined ? { stack } : {}),
    ...(start !== undefined ? { start } : {})
  };
  const configPath = path.join(options.projectDir, TWIN_CONFIG_FILENAME);
  const wroteConfig = await writeIfAbsent(configPath, `${JSON.stringify(config, null, 2)}\n`, options.force, logger, TWIN_CONFIG_FILENAME);
  if (wroteConfig) logger.info(`wrote ${TWIN_CONFIG_FILENAME}`, { path: configPath, ...config });

  logger.info(start === undefined ? "next: edit twin.config.json to add a start command, then run `twin run`" : "next: run `twin run`");
}
