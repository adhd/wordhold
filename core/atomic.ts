import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export class FileTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`file exceeds ${maxBytes} bytes`);
    this.name = "FileTooLargeError";
  }
}

export function readFileBounded(path: string, maxBytes: number): Uint8Array {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("file byte limit must be a non-negative safe integer");
  }
  const fd = openSync(path, "r");
  const bytes = new Uint8Array(maxBytes + 1);
  let offset = 0;
  try {
    while (offset < bytes.byteLength) {
      const count = readSync(fd, bytes, offset, bytes.byteLength - offset, null);
      if (count === 0) break;
      offset += count;
    }
  } finally {
    closeSync(fd);
  }
  if (offset > maxBytes) throw new FileTooLargeError(maxBytes);
  return bytes.slice(0, offset);
}

export function atomicCopyFile(source: string, destination: string): void {
  const dir = dirname(destination);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(
    dir,
    `.${basename(destination)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let sourceFd: number | undefined;
  let destinationFd: number | undefined;
  try {
    sourceFd = openSync(source, "r");
    destinationFd = openSync(temp, "wx", 0o600);
    const buffer = new Uint8Array(64 * 1024);
    for (;;) {
      const count = readSync(sourceFd, buffer, 0, buffer.byteLength, null);
      if (count === 0) break;
      let written = 0;
      while (written < count) {
        written += writeSync(
          destinationFd,
          buffer,
          written,
          count - written,
        );
      }
    }
    fsyncSync(destinationFd);
    closeSync(destinationFd);
    destinationFd = undefined;
    closeSync(sourceFd);
    sourceFd = undefined;
    renameSync(temp, destination);
    syncDirectory(dir);
  } catch (error) {
    if (destinationFd !== undefined) closeSync(destinationFd);
    if (sourceFd !== undefined) closeSync(sourceFd);
    rmSync(temp, { force: true });
    throw error;
  }
}

function syncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY);
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Writes and fsyncs a sibling file before atomically replacing the target,
// then fsyncs the directory entry. A process death leaves either the previous
// complete file or the new complete file, never a partially overwritten one.
export function atomicWriteFile(path: string, data: string | Uint8Array): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(
    dir,
    `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    syncDirectory(dir);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
    throw error;
  }
}
