import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type FakeAgentClient = "codex" | "hermes";

/**
 * Installs deterministic command-line contract doubles for the two optional
 * agent clients. Product tests still exercise Wordhold's real subprocess and
 * filesystem boundaries without depending on developer-installed software.
 */
export function withFakeAgentClients(
  root: string,
  env: Record<string, string | undefined>,
  clients: FakeAgentClient[] = ["codex", "hermes"],
): Record<string, string> {
  const bin = join(root, "fake-agent-bin");
  mkdirSync(bin, { recursive: true });
  for (const client of clients) {
    const executable = join(bin, client);
    writeFileSync(executable, fakeClientSource(client));
    chmodSync(executable, 0o700);
  }
  const defined = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return { ...defined, PATH: `${bin}:${env.PATH ?? "/usr/bin:/bin"}` };
}

function fakeClientSource(client: FakeAgentClient): string {
  const homeVariable = client === "codex" ? "CODEX_HOME" : "HERMES_HOME";
  return [
    `#!${process.execPath}`,
    'import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    `const client = ${JSON.stringify(client)};`,
    `const homeVariable = ${JSON.stringify(homeVariable)};`,
    "const home = process.env[homeVariable];",
    "if (!home) { console.error(homeVariable + ' is required'); process.exit(2); }",
    "const statePath = join(home, '.fake-' + client + '-mcp.json');",
    "function readState() {",
    "  return existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};",
    "}",
    "function writeState(state) {",
    "  mkdirSync(home, { recursive: true });",
    "  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\\n');",
    "  if (client === 'hermes') renderHermesConfig(state);",
    "}",
    "function renderHermesConfig(state) {",
    "  const lines = ['mcp_servers:'];",
    "  for (const name of Object.keys(state).sort()) {",
    "    const entry = state[name];",
    "    lines.push('  ' + name + ':');",
    "    lines.push('    command: ' + JSON.stringify(entry.command));",
    "    if (entry.args.length) {",
    "      lines.push('    args:');",
    "      for (const arg of entry.args) lines.push('      - ' + JSON.stringify(arg));",
    "    }",
    "    lines.push('    env:');",
    "    for (const key of Object.keys(entry.env).sort()) {",
    "      lines.push('      ' + key + ': ' + JSON.stringify(entry.env[key]));",
    "    }",
    "    lines.push('    enabled: true');",
    "  }",
    "  writeFileSync(join(home, 'config.yaml'), lines.join('\\n') + '\\n');",
    "}",
    "const [, , group, action, name, ...rest] = process.argv;",
    "if (group !== 'mcp') process.exit(1);",
    "const state = readState();",
    "if (action === 'get') {",
    "  const entry = state[name];",
    "  if (!entry) process.exit(1);",
    "  console.log(JSON.stringify({ name, transport: { type: 'stdio', ...entry } }));",
    "  process.exit(0);",
    "}",
    "if (action === 'list') {",
    "  for (const key of Object.keys(state).sort()) console.log(key);",
    "  process.exit(0);",
    "}",
    "if (action === 'test') {",
    "  if (!state[name]) process.exit(1);",
    "  console.log('search_items');",
    "  process.exit(0);",
    "}",
    "if (action === 'remove') {",
    "  delete state[name];",
    "  writeState(state);",
    "  process.exit(0);",
    "}",
    "if (action === 'add') {",
    "  const entry = { command: '', args: [], env: {} };",
    "  for (let index = 0; index < rest.length;) {",
    "    const token = rest[index];",
    "    if (token === '--env') {",
    "      const assignment = rest[index + 1] || '';",
    "      const equals = assignment.indexOf('=');",
    "      if (equals < 1) process.exit(1);",
    "      entry.env[assignment.slice(0, equals)] = assignment.slice(equals + 1);",
    "      index += 2;",
    "      continue;",
    "    }",
    "    if (token === '--command') { entry.command = rest[index + 1] || ''; index += 2; continue; }",
    "    if (token === '--args') { entry.args = rest.slice(index + 1); break; }",
    "    if (token === '--') { entry.command = rest[index + 1] || ''; entry.args = rest.slice(index + 2); break; }",
    "    index += 1;",
    "  }",
    "  if (!entry.command) process.exit(1);",
    "  state[name] = entry;",
    "  writeState(state);",
    "  process.exit(0);",
    "}",
    "process.exit(1);",
    "",
  ].join("\n");
}
