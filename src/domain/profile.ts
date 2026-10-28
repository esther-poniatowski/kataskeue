import * as z from "zod";

import { ProfileError } from "../errors.js";

export const runtimeFileNames = [
  "manifest.json",
  "main.js",
  "styles.css",
] as const;
export type RuntimeFileName = (typeof runtimeFileNames)[number];

export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const commitSchema = z.string().regex(/^[0-9a-f]{40}$/);
export const pluginIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);
const relativePathSchema = z
  .string()
  .min(1)
  .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\).+$/);

const releaseBundleSchema = z
  .object({ kind: z.literal("release"), tag: z.string().min(1) })
  .strict();
const artifactBundleSchema = z
  .object({
    kind: z.literal("artifact"),
    locator: z.string().min(1),
    source_commit: commitSchema,
    sha256: sha256Schema,
  })
  .strict();
export const bundleSchema = z.discriminatedUnion("kind", [
  releaseBundleSchema,
  artifactBundleSchema,
]);

const nativePortableSettingsSchema = z
  .object({ policy: z.literal("native-portable") })
  .strict();
const machineLocalSettingsSchema = z
  .object({ policy: z.literal("machine-local") })
  .strict();
const projectOwnedSettingsSchema = z
  .object({ policy: z.literal("project-owned"), source: relativePathSchema })
  .strict();
const projectedSettingsSchema = z
  .object({
    policy: z.literal("losslessly-projected"),
    source: relativePathSchema,
    adapter: z.string().min(1),
  })
  .strict();
const settingsSchema = z.discriminatedUnion("policy", [
  nativePortableSettingsSchema,
  machineLocalSettingsSchema,
  projectOwnedSettingsSchema,
  projectedSettingsSchema,
]);

export const runtimeFilesSchema = z
  .object({
    "manifest.json": sha256Schema,
    "main.js": sha256Schema,
    "styles.css": sha256Schema.optional(),
  })
  .strict();
export type RuntimeFiles = Readonly<z.infer<typeof runtimeFilesSchema>>;

const pluginFields = {
  id: pluginIdSchema,
  repository: z.url().regex(/^https:\/\/[^/]/, "must use HTTPS"),
  bundle: bundleSchema,
  files: runtimeFilesSchema,
  settings: settingsSchema,
};
const requiredPluginSchema = z
  .object({
    ...pluginFields,
    requirement: z.literal("required"),
    enabled: z.boolean(),
  })
  .strict();
const optionalPluginSchema = z
  .object({
    ...pluginFields,
    requirement: z.literal("optional"),
    enabled: z.literal(false),
  })
  .strict();
const pluginSchema = z.union([requiredPluginSchema, optionalPluginSchema]);

export const runtimeSchema = z
  .object({
    minimum_obsidian: z.string().min(1),
    checked_obsidian: z.string().min(1),
    checked_installer: z.string().min(1),
  })
  .strict();

/** Executable source of the canonical profile contract. */
export const pluginProfileSchema = z
  .object({
    format_version: z.literal(1),
    runtime: runtimeSchema,
    plugins: z.array(pluginSchema),
  })
  .strict()
  .superRefine((profile, context) => {
    const ids = profile.plugins.map((plugin) => plugin.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "plugin identifiers must be unique",
        path: ["plugins"],
      });
    }
    const sorted = [...ids].sort((left, right) => left.localeCompare(right));
    if (ids.some((id, index) => id !== sorted[index])) {
      context.addIssue({
        code: "custom",
        message: "plugins must follow identifier order",
        path: ["plugins"],
      });
    }
  });

const localOverrideSchema = z.object({ path: z.string().min(1) }).strict();
const localOverridesSchema = z.record(pluginIdSchema, localOverrideSchema);

export type PluginProfile = Readonly<z.infer<typeof pluginProfileSchema>>;
export type PluginRecord = PluginProfile["plugins"][number];
export type BundleRecord = PluginRecord["bundle"];
export type RuntimeRecord = PluginProfile["runtime"];
export type LocalOverride = Readonly<z.infer<typeof localOverrideSchema>>;
export type LocalOverrides = Readonly<Record<string, LocalOverride>>;

/** Parse the profile through the executable canonical schema. */
export function parseProfile(value: unknown): PluginProfile {
  return parseWithSchema(pluginProfileSchema, value, "invalid plugin profile");
}

/** Parse local overrides and reject identifiers absent from the profile. */
export function parseLocalOverrides(
  value: unknown,
  profile: PluginProfile,
): LocalOverrides {
  const overrides = parseWithSchema(
    localOverridesSchema,
    value,
    "invalid local overrides",
  );
  const declared = new Set(profile.plugins.map((plugin) => plugin.id));
  for (const id of Object.keys(overrides)) {
    if (!declared.has(id)) {
      throw new ProfileError(
        `local override ${id} is absent from the canonical profile`,
      );
    }
  }
  return overrides;
}

function parseWithSchema<T>(
  schema: z.ZodType<T>,
  value: unknown,
  message: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ");
    throw new ProfileError(`${message}: ${details}`);
  }
  return result.data;
}
