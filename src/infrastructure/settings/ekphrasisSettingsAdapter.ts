import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import * as z from "zod";

import type { PluginRecord } from "../../domain/profile.js";
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

const sourceSchema = z
  .object({
    format_version: z.literal(1),
    schema_registry: literalRootPathSchema,
    path_rules: z.array(pathRuleSchema),
    commit_delay: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Projects the settings file of Ekphrasis into native plugin keys.
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
    const parsed = sourceSchema.safeParse(
      parseSettingsSource(
        await readFile(source, "utf8"),
        "Ekphrasis settings source",
      ),
    );
    if (!parsed.success) {
      throw new ProfileError(
        `invalid Ekphrasis settings: ${parsed.error.issues
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
