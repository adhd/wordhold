// Upgrade/repair operation: mirror the D1 sender allowlist into retained R2
// markers so a transient D1 lookup failure cannot demote a known newsletter.
import { loadConfig, resolveRepoRoot } from "../core/config.ts";
import type { WordholdConfig } from "../core/types.ts";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export async function syncSenders(
  config: WordholdConfig,
  fetchFn: FetchLike = fetch,
): Promise<number> {
  const base = config.worker.baseUrl.replace(/\/+$/, "");
  if (!base || !config.worker.secret) {
    throw new Error("worker.baseUrl and worker secret must be configured");
  }
  const response = await fetchFn(`${base}/v1/sync-senders`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.worker.secret}` },
  });
  if (!response.ok) {
    throw new Error(`worker sender sync failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as { synced?: unknown };
  if (!Number.isInteger(body.synced) || Number(body.synced) < 0) {
    throw new Error("worker sender sync returned an invalid response");
  }
  return Number(body.synced);
}

if (import.meta.main) {
  const repoRoot = resolveRepoRoot();
  const synced = await syncSenders(loadConfig(repoRoot));
  console.log(`synced ${synced} sender allowlist marker${synced === 1 ? "" : "s"}`);
}
