import { readFile, writeFile } from "node:fs/promises";

import * as z from "zod";

import type { PluginRecord } from "../../domain/profile.js";
import { ProfileError } from "../../errors.js";
import type { SettingsAdapter } from "../../ports.js";
import { parseSettingsSource } from "./parseSettingsSource.js";

const vaultRelativePathSchema = z
  .string()
  .min(1)
  .regex(
    /^(?!\/)(?![A-Za-z]:)(?!.*:\/\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\).+$/,
  );
const literalVaultPathSchema = vaultRelativePathSchema.refine(
  (path) => !/[*?{}[\]]/.test(path),
  "must name a literal vault-relative path",
);

const pathRuleSchema = z
  .object({
    pattern: vaultRelativePathSchema,
    schema: literalVaultPathSchema,
  })
  .strict();

const sourceSchema = z
  .object({
    format_version: z.literal(1),
    schema_registry: literalVaultPathSchema,
    path_rules: z.array(pathRuleSchema),
    commit_delay: z.number().int().nonnegative(),
  })
  .strict();

/** Projects the portable Ekphrasis settings contract into native plugin keys. */
export class EkphrasisSettingsAdapter implements SettingsAdapter {
  supports(plugin: PluginRecord): boolean {
    return plugin.id === "ekphrasis";
  }

  async project(source: string, destination: string): Promise<void> {
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
    const settings = {
      schemaRegistry: parsed.data.schema_registry,
      pathRules: parsed.data.path_rules,
      commitDelay: parsed.data.commit_delay,
    };
    await writeFile(destination, `${JSON.stringify(settings, null, 2)}\n`);
  }
}
