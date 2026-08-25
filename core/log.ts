import { join } from "node:path";
import { appendPrivateFile } from "./private-fs.ts";

export function log(
  repoRoot: string,
  component: string,
  message: string,
): void {
  const line = `${new Date().toISOString()}\t${component}\t${message}\n`;
  appendPrivateFile(join(repoRoot, "logs", "daemon.log"), line);
  if (process.env.PAPERTRAIL_VERBOSE === "1") console.log(line.trimEnd());
}
