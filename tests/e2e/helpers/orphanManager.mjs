// Stands in for a Twin process that gets SIGKILLed mid-run (see
// orphanCleanup.test.ts). Spawns one real app instance, records it in a
// pids.json in the same shape ProcessInstanceDriver writes, then idles
// forever so the test can kill *this* process without it cleaning up after
// itself - leaving the instance orphaned, which is exactly what `twin
// clean` (§7.3) exists to catch.
import { spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const [, , appDir, pidsFilePath] = process.argv;

const port = await getFreePort();
const childLogPath = pidsFilePath.replace(/pids\.json$/, "child.log");
mkdirSync(path.dirname(childLogPath), { recursive: true });
const childLogFd = openSync(childLogPath, "a");

const child = spawn("npm", ["start"], {
  cwd: appDir,
  shell: true,
  // Node's docs: on Windows, detached is what lets this child survive even
  // if *this* process (standing in for Twin) is SIGKILLed - matches
  // ProcessInstanceDriver so this fixture actually exercises the real bug.
  detached: true,
  windowsHide: true,
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", childLogFd, childLogFd]
});
mkdirSync(path.dirname(pidsFilePath), { recursive: true });
writeFileSync(
  pidsFilePath,
  JSON.stringify([{ pid: child.pid, instance: "A", command: "npm start", startedAt: new Date().toISOString() }], null, 2)
);

console.log(`MANAGER_READY pid=${child.pid} port=${port}`);
setInterval(() => {}, 1000);
