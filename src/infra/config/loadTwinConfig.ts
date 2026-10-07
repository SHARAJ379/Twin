import { readFile } from "node:fs/promises";
import path from "node:path";

import { TwinError } from "../../domain/errors.js";
import { validateTwinConfig, type TwinConfig } from "../../domain/twinConfig.js";

export const TWIN_CONFIG_FILENAME = "twin.config.json";

/** Reads `<projectDir>/twin.config.json`. Returns undefined if it doesn't exist; throws E_CONFIG_INVALID if it's malformed. */
export async function loadTwinConfig(projectDir: string): Promise<TwinConfig | undefined> {
  const configPath = path.join(projectDir, TWIN_CONFIG_FILENAME);

  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    return undefined;
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new TwinError("E_CONFIG_INVALID", `${TWIN_CONFIG_FILENAME} is not valid JSON`, {
      hint: `Fix or delete ${configPath}.`,
      cause: err
    });
  }

  const result = validateTwinConfig(data);
  if (!result.ok) {
    const list = result.errors.map((e) => `  ${e.path.length > 0 ? e.path : "(root)"}: ${e.message}`).join("\n");
    throw new TwinError("E_CONFIG_INVALID", `${TWIN_CONFIG_FILENAME} is invalid:\n${list}`, {
      hint: `Fix ${configPath}.`,
      details: { errors: result.errors }
    });
  }
  return result.config;
}
