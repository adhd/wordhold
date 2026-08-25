import { homedir } from "node:os";
import { join } from "node:path";
import { initializeDataRoot } from "../core/installation.ts";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const dataRoot = argument("--data-root") ??
  process.env.PAPERTRAIL_ROOT ??
  join(homedir(), "Library", "Application Support", "Papertrail");
const result = initializeDataRoot(dataRoot);
console.log(JSON.stringify({ status: "ready", ...result }));
