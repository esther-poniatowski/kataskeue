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
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyProfile, checkProfile } from "../src/application/materializer.js";
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
  OperationLockedError,
  ProfileError,
  ProviderUnsupportedError,
  ReplacementError,
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
  const lock = join(fixture.vault, ".obsidian-plugin-materializer.lock");
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
  const lock = join(fixture.vault, ".obsidian-plugin-materializer.lock");
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

test("recovers a durable journal after process interruption", async () => {
  const fixture = await createFixture();
  const transaction = join(
    fixture.vault,
    ".obsidian-plugin-materializer-crash",
  );
  const backup = join(transaction, "backup");
  await mkdir(backup, { recursive: true });
  for (const name of [
    "plugins",
    "community-plugins.json",
    "plugin-installation.json",
  ]) {
    await rename(join(fixture.vault, ".obsidian", name), join(backup, name));
  }
  await mkdir(join(fixture.vault, ".obsidian", "plugins"));
  await writeFile(
    join(fixture.vault, ".obsidian", "community-plugins.json"),
    "[]\n",
  );
  await writeFile(
    join(fixture.vault, ".obsidian", "plugin-installation.json"),
    "{}\n",
  );
  await writeFile(
    join(fixture.vault, ".obsidian-plugin-materializer-transaction.json"),
    `${JSON.stringify({
      format_version: 1,
      transaction_root: transaction,
      target_obsidian: join(fixture.vault, ".obsidian"),
      phase: "replacing",
      original: {
        plugins: true,
        "community-plugins.json": true,
        "plugin-installation.json": true,
      },
    })}\n`,
  );
  assert.equal(await recoverIncompleteTransaction(fixture.vault), true);
  assert.deepEqual(await readdir(join(fixture.vault, ".obsidian", "plugins")), [
    "sample-plugin",
  ]);
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
    format_version: number;
    plugins: Array<{ source: string }>;
  };
  receipt.format_version = 2;
  await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
  await assert.rejects(
    checkProfile({ vault: fixture.vault, profile: fixture.profile }),
    DriftError,
  );
  receipt.format_version = 1;
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
  await applyProfile(
    { vault: fixture.vault, profile: fixture.profile },
    {
      bundles: new StaticProvider(fixture.bundle),
      installer: new CopyingInstaller(),
      settingsAdapters: { sample: adapter },
    },
  );
  await writeFile(join(fixture.vault, "settings", "sample.yml"), "value: 2\n");
  await assert.rejects(
    checkProfile({ vault: fixture.vault, profile: fixture.profile }),
    DriftError,
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

test("rejects a settings symlink whose target leaves the consumer root", async () => {
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
    format_version: 1,
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
