import * as z from "zod";

import {
  bundleSchema,
  commitSchema,
  pluginIdSchema,
  runtimeFilesSchema,
  runtimeSchema,
  sha256Schema,
} from "../domain/profile.js";
import { DriftError } from "../errors.js";

const receiptSettingsSchema = z
  .object({
    adapter: z.string().min(1),
    source_mode: z.enum(["canonical", "local"]),
    source_sha256: sha256Schema,
    native_sha256: sha256Schema,
  })
  .strict();

const overrideStateSchema = z
  .object({
    path: z.string().min(1),
    commit: commitSchema.nullable(),
    dirty: z.boolean().nullable(),
  })
  .strict();

const receiptPluginSchema = z
  .object({
    id: pluginIdSchema,
    repository: z.url(),
    source: z.enum(["release", "artifact", "override"]),
    bundle: bundleSchema,
    files: runtimeFilesSchema,
    settings: receiptSettingsSchema.optional(),
    override: overrideStateSchema.optional(),
  })
  .strict()
  .superRefine((plugin, context) => {
    if (plugin.source === "override" && plugin.override === undefined) {
      context.addIssue({
        code: "custom",
        message: "override sources require override state",
        path: ["override"],
      });
    }
    if (plugin.source !== "override" && plugin.override !== undefined) {
      context.addIssue({
        code: "custom",
        message: "canonical sources cannot carry override state",
        path: ["override"],
      });
    }
  });

const omittedPluginSchema = z
  .object({
    id: pluginIdSchema,
    reason: z.literal("optional-unavailable"),
  })
  .strict();

export const installationReceiptSchema = z
  .object({
    format_version: z.literal(2),
    profile_digest: sha256Schema,
    runtime: runtimeSchema,
    plugins: z.array(receiptPluginSchema),
    omitted: z.array(omittedPluginSchema),
  })
  .strict();

export type ReceiptSettings = Readonly<z.infer<typeof receiptSettingsSchema>>;
export type ReceiptPlugin = Readonly<z.infer<typeof receiptPluginSchema>>;
export type OmittedPlugin = Readonly<z.infer<typeof omittedPluginSchema>>;
export type InstallationReceipt = Readonly<
  z.infer<typeof installationReceiptSchema>
>;

/** Parse an installation receipt before using it to inspect native state. */
export function parseInstallationReceipt(value: unknown): InstallationReceipt {
  const result = installationReceiptSchema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ");
    throw new DriftError(`invalid installation receipt: ${details}`);
  }
  return result.data;
}
