import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Wordhold payloads can contain full article text and personal notes. New
// runtime paths therefore default to owner-only access. Existing paths are not
// chmodded here: correcting a live installation is an explicit operator step.
export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function appendPrivateFile(
  path: string,
  data: string | Uint8Array,
): void {
  ensurePrivateDir(dirname(path));
  appendFileSync(path, data, { mode: 0o600 });
}
