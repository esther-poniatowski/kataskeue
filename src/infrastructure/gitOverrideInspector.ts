import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { OverrideInspector, OverrideState } from "../ports.js";

const execute = promisify(execFile);

/** Reports the commit and worktree state of a local development override. */
export class GitOverrideInspector implements OverrideInspector {
  async inspect(path: string): Promise<OverrideState> {
    try {
      const [{ stdout: commit }, { stdout: status }] = await Promise.all([
        execute("git", ["-C", path, "rev-parse", "HEAD"]),
        execute("git", ["-C", path, "status", "--porcelain"]),
      ]);
      return { commit: commit.trim(), dirty: status.length > 0 };
    } catch {
      return { commit: null, dirty: null };
    }
  }
}
