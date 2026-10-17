import { createHash, randomBytes } from "node:crypto";

/**
 * A fresh salt for one run's response fingerprints. It lives only in the
 * scenario client's memory: fingerprints from the control and split runs
 * compare with each other, and with nothing outside this run. Written down,
 * it would make a hashed short password in results.json a dictionary lookup.
 */
export function newFingerprintSalt(): Buffer {
  return randomBytes(16);
}

/** sha256(salt + value), shortened - enough to tell values apart within one run. */
export function saltedHash(salt: Buffer): (value: string) => string {
  return (value) => createHash("sha256").update(salt).update(value).digest("hex").slice(0, 16);
}
