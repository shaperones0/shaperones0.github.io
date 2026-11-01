// Finds task packages: published by ID, inside a link, or from a file the student has.
import { loadStoredTask, saveStoredTask } from "../workspaces";
import { isValidTaskId, parsePackage, type Task } from "./package";

const TASKS_PATH = `${import.meta.env.BASE_URL}tasks/`;

export class TaskNotFoundError extends Error {}

export function decodeLinkPackage(encoded: string) {
  const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Keeps whichever version is newer, so an old link can't downgrade a task that has been fixed.
async function remember(incoming: Task): Promise<Task> {
  const { id, version } = incoming.manifest;
  const stored = await loadStoredTask(id).catch(() => undefined);
  const task = stored && stored.version > version ? parsePackage(stored.bytes) : incoming;
  await saveStoredTask({ id, version: task.manifest.version, bytes: task.bytes, openedAt: Date.now() }).catch(() => {});
  return task;
}

export function loadFromBytes(bytes: Uint8Array<ArrayBuffer>) {
  return remember(parsePackage(bytes));
}

// The site's copy wins when reachable, so fixes arrive; the stored copy works offline.
export async function loadById(id: string) {
  if (!isValidTaskId(id)) throw new TaskNotFoundError();
  let response: Response | null = null;
  try {
    response = await fetch(`${TASKS_PATH}${id}.pytask`, { cache: "no-cache" });
  } catch {}
  if (response?.ok) return loadFromBytes(new Uint8Array(await response.arrayBuffer()));
  const stored = await loadStoredTask(id).catch(() => undefined);
  if (!stored) throw new TaskNotFoundError();
  return parsePackage(stored.bytes);
}

// What the student pasted: an ID, a link by ID, or a link carrying the package itself.
export function parseTaskReference(text: string): { id: string } | { encoded: string } | null {
  const value = text.trim();
  const inHash = /[#&]pkg=([A-Za-z0-9_-]+)/.exec(value);
  if (inHash) return { encoded: inHash[1] };
  const inQuery = /[?&]task=([a-z0-9_-]+)/.exec(value);
  if (inQuery) return { id: inQuery[1] };
  return isValidTaskId(value) ? { id: value } : null;
}
