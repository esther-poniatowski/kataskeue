import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { parseInstallationReceipt } from "../src/application/receipt.js";
import {
  recoverIncompleteTransaction,
  replaceManagedState,
} from "../src/application/transaction.js";
import { parseProfile } from "../src/domain/profile.js";
import { EkphrasisSettingsAdapter } from "../src/infrastructure/settings/ekphrasisSettingsAdapter.js";
import { FullCalendarRemasteredSettingsAdapter } from "../src/infrastructure/settings/fullCalendarRemasteredSettingsAdapter.js";
import { SieveSettingsAdapter } from "../src/infrastructure/settings/sieveSettingsAdapter.js";
import type { SettingsAdapter } from "../src/ports.js";

type Body = Record<string, unknown>;

interface Format {
  readonly name: string;
  readonly identifier: string;
  readonly oldValue: number;
  /** Fields of a valid file, without any format marker. */
  readonly body: Body;
  read(file: Body): Promise<unknown>;
}

const runtime = {
  minimum_obsidian: "1.0.0",
  checked_obsidian: "1.14.5",
  checked_installer: "1.14.5",
};

async function projectThrough(
  adapter: SettingsAdapter,
  file: Body,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "kataskeue-format-"));
  await mkdir(join(root, "projects"));
  const source = join(root, "source.yml");
  const destination = join(root, "data.json");
  await writeFile(source, JSON.stringify(file));
  await adapter.project(source, destination, { consumerRoot: root, root });
  return readFile(destination, "utf8");
}

async function recoverJournal(file: Body): Promise<unknown> {
  const vault = await mkdtemp(join(tmpdir(), "kataskeue-format-"));
  const journal = join(vault, ".kataskeue-transaction.json");
  const contents = JSON.stringify({
    ...file,
    transaction_root: join(vault, ".kataskeue-recovery"),
    target_obsidian: join(vault, ".obsidian"),
  });
  await writeFile(journal, contents);
  try {
    return await recoverIncompleteTransaction(vault);
  } catch (error) {
    assert.equal(await readFile(journal, "utf8"), contents);
    throw error;
  }
}

const adapterFormats = [
  {
    name: "Ekphrasis configuration file",
    identifier: "ekphrasis:configuration@1",
    adapter: new EkphrasisSettingsAdapter(),
    body: {
      schema_registry: "specs/schema-registry.yml",
      path_rules: [],
      commit_delay: 1000,
    },
  },
  {
    name: "Full Calendar configuration file",
    identifier: "full-calendar:configuration@1",
    adapter: new FullCalendarRemasteredSettingsAdapter(),
    body: {
      calendar_source: { id: "tasks_1", name: "Tasks", color: "#3b82f6" },
      interface: {
        first_day: 1,
        time_format_24h: true,
        weather_hidden: true,
        display_timezone: "Europe/Paris",
      },
      tasks: {
        backlog_date_target: "scheduledDate",
        calendar_display_date_target: "scheduledDate",
        open_edit_modal_after_backlog_drop: false,
        task_display_format: "dayPlanner",
        include_global_query_in_backlog: true,
        backlog_query: "",
      },
    },
  },
  {
    name: "Sieve configuration file",
    identifier: "sieve:configuration@1",
    adapter: new SieveSettingsAdapter(),
    body: {
      projects_root: "projects",
      specification_file: "project.yml",
      selected_project_ids: [],
    },
  },
] as const;

const formats: readonly Format[] = [
  {
    name: "plugin record",
    identifier: "kataskeue:obsidian-plugins@1",
    oldValue: 1,
    body: { runtime, plugins: [] },
    read: async (file) => parseProfile(file),
  },
  {
    name: "installation receipt",
    identifier: "kataskeue:receipt@2",
    oldValue: 2,
    body: {
      profile_digest: "a".repeat(64),
      runtime,
      plugins: [],
      omitted: [],
    },
    read: async (file) => parseInstallationReceipt(file),
  },
  {
    name: "transaction journal",
    identifier: "kataskeue:transaction@1",
    oldValue: 1,
    body: {
      phase: "verified",
      original: {
        plugins: false,
        "community-plugins.json": false,
        "plugin-installation.json": false,
      },
    },
    read: recoverJournal,
  },
  ...adapterFormats.map(({ name, identifier, adapter, body }) => ({
    name,
    identifier,
    oldValue: 1,
    body,
    read: (file: Body) => projectThrough(adapter, file),
  })),
];

for (const format of formats) {
  const expected = format.identifier;

  test(`${format.name}: accepts the identifier ${expected}`, async () => {
    await format.read({ _schema: expected, ...format.body });
  });

  test(`${format.name}: rejects an absent _schema`, async () => {
    await assert.rejects(format.read(format.body), {
      name: "FileFormatError",
      message: new RegExp(`_schema.*${expected}`),
    });
  });

  test(`${format.name}: compares the whole identifier`, async () => {
    const owner = expected.split(":")[0];
    for (const wrong of [
      `${expected}.0`,
      expected.replace(/@\d+$/, "@99"),
      expected.replace(/^[^:]+:[^@]+/, `${owner}:other`),
      expected.replace(/@\d+$/, ""),
      7,
    ]) {
      await assert.rejects(format.read({ _schema: wrong, ...format.body }), {
        name: "FileFormatError",
        message: new RegExp(`_schema.*${expected}`),
      });
    }
  });

  test(`${format.name}: names _schema and its value for the retired key`, async () => {
    await assert.rejects(
      format.read({ format_version: format.oldValue, ...format.body }),
      {
        name: "FileFormatError",
        message: new RegExp(`format_version.*_schema: ${expected}`),
      },
    );
  });
}

for (const { name, identifier, adapter, body } of adapterFormats) {
  test(`${name}: keeps _schema out of the native data.json`, async () => {
    const native = await projectThrough(adapter, {
      _schema: identifier,
      ...body,
    });
    assert.doesNotMatch(native, /_schema|format_version/);
  });
}

test("transaction journal: is written with _schema as its first key", async () => {
  const vault = await mkdtemp(join(tmpdir(), "kataskeue-format-"));
  const transactionRoot = join(vault, ".kataskeue-write");
  const staged = join(transactionRoot, "vault", ".obsidian");
  await mkdir(join(staged, "plugins"), { recursive: true });
  await writeFile(join(staged, "community-plugins.json"), "[]\n");
  await writeFile(join(staged, "plugin-installation.json"), "{}\n");
  const transaction = await replaceManagedState(
    staged,
    join(vault, ".obsidian"),
    transactionRoot,
  );
  const journal = JSON.parse(
    await readFile(join(vault, ".kataskeue-transaction.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(Object.keys(journal)[0], "_schema");
  assert.equal(journal._schema, "kataskeue:transaction@1");
  await transaction.finalize();
});

const entry = resolve("src/cli.ts");
const loader = import.meta.resolve("tsx");

function runCheck(vault: string, ...options: string[]) {
  const env = { ...process.env };
  delete env.KATASKEUE_ROOT;
  return spawnSync(
    process.execPath,
    ["--import", loader, entry, "check", ...options],
    { cwd: vault, env, encoding: "utf8" },
  );
}

async function vaultHolding(record: string): Promise<string> {
  const vault = await mkdtemp(join(tmpdir(), "kataskeue-format-cli-"));
  await writeFile(join(vault, "obsidian-plugins.yml"), record);
  return vault;
}

const recordFields = [
  "runtime:",
  "  minimum_obsidian: 1.0.0",
  "  checked_obsidian: 1.14.5",
  "  checked_installer: 1.14.5",
  "plugins: []",
  "",
];

test("exits with status 2 on a record that keeps format_version", async () => {
  const vault = await vaultHolding(
    ["format_version: 1", ...recordFields].join("\n"),
  );
  const result = runCheck(vault);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /_schema: kataskeue:obsidian-plugins@1/);
});

test("exits with status 2 on a record without _schema", async () => {
  const vault = await vaultHolding(recordFields.join("\n"));
  const result = runCheck(vault);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /_schema: kataskeue:obsidian-plugins@1/);
});

test("exits with status 2 on a receipt in the old format, in both outputs", async () => {
  const vault = await vaultHolding(
    ["_schema: kataskeue:obsidian-plugins@1", ...recordFields].join("\n"),
  );
  await mkdir(join(vault, ".obsidian"));
  await writeFile(
    join(vault, ".obsidian", "plugin-installation.json"),
    JSON.stringify({ format_version: 2 }),
  );
  const text = runCheck(vault);
  assert.equal(text.status, 2);
  assert.match(text.stderr, /_schema: kataskeue:receipt@2/);

  const sarif = runCheck(vault, "--format", "sarif");
  assert.equal(sarif.status, 2);
  const log = JSON.parse(sarif.stdout) as {
    runs: Array<{
      results?: unknown[];
      invocations: Array<{ executionSuccessful: boolean }>;
    }>;
  };
  assert.equal(log.runs[0]?.invocations[0]?.executionSuccessful, false);
  await access(join(vault, ".obsidian", "plugin-installation.json"));
});
