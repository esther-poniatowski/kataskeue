import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

import { sha256 } from "../domain/digests.js";
import {
  parseLocalOverrides,
  parseProfile,
  type LocalOverrides,
  type PluginProfile,
  type PluginRecord,
  type RuntimeFileName,
  type RuntimeFiles,
} from "../domain/profile.js";
import {
  parseLocalSettingsSources,
  type LocalSettingsSources,
} from "../domain/localSettingsSources.js";
import {
  BundleNotFoundError,
  DigestMismatchError,
  DriftError,
  ProfileError,
} from "../errors.js";
import type {
  BundleAcquisition,
  BundleProvider,
  OverrideInspector,
  OverrideState,
  PluginInstaller,
  ReplaceOperations,
  SettingsAdapter,
} from "../ports.js";
import type {
  InstallationReceipt,
  OmittedPlugin,
  ReceiptPlugin,
  ReceiptSettings,
} from "./receipt.js";
import { parseInstallationReceipt } from "./receipt.js";
import {
  CheckCursor,
  fileStep,
  folderStep,
  type CheckRuleId,
} from "./checkSteps.js";
import { withVaultLock } from "./lock.js";
import {
  recoverIncompleteTransaction,
  replaceManagedState,
  type ManagedStateTransaction,
} from "./transaction.js";

export interface MaterializerDependencies {
  readonly bundles: BundleProvider;
  readonly installer: PluginInstaller;
  readonly overrideInspector?: OverrideInspector;
  readonly settingsAdapters?: Readonly<Record<string, SettingsAdapter>>;
  readonly replacements?: ReplaceOperations;
}

export interface ApplyOptions {
  readonly vault: string;
  readonly root?: string;
  readonly profile: PluginProfile;
  readonly localOverrides?: LocalOverrides;
  readonly localSettingsSources?: LocalSettingsSources;
  readonly delivery?: boolean;
}

export interface CheckOptions {
  readonly vault: string;
  readonly root?: string;
  readonly profile: PluginProfile;
  readonly localOverrides?: LocalOverrides;
  readonly localSettingsSources?: LocalSettingsSources;
  readonly delivery?: boolean;
}

interface SelectedSettingsSource {
  readonly path: string;
  readonly mode: "canonical" | "local";
}

interface PreparedPlugin {
  readonly record: PluginRecord;
  readonly bundlePath: string;
  readonly source: ReceiptPlugin["source"];
  readonly override?: OverrideState & { readonly path: string };
}

/** Build, verify, and recoverably replace the complete native community-plugin state. */
export async function applyProfile(
  options: ApplyOptions,
  dependencies: MaterializerDependencies,
): Promise<InstallationReceipt> {
  const vault = resolve(options.vault);
  const profile = parseProfile(options.profile);
  const localOverrides = parseLocalOverrides(
    options.localOverrides ?? {},
    profile,
  );
  const localSettingsSources = parseLocalSettingsSources(
    options.localSettingsSources ?? {},
    profile,
  );
  rejectLocalSourcesInDelivery(
    options.delivery,
    localOverrides,
    localSettingsSources,
  );
  return withVaultLock(vault, () =>
    applyProfileLocked(
      {
        ...options,
        vault,
        profile,
        localOverrides,
        localSettingsSources,
      },
      dependencies,
    ),
  );
}

async function applyProfileLocked(
  options: ApplyOptions,
  dependencies: MaterializerDependencies,
): Promise<InstallationReceipt> {
  const vault = resolve(options.vault);
  const root = resolve(options.root ?? vault);
  const overrides = options.localOverrides ?? {};
  const localSettingsSources = options.localSettingsSources ?? {};
  await recoverIncompleteTransaction(vault);

  const targetObsidian = join(vault, ".obsidian");
  const transactionRoot = await mkdtemp(join(vault, ".kataskeue-"));
  const stageVault = join(transactionRoot, "vault");
  const stagedObsidian = join(stageVault, ".obsidian");
  const downloadRoot = join(transactionRoot, "bundles");
  const prepared: PreparedPlugin[] = [];
  const omitted: OmittedPlugin[] = [];
  let transaction: ManagedStateTransaction | undefined;

  try {
    await mkdir(downloadRoot, { recursive: true });
    for (const plugin of options.profile.plugins) {
      const override = overrides[plugin.id];
      if (override !== undefined) {
        if (dependencies.overrideInspector === undefined) {
          throw new ProfileError(
            `no override inspector is configured for ${plugin.id}`,
          );
        }
        const overridePath = resolve(root, override.path);
        await verifyBundleIdentity(plugin, overridePath);
        const state =
          await dependencies.overrideInspector.inspect(overridePath);
        prepared.push({
          record: plugin,
          bundlePath: overridePath,
          source: "override",
          override: { path: overridePath, ...state },
        });
        continue;
      }

      try {
        const acquisition = await dependencies.bundles.obtain(
          plugin,
          join(downloadRoot, plugin.id),
        );
        verifyAcquisition(plugin, acquisition);
        await verifyBundleIdentity(plugin, acquisition.directory);
        await verifyDeclaredDigests(plugin, acquisition.directory);
        prepared.push({
          record: plugin,
          bundlePath: acquisition.directory,
          source: acquisition.source,
        });
      } catch (error) {
        if (
          error instanceof BundleNotFoundError &&
          plugin.requirement === "optional"
        ) {
          omitted.push({ id: plugin.id, reason: "optional-unavailable" });
          continue;
        }
        throw error;
      }
    }

    await dependencies.installer.install(
      stageVault,
      prepared.map((plugin) => ({
        path: plugin.bundlePath,
        enabled: plugin.record.enabled,
      })),
    );
    await reconcileStage(
      stagedObsidian,
      targetObsidian,
      root,
      vault,
      prepared,
      dependencies.settingsAdapters ?? {},
      localSettingsSources,
    );

    const receiptPlugins: ReceiptPlugin[] = [];
    for (const plugin of prepared) {
      const installed = join(stagedObsidian, "plugins", plugin.record.id);
      const files = await collectRuntimeDigests(plugin.record, installed);
      if (plugin.source !== "override") {
        assertDigestMap(plugin.record, files);
      }
      const settings = await collectSettingsReceipt(
        plugin.record,
        root,
        installed,
        localSettingsSources,
      );
      receiptPlugins.push({
        id: plugin.record.id,
        repository: plugin.record.repository,
        source: plugin.source,
        bundle: plugin.record.bundle,
        files,
        ...(settings === undefined ? {} : { settings }),
        ...(plugin.override === undefined ? {} : { override: plugin.override }),
      });
    }

    const receipt: InstallationReceipt = {
      format_version: 2,
      profile_digest: profileDigest(options.profile),
      runtime: options.profile.runtime,
      plugins: receiptPlugins,
      omitted,
    };
    await writeFile(
      join(stagedObsidian, "plugin-installation.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    await verifyNativeState(
      stagedObsidian,
      root,
      vault,
      options.profile,
      receipt,
      overrides,
      dependencies.overrideInspector,
      dependencies.settingsAdapters ?? {},
      localSettingsSources,
    );

    const activeTransaction = await replaceManagedState(
      stagedObsidian,
      targetObsidian,
      transactionRoot,
      dependencies.replacements,
    );
    transaction = activeTransaction;
    try {
      await verifyNativeState(
        targetObsidian,
        root,
        vault,
        options.profile,
        receipt,
        overrides,
        dependencies.overrideInspector,
        dependencies.settingsAdapters ?? {},
        localSettingsSources,
      );
    } catch (error) {
      await activeTransaction.rollback();
      transaction = undefined;
      throw error;
    }
    await activeTransaction.finalize();
    transaction = undefined;
    return receipt;
  } finally {
    if (transaction === undefined) {
      await rm(transactionRoot, { recursive: true, force: true });
    }
  }
}

/** Dependencies of the check; the cursor records the step that failed. */
export type CheckDependencies = Pick<
  MaterializerDependencies,
  "overrideInspector" | "settingsAdapters"
> & { readonly cursor?: CheckCursor };

/** Verify native state against the canonical profile and an optional local override record. */
export async function checkProfile(
  options: CheckOptions,
  dependencies: CheckDependencies = {},
): Promise<InstallationReceipt> {
  const vault = resolve(options.vault);
  const profile = parseProfile(options.profile);
  const localOverrides = parseLocalOverrides(
    options.localOverrides ?? {},
    profile,
  );
  const localSettingsSources = parseLocalSettingsSources(
    options.localSettingsSources ?? {},
    profile,
  );
  rejectLocalSourcesInDelivery(
    options.delivery,
    localOverrides,
    localSettingsSources,
  );
  return withVaultLock(vault, () =>
    checkProfileLocked(
      {
        ...options,
        vault,
        profile,
        localOverrides,
        localSettingsSources,
      },
      dependencies,
    ),
  );
}

async function checkProfileLocked(
  options: CheckOptions,
  dependencies: CheckDependencies,
): Promise<InstallationReceipt> {
  const vault = resolve(options.vault);
  const root = resolve(options.root ?? vault);
  const cursor = dependencies.cursor ?? new CheckCursor();
  await recoverIncompleteTransaction(vault);
  const obsidian = join(vault, ".obsidian");
  const receiptPath = join(obsidian, "plugin-installation.json");
  const atReceipt = (rule: CheckRuleId, locus = "") =>
    fileStep(rule, receiptPath, locus);
  const receiptText = await cursor.within(atReceipt("receipt/absent"), () =>
    readVaultText(receiptPath, "installation receipt"),
  );
  const receipt = await cursor.within(atReceipt("receipt/invalid"), () =>
    parseInstallationReceipt(
      parseVaultJson(receiptText, "installation receipt"),
    ),
  );
  await cursor.within(atReceipt("receipt/profile", "/profile_digest"), () => {
    if (receipt.profile_digest !== profileDigest(options.profile)) {
      throw new DriftError(
        "installation receipt belongs to another canonical profile",
      );
    }
  });
  await verifyNativeState(
    obsidian,
    root,
    vault,
    options.profile,
    receipt,
    options.localOverrides ?? {},
    dependencies.overrideInspector,
    dependencies.settingsAdapters ?? {},
    options.localSettingsSources ?? {},
    cursor,
  );
  return receipt;
}

async function reconcileStage(
  stagedObsidian: string,
  targetObsidian: string,
  root: string,
  consumerRoot: string,
  prepared: readonly PreparedPlugin[],
  adapters: Readonly<Record<string, SettingsAdapter>>,
  localSettingsSources: LocalSettingsSources,
): Promise<void> {
  const pluginsRoot = join(stagedObsidian, "plugins");
  await mkdir(pluginsRoot, { recursive: true });
  const expectedIds = new Set(prepared.map((plugin) => plugin.record.id));
  for (const entry of await safeReadDirectory(pluginsRoot)) {
    if (!expectedIds.has(entry)) {
      await rm(join(pluginsRoot, entry), { recursive: true, force: true });
    }
  }

  for (const plugin of prepared) {
    const pluginRoot = join(pluginsRoot, plugin.record.id);
    if (!(await exists(pluginRoot))) {
      throw new DriftError(`launcher did not install ${plugin.record.id}`);
    }
    await rm(join(pluginRoot, ".hotreload"), { force: true });
    await preserveMutableJsonFiles(
      plugin.record,
      join(targetObsidian, "plugins", plugin.record.id),
      pluginRoot,
    );
    await reconcileSettings(
      plugin.record,
      targetObsidian,
      root,
      consumerRoot,
      pluginRoot,
      adapters,
      localSettingsSources,
    );
    const allowed = allowedPluginFiles(plugin.record);
    for (const entry of await safeReadDirectory(pluginRoot)) {
      if (!allowed.has(entry)) {
        await rm(join(pluginRoot, entry), { recursive: true, force: true });
      }
    }
  }

  const enabled = prepared
    .filter((plugin) => plugin.record.enabled)
    .map((plugin) => plugin.record.id);
  await writeFile(
    join(stagedObsidian, "community-plugins.json"),
    `${JSON.stringify(enabled, null, 2)}\n`,
  );
}

async function reconcileSettings(
  plugin: PluginRecord,
  targetObsidian: string,
  root: string,
  consumerRoot: string,
  stagedPlugin: string,
  adapters: Readonly<Record<string, SettingsAdapter>>,
  localSettingsSources: LocalSettingsSources,
): Promise<void> {
  const destination = join(stagedPlugin, "data.json");
  if (plugin.settings.policy === "project-owned") {
    await resolveSourceFile(
      root,
      plugin.settings.source,
      `${plugin.id} project-owned settings`,
    );
    await rm(destination, { force: true });
    return;
  }
  if (plugin.settings.policy === "losslessly-projected") {
    const adapter = requireSettingsAdapter(plugin, adapters);
    const source = await selectSettingsSource(
      plugin,
      root,
      localSettingsSources,
    );
    await adapter.project(source.path, destination, { consumerRoot });
    await requireFile(destination, `${plugin.id} projected settings`);
    return;
  }
  const current = join(targetObsidian, "plugins", plugin.id, "data.json");
  if (await exists(current)) {
    await copyFile(current, destination);
  } else {
    await rm(destination, { force: true });
  }
}

async function verifyNativeState(
  obsidian: string,
  root: string,
  consumerRoot: string,
  profile: PluginProfile,
  receipt: InstallationReceipt,
  overrides: LocalOverrides,
  overrideInspector?: OverrideInspector,
  settingsAdapters: Readonly<Record<string, SettingsAdapter>> = {},
  localSettingsSources: LocalSettingsSources = {},
  cursor: CheckCursor = new CheckCursor(),
): Promise<void> {
  const receiptPath = join(obsidian, "plugin-installation.json");
  const pluginsRoot = join(obsidian, "plugins");
  const enabledPath = join(obsidian, "community-plugins.json");
  await cursor.within(
    fileStep("receipt/runtime", receiptPath, "/runtime"),
    () => {
      if (JSON.stringify(receipt.runtime) !== JSON.stringify(profile.runtime)) {
        throw new DriftError(
          "installation receipt records another Obsidian runtime",
        );
      }
    },
  );
  const profileById = new Map(
    profile.plugins.map((plugin) => [plugin.id, plugin]),
  );
  const omittedIds = await cursor.within(
    fileStep("receipt/omissions", receiptPath, "/omitted"),
    () => validateOmissions(profileById, receipt.omitted),
  );
  const expectedIds = profile.plugins
    .filter((plugin) => !omittedIds.has(plugin.id))
    .map((plugin) => plugin.id)
    .sort();
  await cursor.within(
    fileStep("receipt/membership", receiptPath, "/plugins"),
    () => {
      const receiptIds = receipt.plugins.map((plugin) => plugin.id).sort();
      if (
        new Set(receiptIds).size !== receiptIds.length ||
        !sameStrings(receiptIds, expectedIds)
      ) {
        throw new DriftError(
          `receipt membership differs: expected ${expectedIds.join(", ")}; found ${receiptIds.join(", ")}`,
        );
      }
    },
  );
  await cursor.within(
    folderStep("plugins/directories", pluginsRoot),
    async () => {
      const directories = (await safeReadDirectory(pluginsRoot)).sort();
      if (!sameStrings(directories, expectedIds)) {
        throw new DriftError(
          `plugin directories differ: expected ${expectedIds.join(", ")}; found ${directories.join(", ")}`,
        );
      }
    },
  );
  await cursor.within(fileStep("plugins/enabled", enabledPath), async () => {
    const enabled = parseVaultJson(
      await readVaultText(enabledPath, "community-plugins.json"),
      "community-plugins.json",
    );
    const expectedEnabled = profile.plugins
      .filter((plugin) => expectedIds.includes(plugin.id) && plugin.enabled)
      .map((plugin) => plugin.id);
    if (!Array.isArray(enabled) || !sameStrings(enabled, expectedEnabled)) {
      throw new DriftError(
        "community-plugins.json differs from the canonical enabled set",
      );
    }
  });

  for (const receiptPlugin of receipt.plugins) {
    const pluginRoot = join(pluginsRoot, receiptPlugin.id);
    const atPlugin = (rule: CheckRuleId) => folderStep(rule, pluginRoot);
    const plugin = await cursor.within(atPlugin("plugin/source"), () => {
      const record = profileById.get(receiptPlugin.id);
      if (record === undefined) {
        throw new DriftError(
          `receipt plugin ${receiptPlugin.id} is absent from the canonical profile`,
        );
      }
      if (
        receiptPlugin.repository !== record.repository ||
        JSON.stringify(receiptPlugin.bundle) !== JSON.stringify(record.bundle)
      ) {
        throw new DriftError(`receipt source differs for ${record.id}`);
      }
      if (
        receiptPlugin.source !== "override" &&
        receiptPlugin.source !== record.bundle.kind
      ) {
        throw new DriftError(`receipt source kind differs for ${record.id}`);
      }
      return record;
    });
    const actual = await cursor.within(atPlugin("plugin/files"), async () => {
      const files = await collectRuntimeDigests(plugin, pluginRoot);
      if (JSON.stringify(files) !== JSON.stringify(receiptPlugin.files)) {
        throw new DriftError(`runtime files drifted for ${plugin.id}`);
      }
      return files;
    });

    const override = overrides[plugin.id];
    if (override === undefined) {
      await cursor.within(atPlugin("override/active"), () => {
        if (receiptPlugin.source === "override") {
          throw new DriftError(`local override is active for ${plugin.id}`);
        }
      });
      await cursor.within(atPlugin("plugin/digest"), () =>
        assertDigestMap(plugin, actual),
      );
    } else {
      const expectedPath = resolve(root, override.path);
      const recorded = await cursor.within(atPlugin("override/state"), () => {
        if (
          receiptPlugin.source !== "override" ||
          receiptPlugin.override?.path !== expectedPath
        ) {
          throw new DriftError(`local override state differs for ${plugin.id}`);
        }
        return receiptPlugin.override;
      });
      if (overrideInspector === undefined) {
        throw new DriftError(
          `no override inspector is configured for ${plugin.id}`,
        );
      }
      await cursor.within(atPlugin("override/source"), async () => {
        const currentOverride = await overrideInspector.inspect(expectedPath);
        if (
          currentOverride.commit !== recorded.commit ||
          currentOverride.dirty !== recorded.dirty
        ) {
          throw new DriftError(
            `local override source state drifted for ${plugin.id}`,
          );
        }
      });
      await cursor.within(atPlugin("override/manifest"), () =>
        verifyBundleIdentity(plugin, expectedPath),
      );
      await cursor.within(atPlugin("override/files"), async () => {
        const currentOverrideFiles = await collectRuntimeDigests(
          plugin,
          expectedPath,
        );
        if (
          JSON.stringify(currentOverrideFiles) !==
          JSON.stringify(receiptPlugin.files)
        ) {
          throw new DriftError(`local override bytes drifted for ${plugin.id}`);
        }
      });
    }

    await cursor.within(atPlugin("plugin/undeclared-files"), async () => {
      const extra = (await safeReadDirectory(pluginRoot)).filter(
        (entry) => !allowedPluginFiles(plugin).has(entry),
      );
      if (extra.length > 0) {
        throw new DriftError(
          `undeclared files remain for ${plugin.id}: ${extra.join(", ")}`,
        );
      }
    });
    for (const file of plugin.mutable_json_files ?? []) {
      const path = join(pluginRoot, file);
      await cursor.within(fileStep("plugin/mutable-json", path), () =>
        readMutableJsonFile(path, `${plugin.id}/${file}`),
      );
    }
    await verifySettings(
      plugin,
      root,
      consumerRoot,
      pluginRoot,
      receiptPlugin.settings,
      settingsAdapters,
      localSettingsSources,
      cursor,
    );
  }
}

function validateOmissions(
  profileById: ReadonlyMap<string, PluginRecord>,
  omissions: readonly OmittedPlugin[],
): ReadonlySet<string> {
  const ids = omissions.map((omission) => omission.id);
  if (new Set(ids).size !== ids.length) {
    throw new DriftError("installation receipt contains duplicate omissions");
  }
  for (const omission of omissions) {
    const plugin = profileById.get(omission.id);
    if (
      plugin === undefined ||
      plugin.requirement !== "optional" ||
      omission.reason !== "optional-unavailable"
    ) {
      throw new DriftError(`invalid omission for ${omission.id}`);
    }
  }
  return new Set(ids);
}

async function verifySettings(
  plugin: PluginRecord,
  root: string,
  consumerRoot: string,
  pluginRoot: string,
  receipt: ReceiptSettings | undefined,
  adapters: Readonly<Record<string, SettingsAdapter>>,
  localSettingsSources: LocalSettingsSources,
  cursor: CheckCursor,
): Promise<void> {
  const native = join(pluginRoot, "data.json");
  const atSource = folderStep("settings/source", pluginRoot);
  if (plugin.settings.policy === "project-owned") {
    const source = plugin.settings.source;
    await cursor.within(atSource, () =>
      resolveSourceFile(root, source, `${plugin.id} project-owned settings`),
    );
    await cursor.within(fileStep("settings/native", native), async () => {
      if (await exists(native)) {
        throw new DriftError(
          `project-owned settings produced data.json for ${plugin.id}`,
        );
      }
    });
    return;
  }
  if (plugin.settings.policy === "losslessly-projected") {
    const { source, projectedDigest } = await cursor.within(
      atSource,
      async () => {
        const selected = await selectSettingsSource(
          plugin,
          root,
          localSettingsSources,
        );
        const adapter = requireSettingsAdapter(plugin, adapters);
        return {
          source: selected,
          projectedDigest: await projectSettingsDigest(
            adapter,
            plugin,
            selected.path,
            consumerRoot,
          ),
        };
      },
    );
    const adapterName = plugin.settings.adapter;
    await cursor.within(fileStep("settings/projected", native), async () => {
      if (
        receipt === undefined ||
        receipt.adapter !== adapterName ||
        receipt.source_mode !== source.mode ||
        receipt.source_sha256 !== (await sha256(source.path)) ||
        receipt.native_sha256 !== (await sha256(native)) ||
        projectedDigest !== receipt.native_sha256
      ) {
        throw new DriftError(`projected settings drifted for ${plugin.id}`);
      }
    });
    return;
  }
  await cursor.within(folderStep("settings/receipt", pluginRoot), () => {
    if (receipt !== undefined) {
      throw new DriftError(`unexpected settings receipt for ${plugin.id}`);
    }
  });
}

async function collectSettingsReceipt(
  plugin: PluginRecord,
  root: string,
  installed: string,
  localSettingsSources: LocalSettingsSources,
): Promise<ReceiptSettings | undefined> {
  if (plugin.settings.policy !== "losslessly-projected") {
    return undefined;
  }
  const source = await selectSettingsSource(plugin, root, localSettingsSources);
  return {
    adapter: plugin.settings.adapter,
    source_mode: source.mode,
    source_sha256: await sha256(source.path),
    native_sha256: await sha256(join(installed, "data.json")),
  };
}

function requireSettingsAdapter(
  plugin: PluginRecord,
  adapters: Readonly<Record<string, SettingsAdapter>>,
): SettingsAdapter {
  if (plugin.settings.policy !== "losslessly-projected") {
    throw new ProfileError(`${plugin.id} does not use projected settings`);
  }
  const adapter = adapters[plugin.settings.adapter];
  if (adapter === undefined) {
    throw new ProfileError(
      `settings adapter ${plugin.settings.adapter} is unavailable for ${plugin.id}`,
    );
  }
  if (!adapter.supports(plugin)) {
    throw new ProfileError(
      `settings adapter ${plugin.settings.adapter} does not support ${plugin.id} at the selected bundle`,
    );
  }
  return adapter;
}

async function selectSettingsSource(
  plugin: PluginRecord,
  root: string,
  localSettingsSources: LocalSettingsSources,
): Promise<SelectedSettingsSource> {
  if (plugin.settings.policy !== "losslessly-projected") {
    throw new ProfileError(`${plugin.id} does not use projected settings`);
  }
  const local = localSettingsSources[plugin.id];
  const mode = local === undefined ? "canonical" : "local";
  const source = local?.source ?? plugin.settings.source;
  return {
    mode,
    path: await resolveSourceFile(
      root,
      source,
      `${plugin.id} ${mode} settings source`,
    ),
  };
}

async function projectSettingsDigest(
  adapter: SettingsAdapter,
  plugin: PluginRecord,
  source: string,
  consumerRoot: string,
): Promise<string> {
  const temporary = await mkdtemp(join(tmpdir(), "kataskeue-settings-"));
  try {
    const destination = join(temporary, "data.json");
    await adapter.project(source, destination, { consumerRoot });
    await requireFile(destination, `${plugin.id} projected settings`);
    return await sha256(destination);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function rejectLocalSourcesInDelivery(
  delivery: boolean | undefined,
  localOverrides: LocalOverrides,
  localSettingsSources: LocalSettingsSources,
): void {
  if (!delivery) return;
  if (Object.keys(localOverrides).length > 0) {
    throw new ProfileError("delivery mode rejects local build overrides");
  }
  if (Object.keys(localSettingsSources).length > 0) {
    throw new ProfileError("delivery mode rejects local settings sources");
  }
}

async function verifyBundleIdentity(
  plugin: PluginRecord,
  directory: string,
): Promise<void> {
  const manifest = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  ) as unknown;
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("id" in manifest) ||
    manifest.id !== plugin.id
  ) {
    throw new ProfileError(
      `bundle manifest identifier does not equal ${plugin.id}`,
    );
  }
}

function verifyAcquisition(
  plugin: PluginRecord,
  acquisition: BundleAcquisition,
): void {
  if (plugin.bundle.kind === "release" && acquisition.source !== "release") {
    throw new ProfileError(
      `provider returned an artifact for release ${plugin.id}`,
    );
  }
  if (plugin.bundle.kind === "artifact") {
    if (
      acquisition.source !== "artifact" ||
      acquisition.artifact?.locator !== plugin.bundle.locator ||
      acquisition.artifact.source_commit !== plugin.bundle.source_commit ||
      acquisition.artifact.sha256 !== plugin.bundle.sha256
    ) {
      throw new DigestMismatchError(
        `artifact evidence differs for ${plugin.id}`,
      );
    }
  }
}

async function verifyDeclaredDigests(
  plugin: PluginRecord,
  directory: string,
): Promise<void> {
  const actual = await collectRuntimeDigests(plugin, directory);
  assertDigestMap(plugin, actual);
}

function assertDigestMap(plugin: PluginRecord, actual: RuntimeFiles): void {
  for (const [fileName, expected] of Object.entries(plugin.files)) {
    if (actual[fileName as RuntimeFileName] !== expected) {
      throw new DigestMismatchError(
        `${plugin.id}/${fileName} digest differs: expected ${expected}; found ${String(actual[fileName as RuntimeFileName])}`,
      );
    }
  }
}

async function collectRuntimeDigests(
  plugin: PluginRecord,
  directory: string,
): Promise<RuntimeFiles> {
  const required = {
    "manifest.json": await digestRegularFile(
      join(directory, "manifest.json"),
      `${plugin.id}/manifest.json`,
    ),
    "main.js": await digestRegularFile(
      join(directory, "main.js"),
      `${plugin.id}/main.js`,
    ),
  };
  if (plugin.files["styles.css"] === undefined) {
    return required;
  }
  return {
    ...required,
    "styles.css": await digestRegularFile(
      join(directory, "styles.css"),
      `${plugin.id}/styles.css`,
    ),
  };
}

async function digestRegularFile(path: string, label: string): Promise<string> {
  try {
    if ((await lstat(path)).isFile()) {
      return await sha256(path);
    }
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
  throw new ProfileError(`${label} is missing or is not a regular file`);
}

function allowedPluginFiles(plugin: PluginRecord): ReadonlySet<string> {
  const allowed = new Set<string>(Object.keys(plugin.files));
  for (const file of plugin.mutable_json_files ?? []) {
    allowed.add(file);
  }
  if (plugin.settings.policy !== "project-owned") {
    allowed.add("data.json");
  }
  return allowed;
}

async function preserveMutableJsonFiles(
  plugin: PluginRecord,
  currentPlugin: string,
  stagedPlugin: string,
): Promise<void> {
  for (const file of plugin.mutable_json_files ?? []) {
    const source = join(currentPlugin, file);
    const destination = join(stagedPlugin, file);
    await rm(destination, { force: true });
    const contents = await readMutableJsonFile(source, `${plugin.id}/${file}`);
    if (contents === undefined) continue;
    await writeFile(destination, contents, { mode: 0o600 });
  }
}

async function readMutableJsonFile(
  path: string,
  label: string,
): Promise<string | undefined> {
  let pathState;
  try {
    pathState = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (!pathState.isFile()) {
    throw new ProfileError(`${label} must be a regular JSON file`);
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  try {
    const handleState = await handle.stat();
    if (
      !handleState.isFile() ||
      pathState.dev !== handleState.dev ||
      pathState.ino !== handleState.ino
    ) {
      throw new ProfileError(`${label} must be a regular JSON file`);
    }
    const contents = await handle.readFile("utf8");
    try {
      JSON.parse(contents);
    } catch {
      throw new ProfileError(`${label} must contain valid JSON`);
    }
    return contents;
  } finally {
    await handle.close();
  }
}

function resolveWithin(root: string, path: string): string {
  const resolved = resolve(root, path);
  const rel = relative(root, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new ProfileError(`path leaves the settings-source root: ${path}`);
  }
  return resolved;
}

async function resolveSourceFile(
  root: string,
  path: string,
  label: string,
): Promise<string> {
  const lexical = resolveWithin(root, path);
  let actualRoot: string;
  let actualSource: string;
  try {
    [actualRoot, actualSource] = await Promise.all([
      realpath(root),
      realpath(lexical),
    ]);
  } catch (error) {
    if (isMissing(error)) {
      throw new ProfileError(`${label} is missing: ${lexical}`);
    }
    throw error;
  }
  const rel = relative(actualRoot, actualSource);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new ProfileError(`${label} resolves outside the consumer root`);
  }
  await requireFile(actualSource, label);
  return actualSource;
}

async function requireFile(path: string, label: string): Promise<void> {
  try {
    if ((await lstat(path)).isFile()) {
      return;
    }
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
  throw new ProfileError(`${label} is missing or is not a file: ${path}`);
}

function sameStrings(
  left: readonly unknown[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function profileDigest(profile: PluginProfile): string {
  return createHash("sha256").update(JSON.stringify(profile)).digest("hex");
}

async function safeReadDirectory(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    return isMissing(error) ? false : Promise.reject(error);
  }
}

/** Read a file of the vault, reporting its absence as drift. */
async function readVaultText(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      throw new DriftError(`${label} is absent`);
    }
    throw error;
  }
}

/** Parse a file of the vault, reporting invalid JSON as drift. */
function parseVaultJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DriftError(`${label} is not valid JSON`);
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
