import assert from "node:assert/strict";
import test from "node:test";

import { parseProfile } from "../src/domain/profile.js";
import { BundleFetchError, ProviderUnsupportedError } from "../src/errors.js";
import { LauncherBundleProvider } from "../src/infrastructure/launcherBundleProvider.js";
import { ObsidianLauncherInstaller } from "../src/infrastructure/obsidianLauncherInstaller.js";

const digest = "a".repeat(64);
const release = parseProfile({
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
      requirement: "required",
      enabled: false,
      bundle: { kind: "release", tag: "1.0.0" },
      files: { "manifest.json": digest, "main.js": digest },
      settings: { policy: "machine-local" },
    },
  ],
}).plugins[0]!;

test("passes exact release coordinates to obsidian-launcher", async () => {
  let observed: unknown;
  const provider = new LauncherBundleProvider({
    async downloadPlugins(plugins) {
      observed = plugins;
      return [
        {
          enabled: false,
          path: "/cache/sample-plugin",
          id: "sample-plugin",
          originalType: "github",
        },
      ];
    },
  });
  assert.deepEqual(await provider.obtain(release, "/tmp/download"), {
    directory: "/cache/sample-plugin",
    source: "release",
  });
  assert.deepEqual(observed, [
    { repo: "example/sample-plugin", version: "1.0.0", enabled: false },
  ]);
});

test("does not report launcher failures as proved absence", async () => {
  const provider = new LauncherBundleProvider({
    async downloadPlugins() {
      throw new Error("authentication failed");
    },
  });
  await assert.rejects(
    provider.obtain(release, "/tmp/download"),
    BundleFetchError,
  );
});

test("rejects source kinds outside the launcher adapter", async () => {
  const artifact = {
    ...release,
    bundle: {
      kind: "artifact" as const,
      locator: "artifact.zip",
      source_commit: "b".repeat(40),
      sha256: "c".repeat(64),
    },
  };
  const provider = new LauncherBundleProvider({
    async downloadPlugins() {
      return [];
    },
  });
  await assert.rejects(
    provider.obtain(artifact, "/tmp/download"),
    ProviderUnsupportedError,
  );
});

test("passes prepared local bundles to the launcher installer", async () => {
  let observed: unknown;
  const installer = new ObsidianLauncherInstaller({
    async installPlugins(vault, plugins) {
      observed = { vault, plugins };
    },
  });
  await installer.install("/vault", [{ path: "/bundle", enabled: true }]);
  assert.deepEqual(observed, {
    vault: "/vault",
    plugins: [{ path: "/bundle", enabled: true }],
  });
});
