import { spawnSync } from "node:child_process";

/** Best-effort live command line for `pid`, or undefined if it can't be determined. */
export function getCommandLine(pid: number): string | undefined {
  try {
    if (process.platform === "win32") {
      const result = spawnSync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { encoding: "utf8", windowsHide: true, timeout: 5000 }
      );
      const out = result.stdout?.trim();
      return out !== undefined && out.length > 0 ? out : undefined;
    }

    const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 5000 });
    const out = result.stdout?.trim();
    return out !== undefined && out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}
