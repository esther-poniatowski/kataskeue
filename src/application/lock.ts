import { randomUUID } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import { OperationLockedError } from "../errors.js";

interface LockOwner {
  readonly pid: number;
  readonly token: string;
}

/** Serialize recovery and state inspection for one vault. */
export async function withVaultLock<T>(
  vault: string,
  task: () => Promise<T>,
): Promise<T> {
  const path = join(vault, ".kataskeue.lock");
  const owner: LockOwner = { pid: process.pid, token: randomUUID() };
  await acquire(path, owner);
  try {
    return await task();
  } finally {
    await release(path, owner);
  }
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
