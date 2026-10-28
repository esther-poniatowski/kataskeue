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
  readonly delivery?: boolean;
}

export interface CheckOptions {
  readonly vault: string;
  readonly root?: string;
  readonly profile: PluginProfile;
  readonly localOverrides?: LocalOverrides;
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
  return withVaultLock(vault, () =>
    applyProfileLocked(
      { ...options, vault, profile, localOverrides },
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
  await recoverIncompleteTransaction(vault);
  if (options.delivery && Object.keys(overrides).length > 0) {
    throw new ProfileError("delivery mode rejects local overrides");
  }

  const targetObsidian = join(vault, ".obsidian");
  const transactionRoot = await mkdtemp(
    join(vault, ".obsidian-plugin-materializer-"),
  );
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
      prepared,
      dependencies.settingsAdapters ?? {},
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
      format_version: 1,
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
      options.profile,
      receipt,
      overrides,
      dependencies.overrideInspector,
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
        options.profile,
        receipt,
        overrides,
        dependencies.overrideInspector,
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

/** Verify native state against the canonical profile and an optional local override record. */
export async function checkProfile(
  options: CheckOptions,
  dependencies: Pick<MaterializerDependencies, "overrideInspector"> = {},
): Promise<InstallationReceipt> {
  const vault = resolve(options.vault);
  const profile = parseProfile(options.profile);
  const localOverrides = parseLocalOverrides(
    options.localOverrides ?? {},
    profile,
  );
  return withVaultLock(vault, () =>
    checkProfileLocked(
      { ...options, vault, profile, localOverrides },
      dependencies,
    ),
  );
}

async function checkProfileLocked(
  options: CheckOptions,
  dependencies: Pick<MaterializerDependencies, "overrideInspector">,
): Promise<InstallationReceipt> {
  const vault = resolve(options.vault);
  const root = resolve(options.root ?? vault);
  await recoverIncompleteTransaction(vault);
  const obsidian = join(vault, ".obsidian");
  const receipt = parseInstallationReceipt(
    JSON.parse(
      await readFile(join(obsidian, "plugin-installation.json"), "utf8"),
    ),
  );
  if (receipt.profile_digest !== profileDigest(options.profile)) {
    throw new DriftError(
      "installation receipt belongs to another canonical profile",
    );
  }
  await verifyNativeState(
    obsidian,
    root,
    options.profile,
    receipt,
    options.localOverrides ?? {},
    dependencies.overrideInspector,
  );
  return receipt;
}

async function reconcileStage(
  stagedObsidian: string,
  targetObsidian: string,
  root: string,
  prepared: readonly PreparedPlugin[],
  adapters: Readonly<Record<string, SettingsAdapter>>,
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
      pluginRoot,
      adapters,
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
  stagedPlugin: string,
  adapters: Readonly<Record<string, SettingsAdapter>>,
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
    const source = await resolveSourceFile(
      root,
      plugin.settings.source,
      `${plugin.id} settings source`,
    );
    await adapter.project(source, destination);
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
  profile: PluginProfile,
  receipt: InstallationReceipt,
  overrides: LocalOverrides,
  overrideInspector?: OverrideInspector,
): Promise<void> {
  if (JSON.stringify(receipt.runtime) !== JSON.stringify(profile.runtime)) {
    throw new DriftError(
      "installation receipt records another Obsidian runtime",
    );
  }
  const profileById = new Map(
    profile.plugins.map((plugin) => [plugin.id, plugin]),
  );
  const omittedIds = validateOmissions(profileById, receipt.omitted);
  const expectedIds = profile.plugins
    .filter((plugin) => !omittedIds.has(plugin.id))
    .map((plugin) => plugin.id)
    .sort();
  const receiptIds = receipt.plugins.map((plugin) => plugin.id).sort();
  if (
    new Set(receiptIds).size !== receiptIds.length ||
    !sameStrings(receiptIds, expectedIds)
  ) {
    throw new DriftError(
      `receipt membership differs: expected ${expectedIds.join(", ")}; found ${receiptIds.join(", ")}`,
    );
  }
  const directories = (
    await safeReadDirectory(join(obsidian, "plugins"))
  ).sort();
  if (!sameStrings(directories, expectedIds)) {
    throw new DriftError(
      `plugin directories differ: expected ${expectedIds.join(", ")}; found ${directories.join(", ")}`,
    );
  }

  const enabled = JSON.parse(
    await readFile(join(obsidian, "community-plugins.json"), "utf8"),
  ) as unknown;
  const expectedEnabled = profile.plugins
    .filter((plugin) => expectedIds.includes(plugin.id) && plugin.enabled)
    .map((plugin) => plugin.id);
  if (!Array.isArray(enabled) || !sameStrings(enabled, expectedEnabled)) {
    throw new DriftError(
      "community-plugins.json differs from the canonical enabled set",
    );
  }

  for (const receiptPlugin of receipt.plugins) {
    const plugin = profileById.get(receiptPlugin.id);
    if (plugin === undefined) {
      throw new DriftError(
        `receipt plugin ${receiptPlugin.id} is absent from the canonical profile`,
      );
    }
    if (
      receiptPlugin.repository !== plugin.repository ||
      JSON.stringify(receiptPlugin.bundle) !== JSON.stringify(plugin.bundle)
    ) {
      throw new DriftError(`receipt source differs for ${plugin.id}`);
    }
    if (
      receiptPlugin.source !== "override" &&
      receiptPlugin.source !== plugin.bundle.kind
    ) {
      throw new DriftError(`receipt source kind differs for ${plugin.id}`);
    }
    const pluginRoot = join(obsidian, "plugins", plugin.id);
    const actual = await collectRuntimeDigests(plugin, pluginRoot);
    if (JSON.stringify(actual) !== JSON.stringify(receiptPlugin.files)) {
      throw new DriftError(`runtime files drifted for ${plugin.id}`);
    }

    const override = overrides[plugin.id];
    if (override === undefined) {
      if (receiptPlugin.source === "override") {
        throw new DriftError(`local override is active for ${plugin.id}`);
      }
      assertDigestMap(plugin, actual);
    } else {
      const expectedPath = resolve(root, override.path);
      if (
        receiptPlugin.source !== "override" ||
        receiptPlugin.override?.path !== expectedPath
      ) {
        throw new DriftError(`local override state differs for ${plugin.id}`);
      }
      if (overrideInspector === undefined) {
        throw new DriftError(
          `no override inspector is configured for ${plugin.id}`,
        );
      }
      const currentOverride = await overrideInspector.inspect(expectedPath);
      if (
        currentOverride.commit !== receiptPlugin.override.commit ||
        currentOverride.dirty !== receiptPlugin.override.dirty
      ) {
        throw new DriftError(
          `local override source state drifted for ${plugin.id}`,
        );
      }
      await verifyBundleIdentity(plugin, expectedPath);
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
    }

    const extra = (await safeReadDirectory(pluginRoot)).filter(
      (entry) => !allowedPluginFiles(plugin).has(entry),
    );
    if (extra.length > 0) {
      throw new DriftError(
        `undeclared files remain for ${plugin.id}: ${extra.join(", ")}`,
      );
    }
    await verifyMutableJsonFiles(plugin, pluginRoot);
    await verifySettings(plugin, root, pluginRoot, receiptPlugin.settings);
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
  pluginRoot: string,
  receipt: ReceiptSettings | undefined,
): Promise<void> {
  const native = join(pluginRoot, "data.json");
  if (plugin.settings.policy === "project-owned") {
    await resolveSourceFile(
      root,
      plugin.settings.source,
      `${plugin.id} project-owned settings`,
    );
    if (await exists(native)) {
      throw new DriftError(
        `project-owned settings produced data.json for ${plugin.id}`,
      );
    }
    return;
  }
  if (plugin.settings.policy === "losslessly-projected") {
    const source = await resolveSourceFile(
      root,
      plugin.settings.source,
      `${plugin.id} settings source`,
    );
    if (
      receipt === undefined ||
      receipt.adapter !== plugin.settings.adapter ||
      receipt.source_sha256 !== (await sha256(source)) ||
      receipt.native_sha256 !== (await sha256(native))
    ) {
      throw new DriftError(`projected settings drifted for ${plugin.id}`);
    }
    return;
  }
  if (receipt !== undefined) {
    throw new DriftError(`unexpected settings receipt for ${plugin.id}`);
  }
}

async function collectSettingsReceipt(
  plugin: PluginRecord,
  root: string,
  installed: string,
): Promise<ReceiptSettings | undefined> {
  if (plugin.settings.policy !== "losslessly-projected") {
    return undefined;
  }
  return {
    adapter: plugin.settings.adapter,
    source_sha256: await sha256(
      await resolveSourceFile(
        root,
        plugin.settings.source,
        `${plugin.id} settings source`,
      ),
    ),
    native_sha256: await sha256(join(installed, "data.json")),
  };
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

async function verifyMutableJsonFiles(
  plugin: PluginRecord,
  pluginRoot: string,
): Promise<void> {
  for (const file of plugin.mutable_json_files ?? []) {
    await readMutableJsonFile(join(pluginRoot, file), `${plugin.id}/${file}`);
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
    throw new ProfileError(`path leaves the consumer root: ${path}`);
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

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
