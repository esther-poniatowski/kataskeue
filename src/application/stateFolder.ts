import { mkdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";

import { StateFolderError } from "../errors.js";

/** Name of the default state folder, at the root of the vault. */
export const DEFAULT_STATE_FOLDER = ".kataskeue";

/** Places of the files that only Kataskeue reads. */
export interface StatePlaces {
  /** Folder that holds the lock, the journal and the transaction roots. */
  readonly folder: string;
  /** Lock held by a command for the whole check or change. */
  readonly lock: string;
  /** Journal of an interrupted replacement. */
  readonly journal: string;
  /** Prefix of each transaction root, completed by a random suffix. */
  readonly transactionPrefix: string;
}

/** Return the places inside one state folder. */
export function statePlaces(folder: string): StatePlaces {
  const absolute = resolve(folder);
  return {
    folder: absolute,
    lock: join(absolute, "vault.lock"),
    journal: join(absolute, "transaction.json"),
    transactionPrefix: join(absolute, "transaction-"),
  };
}

/**
 * Return the places that releases before the state folder used, at the root of the vault.
 *
 * A lock or a journal left there by an interrupted run must still be honoured.
 */
export function formerPlaces(vault: string): StatePlaces {
  const absolute = resolve(vault);
  return {
    folder: absolute,
    lock: join(absolute, ".kataskeue.lock"),
    journal: join(absolute, ".kataskeue-transaction.json"),
    transactionPrefix: join(absolute, ".kataskeue-"),
  };
}

/** Return the state folder of a vault: the folder named, or `.kataskeue/` in the vault. */
export function stateFolderOf(vault: string, folder?: string): string {
  return resolve(folder ?? join(vault, DEFAULT_STATE_FOLDER));
}

/**
 * Check the state folder of a vault, create it, and return its places.
 *
 * A replacement renames each managed path between a transaction root and `.obsidian/`, and a
 * rename is atomic only within one file system. Therefore, the folder must lie on the file
 * system of `.obsidian/`. The check runs before the folder is created, on its nearest existing
 * ancestor, so that a rejected folder leaves nothing behind. The folder must not be the vault,
 * whose root would then show the state, nor lie in `.obsidian/`, whose managed paths the
 * replacement moves.
 */
export async function prepareStateFolder(
  vault: string,
  folder: string,
): Promise<StatePlaces> {
  const places = statePlaces(folder);
  const absoluteVault = resolve(vault);
  const obsidian = join(absoluteVault, ".obsidian");
  if (places.folder === absoluteVault) {
    throw new StateFolderError(
      `the state folder cannot be the vault itself: ${places.folder}`,
    );
  }
  const withinObsidian = relative(obsidian, places.folder);
  if (
    withinObsidian === "" ||
    (!withinObsidian.startsWith("..") && !isAbsolute(withinObsidian))
  ) {
    throw new StateFolderError(
      `the state folder cannot lie in ${obsidian}: ${places.folder}`,
    );
  }
  const target = (await existingDevice(obsidian)) ?? (await deviceOf(vault));
  const ancestor = await nearestExisting(places.folder);
  const device = await deviceOf(ancestor);
  if (device !== target) {
    throw new StateFolderError(
      `the state folder must lie on the file system of the vault, so that a rename into ${obsidian} stays atomic: ${places.folder}`,
    );
  }
  await mkdir(places.folder, { recursive: true });
  return places;
}

async function nearestExisting(path: string): Promise<string> {
  let current = path;
  for (;;) {
    if ((await existingDevice(current)) !== undefined) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
}

async function deviceOf(path: string): Promise<number> {
  return (await stat(path)).dev;
}

async function existingDevice(path: string): Promise<number | undefined> {
  try {
    return await deviceOf(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return undefined;
    }
    throw error;
  }
}
