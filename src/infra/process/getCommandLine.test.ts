import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync
}));

import { getCommandLine } from "./getCommandLine.js";

const timedOut = { stdout: "", signal: "SIGTERM", error: Object.assign(new Error("spawnSync powershell ETIMEDOUT"), { code: "ETIMEDOUT" }) };
const answered = { stdout: "node C:\\twin\\dist\\cli\\index.js run\r\n", signal: null, error: undefined };

/**
 * Found on a fresh Windows CI runner: the first CIM query took over ten
 * seconds, the lookup gave up, and a lock holder Twin could have identified
 * came back "unknown".
 */
describe.runIf(process.platform === "win32")("getCommandLine on Windows", () => {
  afterEach(() => {
    spawnSync.mockReset();
  });

  it("asks again, with longer to answer, when the first query times out", () => {
    spawnSync.mockReturnValueOnce(timedOut).mockReturnValueOnce(answered);
    expect(getCommandLine(1234)).toBe("node C:\\twin\\dist\\cli\\index.js run");
    expect(spawnSync).toHaveBeenCalledTimes(2);
    expect(spawnSync.mock.calls[1]![2]).toMatchObject({ timeout: 30_000 });
  });

  it("gives up as unknown when the second query times out too", () => {
    spawnSync.mockReturnValue(timedOut);
    expect(getCommandLine(1234)).toBeUndefined();
    expect(spawnSync).toHaveBeenCalledTimes(2);
  });

  it("doesn't ask twice when the process simply has no command line to show", () => {
    spawnSync.mockReturnValueOnce({ stdout: "", signal: null, error: undefined });
    expect(getCommandLine(1234)).toBeUndefined();
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });
});
