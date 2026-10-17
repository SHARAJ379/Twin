/** True if `pid` names a live process. Node emulates signal 0 on Windows too. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * True while anything spawned under `leaderPid` is still running.
 *
 * On POSIX an instance heads its own process group (`detached: true`), and a
 * group outlives its leader: `node server.js &` or a script that backgrounds
 * its server lets the launching shell exit at once while the server keeps
 * going in the same group. Judging the instance by the leader alone called
 * that a crash, skipped killing the group because the leader was "already
 * dead", and left the server running. The group id can't be recycled while
 * the group has members, so signalling `-leaderPid` asks exactly the right
 * question. Windows has no groups; the leader is all there is to ask about.
 */
export function isInstanceAlive(leaderPid: number): boolean {
  if (process.platform === "win32") return isProcessAlive(leaderPid);
  try {
    process.kill(-leaderPid, 0);
    return true;
  } catch {
    return isProcessAlive(leaderPid);
  }
}
