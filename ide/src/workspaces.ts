// Student code in IndexedDB. Scratch and tasks are all the same kind of workspace.
export const SCRATCH_ID = "scratch";
const DB_NAME = "ide";
const STORE = "workspaces";

export interface Workspace {
  id: string;
  entry: string;
  files: Record<string, string>;
  updatedAt: number;
}

export function newWorkspace(id: string, entry = "main.py", code = ""): Workspace {
  return { id, entry, files: { [entry]: code }, updatedAt: 0 };
}

let database: Promise<IDBDatabase> | null = null;

function openDatabase() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
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

export async function loadWorkspace(id: string): Promise<Workspace | undefined> {
  const db = await openDatabase();
  return done(db.transaction(STORE).objectStore(STORE).get(id));
}

export async function saveWorkspace(workspace: Workspace) {
  const db = await openDatabase();
  await done(db.transaction(STORE, "readwrite").objectStore(STORE).put(workspace));
}
