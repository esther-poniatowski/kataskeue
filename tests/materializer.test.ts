import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyProfile, checkProfile } from "../src/application/materializer.js";
import {
  CheckCursor,
  observeCheck,
  type CheckOutcome,
} from "../src/application/checkSteps.js";
import { recoverIncompleteTransaction } from "../src/application/transaction.js";
import {
  parseProfile,
  type PluginProfile,
  type PluginRecord,
} from "../src/domain/profile.js";
import {
  BundleNotFoundError,
  DigestMismatchError,
  DriftError,
  FileFormatError,
  OperationLockedError,
  ProfileError,
  ProviderUnsupportedError,
  ReplacementError,
  StateFolderError,
} from "../src/errors.js";
import type {
  BundleAcquisition,
  BundleProvider,
  InstallablePlugin,
  OverrideInspector,
  PluginInstaller,
  SettingsAdapter,
} from "../src/ports.js";

const manifest =
  '{"id":"sample-plugin","name":"Sample","version":"1.0.0","minAppVersion":"1.0.0"}\n';
const main = "export const sample = true;\n";
const cleanOverride: OverrideInspector = {
  async inspect() {
    return { commit: "a".repeat(40), dirty: false };
  },
};

test("materializes the exact profile and removes launcher residue", async () => {
  const fixture = await createFixture();
  await writeFile(
    join(fixture.vault, ".obsidian", "plugins", "sample-plugin", "data.json"),
    '{"kept":true}\n',
  );
  const receipt = await applyProfile(
    { vault: fixture.vault, profile: fixture.profile },
    {
      bundles: new StaticProvider(fixture.bundle),
      installer: new CopyingInstaller(),
    },
  );
  assert.equal(
    receipt.plugins[0]?.repository,
    fixture.profile.plugins[0]?.repository,
  );
  assert.deepEqual(receipt.runtime, fixture.profile.runtime);
  assert.deepEqual(
    await readdir(join(fixture.vault, ".obsidian", "plugins", "sample-plugin")),
    ["data.json", "main.js", "manifest.json"],
  );
  await checkProfile({ vault: fixture.vault, profile: fixture.profile });
});

test("preserves only declared mutable JSON files", async () => {
  const fixture = await createFixture({
    mutableJsonFiles: ["state.previous.json"],
  });
  const pluginRoot = join(
    fixture.vault,
    ".obsidian",
    "plugins",
    "sample-plugin",
  );
  await writeFile(join(pluginRoot, "state.previous.json"), '{"kept":true}\n');
  await applyProfile(
    { vault: fixture.vault, profile: fixture.profile },
    {
      bundles: new StaticProvider(fixture.bundle),
      installer: new CopyingInstaller(),
    },
  );
  assert.equal(
    await readFile(join(pluginRoot, "state.previous.json"), "utf8"),
    '{"kept":true}\n',
  );
  await checkProfile({ vault: fixture.vault, profile: fixture.profile });
  await writeFile(join(pluginRoot, "state.previous.json"), "not JSON\n");
  await assert.rejects(
    checkProfile({ vault: fixture.vault, profile: fixture.profile }),
    ProfileError,
  );
});

test("rejects a symlink at a declared mutable JSON file path", async () => {
  const fixture = await createFixture({
    mutableJsonFiles: ["state.previous.json"],
  });
  const external = join(
    await mkdtemp(join(tmpdir(), "external-state-")),
    "state.json",
  );
  await writeFile(external, "{}\n");
  await symlink(
    external,
    join(
      fixture.vault,
      ".obsidian",
      "plugins",
      "sample-plugin",
      "state.previous.json",
    ),
  );
  await assert.rejects(
    applyProfile(
      { vault: fixture.vault, profile: fixture.profile },
      {
        bundles: new StaticProvider(fixture.bundle),
        installer: new CopyingInstaller(),
      },
    ),
    ProfileError,
  );
});

test("omits an optional plugin only when absence is proved", async () => {
  const fixture = await createFixture({ requirement: "optional" });
  const missing: BundleProvider = {
    async obtain(): Promise<BundleAcquisition> {
      throw new BundleNotFoundError("fixture is absent");
    },
  };
  const unsupported: BundleProvider = {
    async obtain(): Promise<BundleAcquisition> {
      throw new ProviderUnsupportedError("fixture is unsupported");
    },
  };
  const receipt = await applyProfile(
    { vault: fixture.vault, profile: fixture.profile },
    { bundles: missing, installer: new CopyingInstaller() },
  );
  assert.deepEqual(receipt.omitted, [
    { id: "sample-plugin", reason: "optional-unavailable" },
  ]);
  await assert.rejects(
    applyProfile(
      { vault: fixture.vault, profile: fixture.profile },
      { bundles: unsupported, installer: new CopyingInstaller() },
    ),
    ProviderUnsupportedError,
  );
});

test("rejects a digest mismatch before replacement", async () => {
  const fixture = await createFixture({ mainDigest: "0".repeat(64) });
  const sentinel = join(
    fixture.vault,
    ".obsidian",
    "plugins",
    "sample-plugin",
    "sentinel.txt",
  );
  await writeFile(sentinel, "original\n");
  await assert.rejects(
    applyProfile(
      { vault: fixture.vault, profile: fixture.profile },
      {
        bundles: new StaticProvider(fixture.bundle),
        installer: new CopyingInstaller(),
      },
    ),
    DigestMismatchError,
  );
  assert.equal(await readFile(sentinel, "utf8"), "original\n");
});

test("validates plugin identifiers at the exported apply boundary", async () => {
  const fixture = await createFixture();
  const plugin = fixture.profile.plugins[0]!;
  const invalid = {
    ...fixture.profile,
    plugins: [{ ...plugin, id: "../../escaped" }],
  } as unknown as PluginProfile;

  await assert.rejects(
    applyProfile(
      { vault: fixture.vault, profile: invalid },
      {
        bundles: new StaticProvider(fixture.bundle),
        installer: new CopyingInstaller(),
      },
    ),
    ProfileError,
  );
  await assert.rejects(
    checkProfile({ vault: fixture.vault, profile: invalid }),
    ProfileError,
  );
});

test("rejects a second command while the vault lock is live", async () => {
  const fixture = await createFixture();
  const lock = join(fixture.vault, ".kataskeue", "vault.lock");
  await mkdir(join(fixture.vault, ".kataskeue"));
  await writeFile(
    lock,
    `${JSON.stringify({ pid: process.pid, token: "active" })}\n`,
  );
  await assert.rejects(
    applyProfile(
      { vault: fixture.vault, profile: fixture.profile },
      {
        bundles: new StaticProvider(fixture.bundle),
        installer: new CopyingInstaller(),
      },
    ),
    OperationLockedError,
  );
  await rm(lock);
});

test("does not reclaim a stale vault lock implicitly", async () => {
  const fixture = await createFixture();
  const lock = join(fixture.vault, ".kataskeue", "vault.lock");
  await mkdir(join(fixture.vault, ".kataskeue"));
  await writeFile(
    lock,
    `${JSON.stringify({ pid: 2_147_483_647, token: "stale" })}\n`,
  );
  await assert.rejects(
    applyProfile(
      { vault: fixture.vault, profile: fixture.profile },
      {
        bundles: new StaticProvider(fixture.bundle),
        installer: new CopyingInstaller(),
      },
    ),
    OperationLockedError,
  );
  await rm(lock);
});

test("honours a vault lock left at its former place", async () => {
  const fixture = await createFixture();
  const lock = join(fixture.vault, ".kataskeue.lock");
  await writeFile(
    lock,
    `${JSON.stringify({ pid: process.pid, token: "former" })}\n`,
  );
  for (const run of [
    () =>
      applyProfile(
        { vault: fixture.vault, profile: fixture.profile },
        {
          bundles: new StaticProvider(fixture.bundle),
          installer: new CopyingInstaller(),
        },
      ),
    () => checkProfile({ vault: fixture.vault, profile: fixture.profile }),
  ]) {
    await assert.rejects(run(), (error: unknown) => {
      assert.ok(error instanceof OperationLockedError);
      assert.ok(error.message.includes(lock));
      return true;
    });
  }
  assert.deepEqual(await readdir(join(fixture.vault, ".kataskeue")), []);
  await rm(lock);
});

/** Apply the fixture profile and record the state places seen during the replacement. */
async function applyObservingState(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  stateDir?: string,
): Promise<{ lock: boolean; journal: boolean; destinations: string[] }> {
  const state = stateDir ?? join(fixture.vault, ".kataskeue");
  const seen = { lock: false, journal: false, destinations: [] as string[] };
  await applyProfile(
    {
      vault: fixture.vault,
      profile: fixture.profile,
      ...(stateDir === undefined ? {} : { stateDir }),
    },
    {
      bundles: new StaticProvider(fixture.bundle),
      installer: new CopyingInstaller(),
      replacements: {
        async move(source: string, destination: string): Promise<void> {
          seen.lock ||= await present(join(state, "vault.lock"));
          seen.journal ||= await present(join(state, "transaction.json"));
          seen.destinations.push(destination);
          await rename(source, destination);
        },
      },
    },
  );
  return seen;
}

async function present(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test("keeps the lock, the journal and the transaction roots in .kataskeue/", async () => {
  const fixture = await createFixture();
  const seen = await applyObservingState(fixture);
  assert.equal(seen.lock, true);
  assert.equal(seen.journal, true);
  const backup = seen.destinations[0] ?? "";
  assert.ok(
    backup.startsWith(join(fixture.vault, ".kataskeue", "transaction-")),
    backup,
  );
  assert.deepEqual(await readdir(join(fixture.vault, ".kataskeue")), []);
  assert.deepEqual(
    (await readdir(fixture.vault)).filter((name) =>
      name.startsWith(".kataskeue"),
    ),
    [".kataskeue"],
  );
});

test("places the state folder where the option names it", async () => {
  const fixture = await createFixture();
  const state = join(fixture.vault, "var", "kataskeue");
  const seen = await applyObservingState(fixture, state);
  assert.equal(seen.lock, true);
  assert.equal(seen.journal, true);
  const backup = seen.destinations[0] ?? "";
  assert.ok(backup.startsWith(join(state, "transaction-")), backup);
  assert.deepEqual(await readdir(state), []);
  assert.equal(await present(join(fixture.vault, ".kataskeue")), false);
});

test("rejects a state folder that a rename into .obsidian cannot reach", async () => {
  const fixture = await createFixture();
  const run = (stateDir: string) =>
    applyProfile(
      { vault: fixture.vault, profile: fixture.profile, stateDir },
      {
        bundles: new StaticProvider(fixture.bundle),
        installer: new CopyingInstaller(),
      },
    );
  const elsewhere = join("/dev", "kataskeue-state-test");
  await assert.rejects(run(elsewhere), /file system of the vault/);
  await assert.rejects(run(elsewhere), StateFolderError);
  assert.equal(await present(elsewhere), false);
  await assert.rejects(
    run(join(fixture.vault, ".obsidian", "state")),
    StateFolderError,
  );
  await assert.rejects(run(fixture.vault), StateFolderError);
  assert.equal(await present(join(fixture.vault, ".obsidian", "state")), false);
});

test("rolls back a replacement failure", async () => {
  const fixture = await createFixture();
  const sentinel = join(
    fixture.vault,
    ".obsidian",
    "plugins",
    "sample-plugin",
    "sentinel.txt",
  );
  await writeFile(sentinel, "original\n");
  let moves = 0;
  await assert.rejects(
    applyProfile(
      { vault: fixture.vault, profile: fixture.profile },
      {
        bundles: new StaticProvider(fixture.bundle),
        installer: new CopyingInstaller(),
        replacements: {
          async move(source: string, destination: string): Promise<void> {
            moves += 1;
            if (moves === 5) throw new Error("planted interruption");
            await rename(source, destination);
          },
        },
      },
    ),
    ReplacementError,
  );
  assert.equal(await readFile(sentinel, "utf8"), "original\n");
});

/** Leave the state of a replacement interrupted after its backup, with its journal at `journal`. */
async function interruptReplacement(
  vault: string,
  transaction: string,
  journal: string,
): Promise<void> {
  const backup = join(transaction, "backup");
  await mkdir(backup, { recursive: true });
  for (const name of [
    "plugins",
    "community-plugins.json",
    "plugin-installation.json",
  ]) {
    await rename(join(vault, ".obsidian", name), join(backup, name));
  }
  await mkdir(join(vault, ".obsidian", "plugins"));
  await writeFile(join(vault, ".obsidian", "community-plugins.json"), "[]\n");
  await writeFile(join(vault, ".obsidian", "plugin-installation.json"), "{}\n");
  await writeFile(
    journal,
    `${JSON.stringify({
      _schema: "kataskeue:transaction@1",
      transaction_root: transaction,
      target_obsidian: join(vault, ".obsidian"),
      phase: "replacing",
      original: {
        plugins: true,
        "community-plugins.json": true,
        "plugin-installation.json": true,
      },
    })}\n`,
  );
}

test("recovers a durable journal after process interruption", async () => {
  const fixture = await createFixture();
  const state = join(fixture.vault, ".kataskeue");
  await interruptReplacement(
    fixture.vault,
    join(state, "transaction-crash"),
    join(state, "transaction.json"),
  );
  assert.equal(await recoverIncompleteTransaction(fixture.vault), true);
  assert.deepEqual(await readdir(join(fixture.vault, ".obsidian", "plugins")), [
    "sample-plugin",
  ]);
  assert.deepEqual(await readdir(state), []);
});

test("recovers a journal left at its former place before applying", async () => {
  const fixture = await createFixture();
  const journal = join(fixture.vault, ".kataskeue-transaction.json");
  const transaction = join(fixture.vault, ".kataskeue-crash");
  await writeFile(
    join(fixture.vault, ".obsidian", "plugins", "sample-plugin", "kept.txt"),
    "original\n",
  );
  await interruptReplacement(fixture.vault, transaction, journal);
  const kept = join(
    fixture.vault,
    ".obsidian",
    "plugins",
    "sample-plugin",
    "kept.txt",
  );
  let restoredBeforeReplacement: boolean | undefined;
  await applyProfile(
    { vault: fixture.vault, profile: fixture.profile },
    {
      bundles: new StaticProvider(fixture.bundle),
      installer: new CopyingInstaller(),
      replacements: {
        async move(source: string, destination: string): Promise<void> {
          restoredBeforeReplacement ??=
            (await present(kept)) && !(await present(journal));
          await rename(source, destination);
        },
      },
    },
  );
  assert.equal(restoredBeforeReplacement, true);
  assert.equal(await present(transaction), false);
});

test("keeps canonical and override checks distinct", async () => {
  const fixture = await createFixture();
  const override = await createBundle("export const development = true;\n");
  const receipt = await applyProfile(
    {
      vault: fixture.vault,
      profile: fixture.profile,
      localOverrides: { "sample-plugin": { path: override } },
    },
    {
      bundles: new FailingProvider(),
      installer: new CopyingInstaller(),
      overrideInspector: cleanOverride,
    },
  );
  assert.deepEqual(receipt.plugins[0]?.override, {
    path: override,
    commit: "a".repeat(40),
    dirty: false,
  });
  await assert.rejects(
    checkProfile({ vault: fixture.vault, profile: fixture.profile }),
    DriftError,
  );
  await checkProfile(
    {
      vault: fixture.vault,
      profile: fixture.profile,
      localOverrides: { "sample-plugin": { path: override } },
    },
    { overrideInspector: cleanOverride },
  );
  await writeFile(join(override, "main.js"), "export const changed = true;\n");
  await assert.rejects(
    checkProfile(
      {
        vault: fixture.vault,
        profile: fixture.profile,
        localOverrides: { "sample-plugin": { path: override } },
      },
      { overrideInspector: cleanOverride },
    ),
    DriftError,
  );
});

test("derives membership from the profile rather than a mutable receipt", async () => {
  const fixture = await createFixture();
  await applyProfile(
    { vault: fixture.vault, profile: fixture.profile },
    {
      bundles: new StaticProvider(fixture.bundle),
      installer: new CopyingInstaller(),
    },
  );
  const receiptPath = join(
    fixture.vault,
    ".obsidian",
    "plugin-installation.json",
  );
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
    plugins: unknown[];
  };
  receipt.plugins = [];
  await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
  await rm(join(fixture.vault, ".obsidian", "plugins", "sample-plugin"), {
    recursive: true,
  });
  await assert.rejects(
    checkProfile({ vault: fixture.vault, profile: fixture.profile }),
    DriftError,
  );
});

test("parses receipt versions and verifies canonical source kinds", async () => {
  const fixture = await createFixture();
  await applyProfile(
    { vault: fixture.vault, profile: fixture.profile },
    {
      bundles: new StaticProvider(fixture.bundle),
      installer: new CopyingInstaller(),
    },
  );
  const receiptPath = join(
    fixture.vault,
    ".obsidian",
    "plugin-installation.json",
  );
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
    _schema: string;
    plugins: Array<{ source: string }>;
  };
  assert.equal(Object.keys(receipt)[0], "_schema");
  assert.equal(receipt._schema, "kataskeue:receipt@2");
  receipt._schema = "kataskeue:receipt@1";
  await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
  await assert.rejects(
    checkProfile({ vault: fixture.vault, profile: fixture.profile }),
    FileFormatError,
  );
  receipt._schema = "kataskeue:receipt@2";
  receipt.plugins[0]!.source = "artifact";
  await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
  await assert.rejects(
    checkProfile({ vault: fixture.vault, profile: fixture.profile }),
    DriftError,
  );
});

test("requires artifact evidence matching the canonical record", async () => {
  const fixture = await createFixture({
    bundle: {
      kind: "artifact",
      locator: "artifacts/sample.zip",
      source_commit: "b".repeat(40),
      sha256: "c".repeat(64),
    },
  });
  const wrongEvidence: BundleProvider = {
    async obtain(): Promise<BundleAcquisition> {
      return {
        directory: fixture.bundle,
        source: "artifact",
        artifact: {
          locator: "artifacts/sample.zip",
          source_commit: "d".repeat(40),
          sha256: "c".repeat(64),
        },
      };
    },
  };
  await assert.rejects(
    applyProfile(
      { vault: fixture.vault, profile: fixture.profile },
      { bundles: wrongEvidence, installer: new CopyingInstaller() },
    ),
    DigestMismatchError,
  );
});

test("records and verifies losslessly projected settings", async () => {
  const fixture = await createFixture({
    settings: {
      policy: "losslessly-projected",
      source: "settings/sample.yml",
      adapter: "sample",
    },
  });
  await mkdir(join(fixture.vault, "settings"));
  await writeFile(join(fixture.vault, "settings", "sample.yml"), "value: 1\n");
  const adapter: SettingsAdapter = {
    supports: () => true,
    async project(source, destination) {
      await writeFile(
        destination,
        JSON.stringify({ source: await readFile(source, "utf8") }),
      );
    },
  };
  const receipt = await applyProfile(
    { vault: fixture.vault, profile: fixture.profile },
    {
      bundles: new StaticProvider(fixture.bundle),
      installer: new CopyingInstaller(),
      settingsAdapters: { sample: adapter },
    },
  );
  assert.equal(receipt.plugins[0]?.settings?.source_mode, "canonical");
  await writeFile(join(fixture.vault, "settings", "sample.yml"), "value: 2\n");
  await assert.rejects(
    checkProfile(
      { vault: fixture.vault, profile: fixture.profile },
      { settingsAdapters: { sample: adapter } },
    ),
    DriftError,
  );
});

test("uses complete local settings sources and records their mode", async () => {
  const fixture = await createFixture({
    settings: {
      policy: "losslessly-projected",
      source: "settings/sample.yml",
      adapter: "sample",
    },
  });
  await mkdir(join(fixture.vault, "settings"));
  await writeFile(join(fixture.vault, "settings", "sample.yml"), "value: 1\n");
  await writeFile(
    join(fixture.vault, "settings", "sample.local.yml"),
    "value: 1\n",
  );
  const localSettingsSources = {
    "sample-plugin": { source: "settings/sample.local.yml" },
  };
  const adapter: SettingsAdapter = {
    supports: () => true,
    async project(source, destination) {
      await writeFile(destination, await readFile(source, "utf8"));
    },
  };
  const dependencies = {
    bundles: new StaticProvider(fixture.bundle),
    installer: new CopyingInstaller(),
    settingsAdapters: { sample: adapter },
  };
  const receipt = await applyProfile(
    {
      vault: fixture.vault,
      profile: fixture.profile,
      localSettingsSources,
    },
    dependencies,
  );
  assert.equal(receipt.plugins[0]?.settings?.source_mode, "local");
  await checkProfile(
    {
      vault: fixture.vault,
      profile: fixture.profile,
      localSettingsSources,
    },
    { settingsAdapters: { sample: adapter } },
  );
  await assert.rejects(
    checkProfile(
      { vault: fixture.vault, profile: fixture.profile },
      { settingsAdapters: { sample: adapter } },
    ),
    DriftError,
  );
  await assert.rejects(
    checkProfile(
      {
        vault: fixture.vault,
        profile: fixture.profile,
        localSettingsSources,
        delivery: true,
      },
      { settingsAdapters: { sample: adapter } },
    ),
    ProfileError,
  );
  await assert.rejects(
    applyProfile(
      {
        vault: fixture.vault,
        profile: fixture.profile,
        localSettingsSources,
        delivery: true,
      },
      dependencies,
    ),
    ProfileError,
  );
});

test("reprojects settings while checking dependent inputs", async () => {
  const fixture = await createFixture({
    settings: {
      policy: "losslessly-projected",
      source: "settings/sample.yml",
      adapter: "sample",
    },
  });
  const recordRoot = join(fixture.vault, "config", "obsidian");
  await mkdir(join(recordRoot, "settings"), { recursive: true });
  await writeFile(join(recordRoot, "settings", "sample.yml"), "value: 1\n");
  const inventory = join(fixture.vault, "inventory.txt");
  await writeFile(inventory, "first\n");
  const adapter: SettingsAdapter = {
    supports: () => true,
    async project(source, destination, context) {
      await writeFile(
        destination,
        `${await readFile(source, "utf8")}${await readFile(join(context.consumerRoot, "inventory.txt"), "utf8")}`,
      );
    },
  };
  await applyProfile(
    { vault: fixture.vault, root: recordRoot, profile: fixture.profile },
    {
      bundles: new StaticProvider(fixture.bundle),
      installer: new CopyingInstaller(),
      settingsAdapters: { sample: adapter },
    },
  );
  await writeFile(inventory, "second\n");
  await assert.rejects(
    checkProfile(
      { vault: fixture.vault, root: recordRoot, profile: fixture.profile },
      { settingsAdapters: { sample: adapter } },
    ),
    DriftError,
  );
});

test("reads a tool configuration file at the one place that the conventions fix", async () => {
  const fixture = await createFixture({
    settings: { policy: "losslessly-projected", adapter: "sample" },
  });
  const adapter: SettingsAdapter = {
    toolSettingsFile: "sample.yml",
    supports: () => true,
    async project(source, destination) {
      await writeFile(destination, await readFile(source, "utf8"));
    },
  };
  const dependencies = {
    bundles: new StaticProvider(fixture.bundle),
    installer: new CopyingInstaller(),
    settingsAdapters: { sample: adapter },
  };
  const options = { vault: fixture.vault, profile: fixture.profile };
  const nested = join(fixture.vault, "config", "tools", "sample.yml");
  const flat = join(fixture.vault, "sample.yml");

  await assert.rejects(applyProfile(options, dependencies), (error: Error) => {
    assert.ok(error instanceof ProfileError);
    assert.match(error.message, /looked for .*config\/tools\/sample\.yml/);
    return true;
  });

  await mkdir(join(fixture.vault, "config", "tools"), { recursive: true });
  await writeFile(nested, "value: 1\n");
  await applyProfile(options, dependencies);
  assert.equal(
    await readFile(
      join(fixture.vault, ".obsidian", "plugins", "sample-plugin", "data.json"),
      "utf8",
    ),
    "value: 1\n",
  );
  await checkProfile(options, { settingsAdapters: { sample: adapter } });

  await writeFile(flat, "value: 1\n");
  await assert.rejects(
    checkProfile(options, { settingsAdapters: { sample: adapter } }),
    (error: Error) => {
      assert.ok(error instanceof ProfileError);
      assert.ok(error.message.includes(nested) && error.message.includes(flat));
      return true;
    },
  );

  await rm(nested);
  await checkProfile(options, { settingsAdapters: { sample: adapter } });
});

test("pairs a declared settings source only with an adapter without a tool file", async () => {
  const declared = await createFixture({
    settings: {
      policy: "losslessly-projected",
      source: "sample.yml",
      adapter: "sample",
    },
  });
  await writeFile(join(declared.vault, "sample.yml"), "value: 1\n");
  const toolAdapter: SettingsAdapter = {
    toolSettingsFile: "sample.yml",
    supports: () => true,
    async project() {
      assert.fail("a rejected pairing must not project settings");
    },
  };
  await assert.rejects(
    applyProfile(
      { vault: declared.vault, profile: declared.profile },
      {
        bundles: new StaticProvider(declared.bundle),
        installer: new CopyingInstaller(),
        settingsAdapters: { sample: toolAdapter },
      },
    ),
    /remove settings\.source/,
  );

  const undeclared = await createFixture({
    settings: { policy: "losslessly-projected", adapter: "sample" },
  });
  const plainAdapter: SettingsAdapter = {
    supports: () => true,
    async project() {
      assert.fail("a rejected pairing must not project settings");
    },
  };
  await assert.rejects(
    applyProfile(
      { vault: undeclared.vault, profile: undeclared.profile },
      {
        bundles: new StaticProvider(undeclared.bundle),
        installer: new CopyingInstaller(),
        settingsAdapters: { sample: plainAdapter },
      },
    ),
    /require settings\.source/,
  );
});

test("rejects an incompatible settings adapter before projection", async () => {
  const fixture = await createFixture({
    settings: {
      policy: "losslessly-projected",
      source: "settings/sample.yml",
      adapter: "sample",
    },
  });
  await mkdir(join(fixture.vault, "settings"));
  await writeFile(join(fixture.vault, "settings", "sample.yml"), "value: 1\n");
  const adapter: SettingsAdapter = {
    supports: () => false,
    async project() {
      assert.fail("an incompatible adapter must not project settings");
    },
  };
  await assert.rejects(
    applyProfile(
      { vault: fixture.vault, profile: fixture.profile },
      {
        bundles: new StaticProvider(fixture.bundle),
        installer: new CopyingInstaller(),
        settingsAdapters: { sample: adapter },
      },
    ),
    ProfileError,
  );
});

test("requires project-owned settings and excludes native data", async () => {
  const fixture = await createFixture({
    settings: { policy: "project-owned", source: "settings/sample.yml" },
  });
  await assert.rejects(
    applyProfile(
      { vault: fixture.vault, profile: fixture.profile },
      {
        bundles: new StaticProvider(fixture.bundle),
        installer: new CopyingInstaller(),
      },
    ),
    ProfileError,
  );
});

test("rejects a settings symlink whose target leaves the settings-source root", async () => {
  const fixture = await createFixture({
    settings: { policy: "project-owned", source: "settings/sample.yml" },
  });
  const outside = join(
    await mkdtemp(join(tmpdir(), "outside-settings-")),
    "sample.yml",
  );
  await writeFile(outside, "value: external\n");
  await mkdir(join(fixture.vault, "settings"));
  await symlink(outside, join(fixture.vault, "settings", "sample.yml"));

  await assert.rejects(
    applyProfile(
      { vault: fixture.vault, profile: fixture.profile },
      {
        bundles: new StaticProvider(fixture.bundle),
        installer: new CopyingInstaller(),
      },
    ),
    ProfileError,
  );
});

test("rejects symlinked runtime files before replacement", async () => {
  const fixture = await createFixture();
  const external = join(
    await mkdtemp(join(tmpdir(), "external-runtime-")),
    "main.js",
  );
  await writeFile(external, main);
  await rm(join(fixture.bundle, "main.js"));
  await symlink(external, join(fixture.bundle, "main.js"));

  await assert.rejects(
    applyProfile(
      { vault: fixture.vault, profile: fixture.profile },
      {
        bundles: new StaticProvider(fixture.bundle),
        installer: new CopyingInstaller(),
      },
    ),
    ProfileError,
  );
});

test("locates each drift at the step that detected it", async () => {
  const fixture = await createFixture({
    mutableJsonFiles: ["state.previous.json"],
  });
  await applyProfile(
    { vault: fixture.vault, profile: fixture.profile },
    {
      bundles: new StaticProvider(fixture.bundle),
      installer: new CopyingInstaller(),
    },
  );
  const obsidian = join(fixture.vault, ".obsidian");
  const receiptPath = join(obsidian, "plugin-installation.json");
  const pluginRoot = join(obsidian, "plugins", "sample-plugin");
  const observe = async (): Promise<CheckOutcome> => {
    const cursor = new CheckCursor();
    return observeCheck(
      () =>
        checkProfile(
          { vault: fixture.vault, profile: fixture.profile },
          { cursor },
        ),
      cursor,
    );
  };
  const located = (outcome: CheckOutcome) =>
    outcome.kind === "drift"
      ? [outcome.step.rule, outcome.step.path, outcome.step.locus]
      : outcome.kind;

  assert.deepEqual(await observe(), { kind: "complete" });

  const receiptText = await readFile(receiptPath, "utf8");
  await rm(receiptPath);
  assert.deepEqual(located(await observe()), [
    "receipt/absent",
    receiptPath,
    "",
  ]);
  await writeFile(receiptPath, "not JSON\n");
  assert.deepEqual(located(await observe()), [
    "receipt/invalid",
    receiptPath,
    "",
  ]);
  const receipt = JSON.parse(receiptText) as Record<string, unknown>;
  await writeFile(
    receiptPath,
    `${JSON.stringify({ ...receipt, profile_digest: "0".repeat(64) })}\n`,
  );
  assert.deepEqual(located(await observe()), [
    "receipt/profile",
    receiptPath,
    "/profile_digest",
  ]);
  await writeFile(receiptPath, receiptText);

  await writeFile(join(pluginRoot, "main.js"), "export const drifted = 1;\n");
  const drift = await observe();
  assert.deepEqual(located(drift), ["plugin/files", pluginRoot, ""]);
  assert.equal(drift.kind === "drift" && drift.step.folder, true);
  await writeFile(join(pluginRoot, "main.js"), main);

  await writeFile(join(pluginRoot, "notes.txt"), "stray\n");
  assert.deepEqual(located(await observe()), [
    "plugin/undeclared-files",
    pluginRoot,
    "",
  ]);
  await rm(join(pluginRoot, "notes.txt"));

  const statePath = join(pluginRoot, "state.previous.json");
  await writeFile(statePath, "not JSON\n");
  assert.deepEqual(located(await observe()), [
    "plugin/mutable-json",
    statePath,
    "",
  ]);
});

test("reports a failure before the first step as a failed check", async () => {
  const fixture = await createFixture();
  const cursor = new CheckCursor();
  const invalid = {
    ...fixture.profile,
    _schema: "kataskeue:obsidian-plugins@99",
  } as unknown as PluginProfile;
  const outcome = await observeCheck(
    () => checkProfile({ vault: fixture.vault, profile: invalid }, { cursor }),
    cursor,
  );
  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.kind === "failed" && outcome.started, false);
});

class StaticProvider implements BundleProvider {
  constructor(private readonly bundle: string) {}
  async obtain(): Promise<BundleAcquisition> {
    return { directory: this.bundle, source: "release" };
  }
}

class FailingProvider implements BundleProvider {
  async obtain(): Promise<BundleAcquisition> {
    throw new Error("provider must not run");
  }
}

class CopyingInstaller implements PluginInstaller {
  async install(
    vault: string,
    plugins: readonly InstallablePlugin[],
  ): Promise<void> {
    const obsidian = join(vault, ".obsidian");
    await mkdir(join(obsidian, "plugins"), { recursive: true });
    const enabled: string[] = [];
    for (const plugin of plugins) {
      const parsed = JSON.parse(
        await readFile(join(plugin.path, "manifest.json"), "utf8"),
      ) as {
        id: string;
      };
      const destination = join(obsidian, "plugins", parsed.id);
      await cp(plugin.path, destination, { recursive: true });
      await writeFile(join(destination, ".hotreload"), "");
      await writeFile(
        join(destination, "undeclared.txt"),
        "launcher residue\n",
      );
      if (plugin.enabled) enabled.push(parsed.id);
    }
    await writeFile(
      join(obsidian, "community-plugins.json"),
      `${JSON.stringify(enabled)}\n`,
    );
  }
}

interface FixtureOptions {
  readonly requirement?: "required" | "optional";
  readonly mainDigest?: string;
  readonly bundle?: PluginRecord["bundle"];
  readonly settings?: PluginRecord["settings"];
  readonly mutableJsonFiles?: readonly string[];
}

async function createFixture(options: FixtureOptions = {}): Promise<{
  readonly vault: string;
  readonly bundle: string;
  readonly profile: PluginProfile;
}> {
  const vault = await mkdtemp(join(tmpdir(), "obsidian-plugin-vault-"));
  await mkdir(join(vault, ".obsidian", "plugins", "sample-plugin"), {
    recursive: true,
  });
  await writeFile(join(vault, ".obsidian", "community-plugins.json"), "[]\n");
  await writeFile(join(vault, ".obsidian", "plugin-installation.json"), "{}\n");
  const bundle = await createBundle(main);
  const requirement = options.requirement ?? "required";
  const profile = parseProfile({
    _schema: "kataskeue:obsidian-plugins@1",
    runtime: {
      minimum_obsidian: "1.0.0",
      checked_obsidian: "1.14.5",
      checked_installer: "1.14.5",
    },
    plugins: [
      {
        id: "sample-plugin",
        repository: "https://github.com/example/sample-plugin",
        requirement,
        enabled: requirement === "required",
        bundle: options.bundle ?? { kind: "release", tag: "1.0.0" },
        files: {
          "manifest.json": digest(manifest),
          "main.js": options.mainDigest ?? digest(main),
        },
        ...(options.mutableJsonFiles === undefined
          ? {}
          : { mutable_json_files: options.mutableJsonFiles }),
        settings: options.settings ?? { policy: "native-portable" },
      },
    ],
  });
  return { vault, bundle, profile };
}

async function createBundle(mainContents: string): Promise<string> {
  const bundle = await mkdtemp(join(tmpdir(), "obsidian-plugin-bundle-"));
  await writeFile(join(bundle, "manifest.json"), manifest);
  await writeFile(join(bundle, "main.js"), mainContents);
  return bundle;
}

function digest(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}
