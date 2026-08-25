// One narrow setup operation: promote a verified newsletter sender without
// placing the Worker secret in shell history or logs.
import { loadConfig, resolveRepoRoot } from "../core/config.ts";
import type { WordholdConfig } from "../core/types.ts";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface AllowResult {
  address: string;
  unquarantined: number;
}

export async function allowSender(
  config: WordholdConfig,
  rawAddress: string,
  fetchFn: FetchLike = fetch,
): Promise<AllowResult> {
  const address = rawAddress.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    throw new Error("valid sender email required");
  }
  const base = config.worker.baseUrl.replace(/\/+$/, "");
  if (!base || !config.worker.secret) {
    throw new Error("worker.baseUrl and worker secret must be configured");
  }
  const response = await fetchFn(`${base}/v1/allow`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.worker.secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ address }),
  });
  if (!response.ok) {
    throw new Error(`worker allow failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as Partial<AllowResult>;
  if (body.address !== address || !Number.isInteger(body.unquarantined)) {
    throw new Error("worker allow returned an invalid response");
  }
  return { address, unquarantined: body.unquarantined! };
}

if (import.meta.main) {
  const address = process.argv[2];
  if (!address) throw new Error("usage: bun run worker:allow sender@example.com");
  const repoRoot = resolveRepoRoot();
  const result = await allowSender(loadConfig(repoRoot), address);
  console.log(
    `allowed ${result.address}; released ${result.unquarantined} quarantined message${result.unquarantined === 1 ? "" : "s"}`,
  );
}
