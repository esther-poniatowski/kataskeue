import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const entry = resolve("src/cli.ts");
const loader = import.meta.resolve("tsx");
const emptyRecord = [
  "format_version: 1",
  "runtime:",
  "  minimum_obsidian: 1.0.0",
  "  checked_obsidian: 1.14.5",
  "  checked_installer: 1.14.5",
  "plugins: []",
  "",
].join("\n");

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(
  args: readonly string[],
  options: { cwd?: string; root?: string } = {},
): Run {
  const env = { ...process.env };
  delete env.KATASKEUE_ROOT;
  if (options.root !== undefined) env.KATASKEUE_ROOT = options.root;
  const result = spawnSync(
    process.execPath,
    ["--import", loader, entry, ...args],
    { cwd: options.cwd ?? process.cwd(), env, encoding: "utf8" },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** Return a vault holding the record but no installation receipt. */
async function vaultWithRecord(): Promise<string> {
  const vault = await mkdtemp(join(tmpdir(), "kataskeue-cli-"));
  await writeFile(join(vault, "obsidian-plugins.yml"), emptyRecord);
  return vault;
}

test("prints the version under -v and --version", () => {
  for (const flag of ["-v", "--version"]) {
    const result = run([flag]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^kataskeue \d+\.\d+\.\d+\n$/);
  }
});

test("exits with status 2 on a usage error", () => {
  assert.equal(run(["check", "--json"]).status, 2);
  assert.equal(run(["inspect"]).status, 2);
  assert.equal(run(["apply", "--format", "sarif"]).status, 2);
  assert.equal(run(["check", "--output", "log.txt"]).status, 2);
});

test("reads the record at the root found in the current folder", async () => {
  const vault = await vaultWithRecord();
  const result = run(["check"], { cwd: vault });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /receipt/);

  const empty = await mkdtemp(join(tmpdir(), "kataskeue-cli-"));
  const missing = run(["check"], { cwd: empty });
  assert.equal(missing.status, 2);
  assert.ok(missing.stderr.includes(join(empty, "obsidian-plugins.yml")));
});

test("takes the root from --root before KATASKEUE_ROOT", async () => {
  const vault = await vaultWithRecord();
  const empty = await mkdtemp(join(tmpdir(), "kataskeue-cli-"));
  assert.equal(run(["check"], { cwd: empty, root: vault }).status, 1);
  assert.equal(run(["check", "-r", empty], { root: vault }).status, 2);
  assert.equal(run(["check", "--root", vault], { root: empty }).status, 1);
});

test("writes a findings log at -o and exits with status 1 on a drift", async () => {
  const vault = await vaultWithRecord();
  const result = run(["check", "--format", "sarif", "-o", "build/k.sarif"], {
    cwd: vault,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const log = JSON.parse(
    await readFile(join(vault, "build", "k.sarif"), "utf8"),
  ) as { runs: Array<{ results: unknown[] }> };
  assert.equal(log.runs[0]?.results.length, 1);
});
