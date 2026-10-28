import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** Return the lowercase SHA-256 digest of one file. */
export async function sha256(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}
