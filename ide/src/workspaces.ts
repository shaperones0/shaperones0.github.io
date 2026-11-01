// Student code and opened tasks in IndexedDB. Scratch and tasks are the same kind of workspace.
export const SCRATCH_ID = "scratch";
const DB_NAME = "ide";
const WORKSPACES = "workspaces";
const TASKS = "tasks";

export interface Workspace {
  id: string;
  entry: string;
  files: Record<string, string>;
  updatedAt: number;
  taskId?: string;
}

export interface StoredTask {
  id: string;
  version: number;
  bytes: Uint8Array<ArrayBuffer>;
  openedAt: number;
}

export const workspaceIdForTask = (taskId: string) => `task:${taskId}`;

export function newWorkspace(id: string, entry = "main.py", code = ""): Workspace {
  return { id, entry, files: { [entry]: code }, updatedAt: 0 };
}

let database: Promise<IDBDatabase> | null = null;

function openDatabase() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(WORKSPACES)) db.createObjectStore(WORKSPACES, { keyPath: "id" });
      if (!db.objectStoreNames.contains(TASKS)) db.createObjectStore(TASKS, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}

function done<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function store(name: string, mode: IDBTransactionMode = "readonly") {
  return (await openDatabase()).transaction(name, mode).objectStore(name);
}

export async function loadWorkspace(id: string): Promise<Workspace | undefined> {
  return done((await store(WORKSPACES)).get(id));
}

export async function saveWorkspace(workspace: Workspace) {
  await done((await store(WORKSPACES, "readwrite")).put(workspace));
}

export async function loadStoredTask(id: string): Promise<StoredTask | undefined> {
  return done((await store(TASKS)).get(id));
}

export async function saveStoredTask(task: StoredTask) {
  await done((await store(TASKS, "readwrite")).put(task));
}

export async function listStoredTasks(): Promise<StoredTask[]> {
  return done((await store(TASKS)).getAll());
}

export async function forgetTask(id: string) {
  await done((await store(TASKS, "readwrite")).delete(id));
  await done((await store(WORKSPACES, "readwrite")).delete(workspaceIdForTask(id)));
}
