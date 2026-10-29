import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import { ReplacementError } from "../errors.js";
import type { ReplaceOperations } from "../ports.js";

const managedNames = [
  "plugins",
  "community-plugins.json",
  "plugin-installation.json",
] as const;
type ManagedName = (typeof managedNames)[number];

interface TransactionJournal {
  readonly format_version: 1;
  readonly transaction_root: string;
  readonly target_obsidian: string;
  readonly phase: "replacing" | "verified";
  readonly original: Readonly<Record<ManagedName, boolean>>;
}

const defaultOperations: ReplaceOperations = { move: rename };

export interface ManagedStateTransaction {
  finalize(): Promise<void>;
  rollback(): Promise<void>;
}

/** Replace managed paths while retaining a durable rollback journal. */
export async function replaceManagedState(
  stagedObsidian: string,
  targetObsidian: string,
  transactionRoot: string,
  operations: ReplaceOperations = defaultOperations,
): Promise<ManagedStateTransaction> {
  const vault = dirname(targetObsidian);
  const journalPath = journalLocation(vault);
  const backupRoot = join(transactionRoot, "backup");
  await mkdir(backupRoot, { recursive: true });
  await mkdir(targetObsidian, { recursive: true });

  const original = Object.fromEntries(
    await Promise.all(
      managedNames.map(
        async (name) =>
          [name, await exists(join(targetObsidian, name))] as const,
      ),
    ),
  ) as Record<ManagedName, boolean>;
  let journal: TransactionJournal = {
    format_version: 1,
    transaction_root: resolve(transactionRoot),
    target_obsidian: resolve(targetObsidian),
    phase: "replacing",
    original,
  };
  await writeJournal(journalPath, journal);

  try {
    for (const name of managedNames) {
      const target = join(targetObsidian, name);
      if (original[name]) {
        await operations.move(target, join(backupRoot, name));
      }
    }
    for (const name of managedNames) {
      await operations.move(
        join(stagedObsidian, name),
        join(targetObsidian, name),
      );
    }
  } catch (cause) {
    await rollbackJournal(journalPath, journal);
    throw new ReplacementError(
      `plugin state replacement failed; the previous state was restored: ${String(cause)}`,
    );
  }

  return {
    async finalize(): Promise<void> {
      journal = { ...journal, phase: "verified" };
      await writeJournal(journalPath, journal);
      await rm(transactionRoot, { recursive: true, force: true });
      await rm(journalPath, { force: true });
    },
    async rollback(): Promise<void> {
      await rollbackJournal(journalPath, journal);
    },
  };
}

/** Restore a transaction that ended before resulting-state verification. */
export async function recoverIncompleteTransaction(
  vaultPath: string,
): Promise<boolean> {
  const vault = resolve(vaultPath);
  const journalPath = journalLocation(vault);
  if (!(await exists(journalPath))) {
    return false;
  }
  const journal = JSON.parse(
    await readFile(journalPath, "utf8"),
  ) as TransactionJournal;
  validateJournal(vault, journal);
  if (journal.phase === "verified") {
    await rm(journal.transaction_root, { recursive: true, force: true });
    await rm(journalPath, { force: true });
  } else {
    await rollbackJournal(journalPath, journal);
  }
  return true;
}

async function rollbackJournal(
  journalPath: string,
  journal: TransactionJournal,
): Promise<void> {
  const backupRoot = join(journal.transaction_root, "backup");
  for (const name of [...managedNames].reverse()) {
    const target = join(journal.target_obsidian, name);
    const backup = join(backupRoot, name);
    if (journal.original[name]) {
      if (await exists(backup)) {
        await rm(target, { recursive: true, force: true });
        await rename(backup, target);
      }
    } else {
      await rm(target, { recursive: true, force: true });
    }
  }
  await rm(journal.transaction_root, { recursive: true, force: true });
  await rm(journalPath, { force: true });
}

function validateJournal(vault: string, journal: TransactionJournal): void {
  const transactionRelative = relative(vault, journal.transaction_root);
  if (
    journal.format_version !== 1 ||
    (journal.phase !== "replacing" && journal.phase !== "verified") ||
    !isAbsolute(journal.transaction_root) ||
    transactionRelative.startsWith("..") ||
    isAbsolute(transactionRelative) ||
    dirname(journal.transaction_root) !== vault ||
    !basename(journal.transaction_root).startsWith(".kataskeue-") ||
    journal.target_obsidian !== join(vault, ".obsidian")
  ) {
    throw new ReplacementError(
      "transaction journal contains paths outside the target vault",
    );
  }
  for (const name of managedNames) {
    if (typeof journal.original?.[name] !== "boolean") {
      throw new ReplacementError(
        "transaction journal has an invalid original-state map",
      );
    }
  }
}

async function writeJournal(
  path: string,
  journal: TransactionJournal,
): Promise<void> {
  const temporary = `${path}.new`;
  await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`);
  await rename(temporary, path);
}

function journalLocation(vault: string): string {
  return join(vault, ".kataskeue-transaction.json");
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
