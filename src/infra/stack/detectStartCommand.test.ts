import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TwinError } from "../../domain/errors.js";
import { detectStartCommand } from "./detectStartCommand.js";

describe("detectStartCommand", () => {
  let projectDir: string;

  afterEach(async () => {
    if (projectDir !== undefined) await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function withPackageJson(scripts: Record<string, string>): Promise<void> {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-detect-"));
    await writeFile(path.join(projectDir, "package.json"), JSON.stringify({ scripts }), "utf8");
  }

  it("throws E_NO_STACK when there is no package.json", async () => {
    projectDir = await mkdtemp(path.join(os.tmpdir(), "twin-detect-"));

    const err = await detectStartCommand(projectDir).catch((e: unknown) => e);
    expect(TwinError.isTwinError(err)).toBe(true);
    expect((err as TwinError).code).toBe("E_NO_STACK");
  });

  it("throws E_NO_STACK when scripts has nothing start-like", async () => {
    await withPackageJson({ test: "vitest run", build: "tsc" });

    const err = await detectStartCommand(projectDir).catch((e: unknown) => e);
    expect(TwinError.isTwinError(err)).toBe(true);
    expect((err as TwinError).code).toBe("E_NO_STACK");
  });

  it('prefers "start" over any other script', async () => {
    await withPackageJson({ dev: "nodemon server.js", start: "node server.js" });
    await expect(detectStartCommand(projectDir)).resolves.toBe("npm start");
  });

  it('falls back to "dev" when there is no "start"', async () => {
    await withPackageJson({ test: "vitest run", dev: "nodemon server.js" });
    await expect(detectStartCommand(projectDir)).resolves.toBe("npm run dev");
  });

  it("uses the single non-lifecycle script when there's exactly one candidate", async () => {
    await withPackageJson({ test: "vitest run", server: "node index.js" });
    await expect(detectStartCommand(projectDir)).resolves.toBe("npm run server");
  });

  it("throws E_AMBIGUOUS_STACK when there are multiple equally-plausible scripts", async () => {
    await withPackageJson({ server: "node index.js", api: "node api.js" });

    const err = await detectStartCommand(projectDir).catch((e: unknown) => e);
    expect(TwinError.isTwinError(err)).toBe(true);
    expect((err as TwinError).code).toBe("E_AMBIGUOUS_STACK");
    expect((err as TwinError).details?.candidates).toEqual(["server", "api"]);
  });
});
