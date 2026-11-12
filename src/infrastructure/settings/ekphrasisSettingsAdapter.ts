import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import * as z from "zod";

import type { PluginRecord } from "../../domain/profile.js";
import { requireFileFormat } from "../../domain/fileFormat.js";
import { ProfileError } from "../../errors.js";
import type {
  SettingsAdapter,
  SettingsProjectionContext,
} from "../../ports.js";
import { parseSettingsSource } from "./parseSettingsSource.js";

const rootRelativePathSchema = z
  .string()
  .min(1)
  .regex(
    /^(?!\/)(?![A-Za-z]:)(?!.*:\/\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\).+$/,
  );
const literalRootPathSchema = rootRelativePathSchema.refine(
  (path) => !/[*?{}[\]]/.test(path),
  "must name a literal root-relative path",
);

const pathRuleSchema = z
  .object({
    pattern: rootRelativePathSchema,
    schema: literalRootPathSchema,
  })
  .strict();

/** Identifier that the source file declares in `_schema`. */
const SOURCE_FORMAT = "ekphrasis:configuration@1";

const sourceSchema = z
  .object({
    _schema: z.literal(SOURCE_FORMAT),
    schema_registry: literalRootPathSchema,
    path_rules: z.array(pathRuleSchema),
    excluded_paths: z.array(rootRelativePathSchema).optional(),
    commit_delay: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Projects the configuration file of Ekphrasis into native plugin keys.
 *
 * The file `ekphrasis.yml` writes its paths relative to the root of the repository, whereas
 * the plugin resolves the native paths inside the vault; the adapter rewrites each path from
 * the one folder to the other.
 */
export class EkphrasisSettingsAdapter implements SettingsAdapter {
  readonly toolSettingsFile = "ekphrasis.yml";

  supports(plugin: PluginRecord): boolean {
    return plugin.id === "ekphrasis";
  }

  async project(
    source: string,
    destination: string,
    context: SettingsProjectionContext,
  ): Promise<void> {
    const content = parseSettingsSource(
      await readFile(source, "utf8"),
      "Ekphrasis configuration file",
    );
    requireFileFormat(
      content,
      SOURCE_FORMAT,
      `Ekphrasis configuration file ${source}`,
    );
    const parsed = sourceSchema.safeParse(content);
    if (!parsed.success) {
      throw new ProfileError(
        `invalid Ekphrasis configuration file: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    const toVault = vaultPathFromRoot(context);
    const settings = {
      schemaRegistry: toVault(parsed.data.schema_registry),
      pathRules: parsed.data.path_rules.map((rule) => ({
        pattern: toVault(rule.pattern),
        schema: toVault(rule.schema),
      })),
      ...(parsed.data.excluded_paths === undefined
        ? {}
        : { excludedPaths: parsed.data.excluded_paths.map(toVault) }),
      commitDelay: parsed.data.commit_delay,
    };
    await writeFile(destination, `${JSON.stringify(settings, null, 2)}\n`);
  }
}

/**
 * Return the rewriting of a root-relative path into a vault-relative path.
 *
 * The root must be the vault or one of its folders: a pattern relative to a root outside the
 * vault has no equivalent inside the vault.
 */
function vaultPathFromRoot(
  context: SettingsProjectionContext,
): (path: string) => string {
  const vault = resolve(context.consumerRoot);
  const root = resolve(context.root);
  const offset = relative(vault, root);
  if (offset === "") {
    return (path) => path;
  }
  if (offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset)) {
    throw new ProfileError(
      `the root ${root} lies outside the vault ${vault}; the paths of ekphrasis.yml must resolve inside the vault`,
    );
  }
  const prefix = offset.split(sep).join("/");
  return (path) => `${prefix}/${path}`;
}
