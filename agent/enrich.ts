// Enrichment job: selects clean has_body items before bounded retries (batch
// cap 20), runs the editable prompt through Codex without holding the writer
// lock, then locks only to apply and commit verified output.
// Commits its own diff so enrichment history stays separately revertable
// (AGENTS.md rule 8). Run: bun run agent/enrich.ts
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import matter from "gray-matter";
import { atomicWriteFile } from "../core/atomic.ts";
import { loadConfig, resolveAppRoot, resolveRepoRoot } from "../core/config.ts";
import { itemById, openDb, upsertItemRow } from "../core/db.ts";
import { changedPaths, commitPaths } from "../core/git.ts";
import { recordSourceRun } from "../core/health.ts";
import { log } from "../core/log.ts";
import { readItem, setEnrichment } from "../core/store.ts";
import type { Item, ItemStatus, WordholdConfig } from "../core/types.ts";
import { collapseWhitespace } from "../core/urls.ts";
import {
  claimWriterPath,
  clearCurrentWriterIntent,
  currentWriterPaths,
  recoverCurrentWriterIntent,
  withWriterSession,
} from "../core/writer.ts";

export type Runner = (prompt: string) => Promise<string>;

export interface TagEntry {
  name: string;
  definition?: string;
}

export type EnrichmentResponse =
  | { kind: "insufficient" }
  | { kind: "ok"; summary: string; tags: TagEntry[]; highlights: string[] };

const BATCH_CAP = 20;
const MAX_AI_HIGHLIGHTS = 5;
const MAX_ENRICHMENT_FAILURES = 3;
const DEFAULT_JOB_BUDGET_MS = 10 * 60_000;
const RETRY_NUDGE =
  "\n\nYour previous reply was not valid JSON. Return only valid JSON matching the schema above, with no prose and no code fences.";

export function selectEnrichable(db: Database, limit = BATCH_CAP): Item[] {
  const rows = db
    .query(
      `SELECT id FROM items WHERE status = 'has_body'
       ORDER BY CASE WHEN last_error GLOB 'enrichment_*_failed:*' THEN 1 ELSE 0 END,
                captured_at ASC, id ASC LIMIT ?`,
    )
    .all(limit) as { id: string }[];
  return rows.map((r) => itemById(db, r.id)!);
}

export interface VocabEntry {
  name: string;
  definition: string;
}

// Keyed by lowercased name; value keeps the canonical spelling from tags.md.
export function loadTagVocab(repoRoot: string): Map<string, VocabEntry> {
  const vocab = new Map<string, VocabEntry>();
  const p = join(repoRoot, "agent", "tags.md");
  if (!existsSync(p)) return vocab;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^- ([^:]+): (.+)$/.exec(line);
    if (!m) continue;
    const name = m[1].trim();
    vocab.set(name.toLowerCase(), { name, definition: m[2].trim() });
  }
  return vocab;
}

function renderVocab(vocab: Map<string, VocabEntry>): string {
  if (vocab.size === 0) return "(no tags yet)";
  return [...vocab.values()]
    .map((t) => `- ${t.name}: ${t.definition}`)
    .join("\n");
}

export function buildPrompt(
  template: string,
  vars: { title: string; url: string; body: string; existingTags: string },
): string {
  return template
    .replaceAll("{{TITLE}}", vars.title)
    .replaceAll("{{URL}}", vars.url)
    .replaceAll("{{BODY}}", vars.body)
    .replaceAll("{{EXISTING_TAGS}}", vars.existingTags);
}

function extractJson(raw: string): unknown {
  let s = raw.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(s);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {}
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {}
  }
  return null;
}

export function parseEnrichment(raw: string): EnrichmentResponse | null {
  const obj = extractJson(raw);
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return null;
  }
  const rec = obj as Record<string, unknown>;
  if (rec.error === "insufficient_content") return { kind: "insufficient" };
  if (typeof rec.summary !== "string" || !rec.summary.trim()) return null;
  if (!Array.isArray(rec.tags) || !Array.isArray(rec.highlights)) return null;
  const tags: TagEntry[] = [];
  for (const t of rec.tags) {
    if (t === null || typeof t !== "object") continue;
    const e = t as Record<string, unknown>;
    if (typeof e.name !== "string") continue;
    const entry: TagEntry = { name: e.name };
    if (typeof e.definition === "string") entry.definition = e.definition;
    tags.push(entry);
  }
  const highlights = rec.highlights.filter(
    (h): h is string => typeof h === "string",
  );
  return { kind: "ok", summary: rec.summary.trim(), tags, highlights };
}

// Keep only exact substrings of the body; a dropped batch proceeds with none
// rather than fabricating (AGENTS.md rule 5).
export function verbatimHighlights(
  candidates: string[],
  body: string,
): string[] {
  const out: string[] = [];
  for (const c of candidates) {
    const t = c.trim();
    if (!t || !body.includes(t)) continue;
    if (out.includes(t)) continue;
    out.push(t);
    if (out.length === MAX_AI_HIGHLIGHTS) break;
  }
  return out;
}

function appendNewTag(
  repoRoot: string,
  name: string,
  definition: string,
  at: string,
): void {
  const tagsPath = join(repoRoot, "agent", "tags.md");
  claimWriterPath(repoRoot, "agent/tags.md");
  mkdirSync(join(repoRoot, "agent"), { recursive: true });
  let prefix = "";
  if (existsSync(tagsPath)) {
    const cur = readFileSync(tagsPath, "utf8");
    if (cur !== "" && !cur.endsWith("\n")) prefix = "\n";
  }
  appendFileSync(tagsPath, `${prefix}- ${name}: ${definition}\n`);
  mkdirSync(join(repoRoot, "logs"), { recursive: true });
  claimWriterPath(repoRoot, "logs/new-tags.jsonl");
  appendFileSync(
    join(repoRoot, "logs", "new-tags.jsonl"),
    JSON.stringify({ at, tag: name, definition }) + "\n",
  );
}

// Known names map to their canonical spelling; new names need a definition
// (appended to tags.md and journaled for the owner's digest veto) or are dropped.
export function resolveTags(
  repoRoot: string,
  vocab: Map<string, VocabEntry>,
  entries: TagEntry[],
  at: string,
): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const name = collapseWhitespace(e.name).toLowerCase();
    if (!name || name.includes(":") || name.length > 60) continue;
    const known = vocab.get(name);
    if (known) {
      if (!out.includes(known.name)) out.push(known.name);
      continue;
    }
    const definition = e.definition ? collapseWhitespace(e.definition) : "";
    if (!definition) continue;
    appendNewTag(repoRoot, name, definition, at);
    vocab.set(name, { name, definition });
    out.push(name);
  }
  return out;
}

// Failure states store has no setter for. Touches only status/last_error;
// body and highlights ride through the gray-matter round trip untouched.
function patchFrontmatter(
  repoRoot: string,
  db: Database,
  item: Item,
  patch: { status?: ItemStatus; lastError: string },
): void {
  const abs = join(repoRoot, item.mdPath);
  claimWriterPath(repoRoot, item.mdPath);
  const parsed = matter(readFileSync(abs, "utf8"), {});
  if (patch.status) parsed.data.status = patch.status;
  parsed.data.last_error = patch.lastError;
  atomicWriteFile(abs, matter.stringify(parsed.content, parsed.data));
  upsertItemRow(db, {
    ...item,
    status: patch.status ?? item.status,
    lastError: patch.lastError,
  });
}

export type Outcome =
  | "enriched"
  | "thin_body"
  | "parse_failed"
  | "runner_failed"
  | "insufficient_content";

export type MutationBoundary = <T>(fn: () => T) => Promise<T>;

export interface EnrichContext {
  repoRoot: string;
  db: Database;
  config: WordholdConfig;
  runner: Runner;
  now: () => string;
  template: string;
  vocab: Map<string, VocabEntry>;
}

export async function enrichItem(
  ctx: EnrichContext,
  item: Item,
  mutate: MutationBoundary = async (fn) => fn(),
): Promise<Outcome> {
  const file = readItem(ctx.repoRoot, item.mdPath);
  const body = file.body;
  if (body.length < ctx.config.enrichment.minBodyChars) {
    await mutate(() =>
      patchFrontmatter(ctx.repoRoot, ctx.db, item, {
        status: "fetch_failed",
        lastError: "thin_body_at_enrichment",
      }),
    );
    return "thin_body";
  }
  const prompt = buildPrompt(ctx.template, {
    title: file.frontmatter.title ?? "(untitled)",
    url: item.url ?? "(no url)",
    body,
    existingTags: renderVocab(ctx.vocab),
  });
  let parsed: EnrichmentResponse | null;
  try {
    parsed = parseEnrichment(await ctx.runner(prompt));
    if (!parsed) {
      parsed = parseEnrichment(await ctx.runner(prompt + RETRY_NUDGE));
    }
  } catch (error) {
    await mutate(() =>
      recordEnrichmentFailure(ctx, item, "runner", error),
    );
    return "runner_failed";
  }
  if (!parsed) {
    await mutate(() => recordEnrichmentFailure(ctx, item, "parse"));
    return "parse_failed";
  }
  if (parsed.kind === "insufficient") {
    await mutate(() =>
      patchFrontmatter(ctx.repoRoot, ctx.db, item, {
        status: "fetch_failed",
        lastError: "insufficient_content",
      }),
    );
    return "insufficient_content";
  }
  const aiHighlights = verbatimHighlights(parsed.highlights, body);
  await mutate(() => {
    const tags = resolveTags(ctx.repoRoot, ctx.vocab, parsed.tags, ctx.now());
    setEnrichment(ctx.repoRoot, ctx.db, item.id, {
      summary: parsed.summary,
      tags,
      aiHighlights,
    });
  });
  return "enriched";
}

function recordEnrichmentFailure(
  ctx: EnrichContext,
  item: Item,
  kind: "parse" | "runner",
  error?: unknown,
): void {
  const prior = /^enrichment_(?:parse|runner)_failed:(\d+)/.exec(
    item.lastError ?? "",
  );
  const attempt = (prior ? Number(prior[1]) : 0) + 1;
  const detail = error instanceof Error ? collapseWhitespace(error.message) : "";
  patchFrontmatter(ctx.repoRoot, ctx.db, item, {
    ...(attempt >= MAX_ENRICHMENT_FAILURES ? { status: "fetch_failed" } : {}),
    lastError: `enrichment_${kind}_failed:${attempt}${detail ? ` ${detail.slice(0, 160)}` : ""}`,
  });
}

export interface EnrichOptions {
  repoRoot: string;
  assetRoot?: string;
  db: Database;
  config: WordholdConfig;
  runner: Runner;
  now?: () => string;
  batchSize?: number;
  maxRunMs?: number;
  clock?: () => number;
  mutate?: MutationBoundary;
}

export interface RunResult {
  processed: number;
  enriched: number;
  thin: number;
  parseFailed: number;
  insufficient: number;
  errors: number;
  changed: boolean;
}

export async function runEnrichment(opts: EnrichOptions): Promise<RunResult> {
  const template = readFileSync(
    join(opts.assetRoot ?? opts.repoRoot, "agent", "prompts", "enrich.md"),
    "utf8",
  );
  const ctx: EnrichContext = {
    repoRoot: opts.repoRoot,
    db: opts.db,
    config: opts.config,
    runner: opts.runner,
    now: opts.now ?? (() => new Date().toISOString()),
    template,
    vocab: loadTagVocab(opts.repoRoot),
  };
  const items = selectEnrichable(opts.db, opts.batchSize ?? BATCH_CAP);
  const result: RunResult = {
    processed: 0,
    enriched: 0,
    thin: 0,
    parseFailed: 0,
    insufficient: 0,
    errors: 0,
    changed: false,
  };
  const clock = opts.clock ?? Date.now;
  const startedAt = clock();
  for (const item of items) {
    if (clock() - startedAt >= (opts.maxRunMs ?? DEFAULT_JOB_BUDGET_MS)) {
      log(opts.repoRoot, "enrich", "job budget reached; remaining items deferred");
      break;
    }
    try {
      const outcome = await enrichItem(ctx, item, opts.mutate);
      result.processed += 1;
      if (outcome === "enriched") result.enriched += 1;
      else if (outcome === "thin_body") result.thin += 1;
      else if (outcome === "parse_failed") result.parseFailed += 1;
      else if (outcome === "runner_failed") result.errors += 1;
      else result.insufficient += 1;
      log(opts.repoRoot, "enrich", `${item.id} ${outcome}`);
    } catch (err) {
      result.errors += 1; // item untouched; next run retries
      log(
        opts.repoRoot,
        "enrich",
        `${item.id} error ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  result.changed = result.processed > 0;
  log(
    opts.repoRoot,
    "enrich",
    `run done: ${result.enriched} enriched, ${result.thin} thin, ${result.parseFailed} parse_failed, ${result.insufficient} insufficient, ${result.errors} errors`,
  );
  return result;
}

// Uses an ephemeral, schema-constrained Codex CLI run on the user's existing
// subscription. The empty temporary working directory keeps enrichment from
// wandering through the corpus; the complete item body is already in prompt.
export async function codexRunner(prompt: string): Promise<string> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.OPENAI_API_KEY;
  const repoRoot = resolveRepoRoot();
  const workDir = mkdtempSync(join(tmpdir(), "pt-enrich-agent-"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn([
      "codex",
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--output-schema",
      join(resolveAppRoot(), "agent", "enrichment-schema.json"),
      "-C",
      workDir,
      "-",
    ], {
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
    timer = setTimeout(() => proc.kill(), 120_000);
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) throw new Error(`codex exec exited with code ${code}`);
    if (!out.trim()) throw new Error("codex exec returned no final response");
    return out;
  } finally {
    if (timer) clearTimeout(timer);
    rmSync(workDir, { recursive: true, force: true });
  }
}

// The one sanctioned git write in this job (AGENTS.md rule 8). It commits only
// runtime-owned paths, even when unrelated user work is already staged.
export async function commitEnrichment(
  repoRoot: string,
  itemCount: number,
): Promise<boolean> {
  const claimed = currentWriterPaths();
  const paths = claimed.length
    ? claimed
    : await changedPaths(repoRoot, [
        "items",
        "agent/tags.md",
        "logs/new-tags.jsonl",
      ]);
  const committed = await commitPaths(
    repoRoot,
    paths,
    `enrichment: ${itemCount} items`,
  );
  if (claimed.length) clearCurrentWriterIntent();
  return committed;
}

export async function runEnrichmentJob(
  opts: EnrichOptions,
): Promise<RunResult> {
  try {
    await withWriterSession(opts.repoRoot, "enrichment", async () => {
      await recoverCurrentWriterIntent("enrichment: recover interrupted write");
    });
    const result = await runEnrichment({
      ...opts,
      mutate: async (fn) =>
        withWriterSession(opts.repoRoot, "enrichment", async () => {
          const value = fn();
          if (currentWriterPaths().length) {
            await commitEnrichment(opts.repoRoot, 1);
          }
          return value;
        }),
    });
    const failed = result.errors + result.parseFailed;
    recordSourceRun(opts.db, "job:enrichment", {
      ok: failed === 0,
      newItems: result.enriched,
      ...(failed > 0
        ? { error: `${failed} enrichment item failure(s)` }
        : {}),
    });
    return result;
  } catch (error) {
    recordSourceRun(opts.db, "job:enrichment", {
      ok: false,
      newItems: 0,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

if (import.meta.main) {
  const repoRoot = resolveRepoRoot();
  const config = loadConfig(repoRoot);
  const db = openDb(repoRoot);
  try {
    await runEnrichmentJob({
      repoRoot,
      assetRoot: resolveAppRoot(),
      db,
      config,
      runner: codexRunner,
    });
  } finally {
    db.close();
  }
}
