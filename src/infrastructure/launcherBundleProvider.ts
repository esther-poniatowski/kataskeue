import { mkdir } from "node:fs/promises";

import type { DownloadedPluginEntry, PluginEntry } from "obsidian-launcher";

import { BundleFetchError, ProviderUnsupportedError } from "../errors.js";
import type { BundleAcquisition, BundleProvider } from "../ports.js";
import type { PluginRecord } from "../domain/profile.js";

/** Obtains public GitHub releases through the qualified obsidian-launcher API. */
export class LauncherBundleProvider implements BundleProvider {
  readonly #launcher: {
    downloadPlugins(plugins: PluginEntry[]): Promise<DownloadedPluginEntry[]>;
  };

  constructor(launcher: {
    downloadPlugins(plugins: PluginEntry[]): Promise<DownloadedPluginEntry[]>;
  }) {
    this.#launcher = launcher;
  }

  async obtain(
    plugin: PluginRecord,
    destination: string,
  ): Promise<BundleAcquisition> {
    if (plugin.bundle.kind !== "release") {
      throw new ProviderUnsupportedError(
        `artifact provider is not configured for ${plugin.id}`,
      );
    }
    const repository = githubRepository(plugin.repository);
    await mkdir(destination, { recursive: true });
    try {
      const [downloaded] = await this.#launcher.downloadPlugins([
        {
          repo: repository,
          version: plugin.bundle.tag,
          enabled: plugin.enabled,
        },
      ]);
      if (downloaded === undefined) {
        throw new Error("launcher returned no bundle");
      }
      return { directory: downloaded.path, source: "release" };
    } catch (cause) {
      throw new BundleFetchError(
        `release ${plugin.bundle.tag} could not be fetched for ${plugin.id}: ${String(cause)}`,
      );
    }
  }
}

function githubRepository(repository: string): string {
  const url = new URL(repository);
  if (url.hostname !== "github.com") {
    throw new ProviderUnsupportedError(
      `launcher supports only GitHub releases: ${repository}`,
    );
  }
  const parts = url.pathname
    .replace(/^\//, "")
    .replace(/\.git$/, "")
    .split("/");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new ProviderUnsupportedError(
      `invalid GitHub repository URL: ${repository}`,
    );
  }
  return parts.join("/");
}
