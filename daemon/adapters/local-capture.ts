// `pt capture` writes directly to the shared durable raw spool. This adapter
// has no upstream system to pull or acknowledge; its name lets the ordinary
// daemon transaction discover and process those queued entries.
import type { SourceAdapter } from "../../core/types.ts";

export function createLocalCaptureAdapter(): SourceAdapter {
  return {
    name: "local_capture",
    pull: async () => [],
  };
}
