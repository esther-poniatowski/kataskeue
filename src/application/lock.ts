import { randomUUID } from "node:crypto";
import { access, open, readFile, unlink } from "node:fs/promises";

import { OperationLockedError } from "../errors.js";
import { formerPlaces, type StatePlaces } from "./stateFolder.js";

interface LockOwner {
  readonly pid: number;
  readonly token: string;
}

/**
 * Serialize recovery and state inspection for one vault.
 *
 * The lock lies in the state folder. A lock that an earlier release left at the root of the vault
 * blocks the command too, since a run of that release may still be changing the vault.
 */
export async function withVaultLock<T>(
  vault: string,
  places: StatePlaces,
  task: () => Promise<T>,
): Promise<T> {
  await rejectFormerLock(formerPlaces(vault).lock);
  const path = places.lock;
  const owner: LockOwner = { pid: process.pid, token: randomUUID() };
  await acquire(path, owner);
  try {
    return await task();
  } finally {
    await release(path, owner);
  }
}

async function rejectFormerLock(path: string): Promise<void> {
  try {
    await access(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  throw new OperationLockedError(
    `a vault lock of an earlier release exists at its former place; confirm that no materializer command is running before removing it: ${path}`,
  );
}

async function acquire(path: string, owner: LockOwner): Promise<void> {
  let handle;
  try {
    handle = await open(path, "wx");
  } catch (error) {
    if (hasCode(error, "EEXIST")) {
      throw new OperationLockedError(
        `a vault lock already exists; confirm that no materializer command is running before removing it: ${path}`,
      );
    }
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`);
  } catch (error) {
    await handle.close();
    await unlink(path);
    throw error;
  }
  await handle.close();
}

async function release(path: string, owner: LockOwner): Promise<void> {
  const current = await readOwner(path);
  if (current?.token !== owner.token) {
    throw new OperationLockedError(`vault lock ownership changed: ${path}`);
  }
  await unlink(path);
}

async function readOwner(path: string): Promise<LockOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (
      typeof value === "object" &&
      value !== null &&
      "pid" in value &&
      Number.isInteger(value.pid) &&
      (value.pid as number) > 0 &&
      "token" in value &&
      typeof value.token === "string"
    ) {
      return { pid: value.pid as number, token: value.token };
    }
    return undefined;
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return undefined;
    }
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
