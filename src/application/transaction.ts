import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { requireFileFormat } from "../domain/fileFormat.js";
import { ReplacementError } from "../errors.js";
import type { ReplaceOperations } from "../ports.js";
import {
  formerPlaces,
  stateFolderOf,
  statePlaces,
  type StatePlaces,
} from "./stateFolder.js";

const managedNames = [
  "plugins",
  "community-plugins.json",
  "plugin-installation.json",
] as const;
type ManagedName = (typeof managedNames)[number];

/** Identifier that the transaction journal declares in `_schema`. */
const JOURNAL_FORMAT = "kataskeue:transaction@1";

interface TransactionJournal {
  readonly _schema: typeof JOURNAL_FORMAT;
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

/**
 * Replace managed paths while retaining a durable rollback journal.
 *
 * The journal lies at `journalPath`, in the state folder that also holds `transactionRoot`.
 */
export async function replaceManagedState(
  stagedObsidian: string,
  targetObsidian: string,
  transactionRoot: string,
  journalPath: string,
  operations: ReplaceOperations = defaultOperations,
): Promise<ManagedStateTransaction> {
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
    _schema: JOURNAL_FORMAT,
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

/**
 * Restore a transaction that ended before resulting-state verification.
 *
 * The journal of the state folder (`.kataskeue/` in the vault by default) is recovered, and so is a
 * journal that an earlier release left at the root of the vault. A run of the current release
 * recovers the former journal before it writes its own. Therefore, when both exist, the former
 * journal records the later transaction, and it is rolled back first.
 */
export async function recoverIncompleteTransaction(
  vaultPath: string,
  stateFolder?: string,
): Promise<boolean> {
  const vault = resolve(vaultPath);
  const former = await recoverJournal(vault, formerPlaces(vault));
  const current = await recoverJournal(
    vault,
    statePlaces(stateFolderOf(vault, stateFolder)),
  );
  return former || current;
}

async function recoverJournal(
  vault: string,
  places: StatePlaces,
): Promise<boolean> {
  const journalPath = places.journal;
  if (!(await exists(journalPath))) {
    return false;
  }
  const content: unknown = JSON.parse(await readFile(journalPath, "utf8"));
  requireFileFormat(
    content,
    JOURNAL_FORMAT,
    `transaction journal ${journalPath}`,
  );
  const journal = content as TransactionJournal;
  validateJournal(vault, places, journal);
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

/** Require the transaction root in the folder of the journal and the target in the vault. */
function validateJournal(
  vault: string,
  places: StatePlaces,
  journal: TransactionJournal,
): void {
  const root = journal.transaction_root;
  if (
    (journal.phase !== "replacing" && journal.phase !== "verified") ||
    typeof root !== "string" ||
    !isAbsolute(root) ||
    dirname(root) !== places.folder ||
    !root.startsWith(places.transactionPrefix) ||
    root.length === places.transactionPrefix.length ||
    journal.target_obsidian !== join(vault, ".obsidian")
  ) {
    throw new ReplacementError(
      `transaction journal ${places.journal} contains paths outside its state folder or the target vault`,
    );
  }
  for (const name of managedNames) {
    if (typeof journal.original?.[name] !== "boolean") {
      throw new ReplacementError(
        `transaction journal ${places.journal} has an invalid original-state map`,
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
