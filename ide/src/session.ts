// Ties the open workspaces to the editor, the console and the interpreter.
import { computed, signal } from "@preact/signals";
import { strToU8, zipSync } from "fflate";
import { FileTooLargeError, readCodeFile, saveToDisk } from "./disk";
import { t } from "./i18n";
import { downloadRuntime, takeInterpreter, warmUp, warmUpWhenIdle } from "./runtime/pool";
import type { Interpreter, RunResult } from "./runtime/run";
import { language } from "./settings";
import { runChecks, type CheckHandle, type CheckProgress } from "./tasks/check";
import { decodeLinkPackage, loadById, loadFromBytes, parseTaskReference, TaskNotFoundError } from "./tasks/loader";
import { hasTests, localized, NewerFormatError, parsePackage, starterWorkspaceFiles, type Task } from "./tasks/package";
import type { CodeEditor } from "./ui/editor";
import type { Terminal } from "./ui/terminal";
import {
  forgetTask,
  listStoredTasks,
  loadStoredTask,
  loadWorkspace,
  newWorkspace,
  saveWorkspace,
  SCRATCH_ID,
  workspaceIdForTask,
  type Workspace,
} from "./workspaces";

const AUTOSAVE_DELAY_MS = 300;
const TOAST_MS = 4000;
const TABS_KEY = "ide-tabs";
const ACTIVE_KEY = "ide-active";
const TASK_PREFIX = "task:";
const LEVEL = 1;

export type RunState = "idle" | "starting" | "running" | "checking";
export interface RecentTask {
  id: string;
  title: string;
}

export const canRun = window.crossOriginIsolated;
export const runState = signal<RunState>("idle");
export const downloadProgress = signal<number | null>(null);
export const consoleUsed = signal(false);
export const fileName = signal("main.py");
export const toast = signal<string | null>(null);
export const runWaitMs = signal<number | null>(null);
export const activeId = signal(SCRATCH_ID);
export const openTaskIds = signal<string[]>([]);
export const tasksById = signal<Record<string, Task>>({});
export const recentTasks = signal<RecentTask[]>([]);
export const levelBlock = signal<{ title: string; minLevel: number } | null>(null);
export const checkProgress = signal<CheckProgress | null>(null);

export const activeTask = computed(() => {
  const id = activeId.value;
  return id.startsWith(TASK_PREFIX) ? tasksById.value[id.slice(TASK_PREFIX.length)] ?? null : null;
});
export const activeTaskHasTests = computed(() => (activeTask.value ? hasTests(activeTask.value) : false));

let workspace: Workspace = newWorkspace(SCRATCH_ID);
let editor: CodeEditor;
let terminal: Terminal;
let active: Interpreter | null = null;
let activeCheck: CheckHandle | null = null;
let runtimeReady: Promise<void> | null = null;
let saveTimer = 0;
let lastSavedAt = 0;
let hasUnsavedEdit = false;
let diskHandle: FileSystemFileHandle | null = null;
let persistRequested = false;
let storageFailureShown = false;
let toastTimer = 0;
let startCancelled = false;
let views: { onRunStarted(): void; onCheckStarted(): void; onTaskOpened(): void };
// Kept per workspace for this page visit, so switching tabs doesn't lose a report.
const checkResults = new Map<string, CheckProgress>();

function readJson<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "") as T;
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

export function showToast(message: string) {
  toast.value = message;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.value = null), TOAST_MS);
}

function setActiveInUrl(taskId: string | null) {
  const url = new URL(location.href);
  url.hash = "";
  if (taskId) url.searchParams.set("task", taskId);
  else url.searchParams.delete("task");
  history.replaceState(history.state, "", url);
}

function rememberTabs() {
  writeStorage(TABS_KEY, JSON.stringify(openTaskIds.value));
  writeStorage(ACTIVE_KEY, JSON.stringify(activeId.value));
}

export async function refreshRecent() {
  try {
    const stored = await listStoredTasks();
    recentTasks.value = stored
      .filter((entry) => !openTaskIds.value.includes(entry.id))
      .sort((a, b) => b.openedAt - a.openedAt)
      .map((entry) => ({ id: entry.id, title: localized(parsePackage(entry.bytes).manifest.title, language.peek()) }));
  } catch {
    recentTasks.value = [];
  }
}

// Returns the code to show first. Tabs reopen from storage; a link in the address opens after.
export async function loadInitialWorkspace() {
  const restored: Record<string, Task> = {};
  for (const id of readJson<string[]>(TABS_KEY, [])) {
    const stored = await loadStoredTask(id).catch(() => undefined);
    if (stored) restored[id] = parsePackage(stored.bytes);
  }
  tasksById.value = restored;
  openTaskIds.value = Object.keys(restored);

  try {
    const lastActive = readJson<string>(ACTIVE_KEY, SCRATCH_ID);
    const isOpenTask = lastActive.startsWith(TASK_PREFIX) && restored[lastActive.slice(TASK_PREFIX.length)];
    const id = isOpenTask ? lastActive : SCRATCH_ID;
    workspace = (await loadWorkspace(id)) ?? createWorkspace(id);
    lastSavedAt = workspace.updatedAt;
    activeId.value = id;
  } catch {
    showToast(t("storageUnavailable"));
  }
  fileName.value = workspace.entry;
  return { id: workspace.id, code: workspace.files[workspace.entry] ?? "" };
}

function createWorkspace(id: string): Workspace {
  if (id === SCRATCH_ID) return newWorkspace(SCRATCH_ID);
  const taskId = id.slice(TASK_PREFIX.length);
  const { entry, files } = starterWorkspaceFiles(tasksById.value[taskId]);
  return { id, taskId, entry, files, updatedAt: 0 };
}

export function attach(attached: { editor: CodeEditor; terminal: Terminal; onRunStarted(): void; onCheckStarted(): void; onTaskOpened(): void }) {
  editor = attached.editor;
  terminal = attached.terminal;
  views = attached;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSave();
    else adoptNewerSave();
  });
  addEventListener("pagehide", flushSave);
  if (canRun) prepareRuntime().catch(() => {});
  refreshRecent();

  // Read before anything rewrites the address.
  const encoded = /[#&]pkg=([A-Za-z0-9_-]+)/.exec(location.hash)?.[1];
  const taskId = new URLSearchParams(location.search).get("task");
  setActiveInUrl(activeTask.value?.manifest.id ?? null);
  if (encoded) openTaskFrom(() => loadFromBytes(decodeLinkPackage(encoded)));
  else if (taskId) openTaskFrom(() => loadById(taskId));
}

async function openTaskFrom(load: () => Promise<Task>) {
  try {
    openLoadedTask(await load());
  } catch (error) {
    if (error instanceof NewerFormatError) showToast(t("taskNewerFormat"));
    else if (error instanceof TaskNotFoundError) showToast(t("taskNotFound"));
    else showToast(t("taskBroken"));
  }
}

function openLoadedTask(task: Task) {
  const { id, minLevel, title } = task.manifest;
  if (minLevel > LEVEL) {
    levelBlock.value = { title: localized(title, language.peek()), minLevel };
    return;
  }
  tasksById.value = { ...tasksById.value, [id]: task };
  if (!openTaskIds.value.includes(id)) openTaskIds.value = [...openTaskIds.value, id];
  switchWorkspace(workspaceIdForTask(id)).then(() => views.onTaskOpened());
  refreshRecent();
}

export async function openTaskFile(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return openTaskFrom(() => loadFromBytes(bytes));
}

// Returns false if the text isn't a task reference at all.
export function openTaskReference(text: string) {
  const reference = parseTaskReference(text);
  if (!reference) return false;
  if ("encoded" in reference) openTaskFrom(async () => loadFromBytes(decodeLinkPackage(reference.encoded)));
  else openTaskFrom(() => loadById(reference.id));
  return true;
}

export async function switchWorkspace(id: string) {
  if (id !== workspace.id) {
    cancelActivity();
    await flushSave();
    let next: Workspace;
    try {
      next = (await loadWorkspace(id)) ?? createWorkspace(id);
    } catch {
      next = createWorkspace(id);
      showToast(t("storageUnavailable"));
    }
    workspace = next;
    lastSavedAt = next.updatedAt;
    diskHandle = null;
    activeId.value = id;
    fileName.value = next.entry;
    editor.showDocument(id, next.files[next.entry] ?? "");
    terminal.clear();
    checkProgress.value = checkResults.get(id) ?? null;
  }
  setActiveInUrl(workspace.taskId ?? null);
  rememberTabs();
}

export function closeTask(taskId: string) {
  const wasActive = activeId.value === workspaceIdForTask(taskId);
  openTaskIds.value = openTaskIds.value.filter((id) => id !== taskId);
  rememberTabs();
  if (wasActive) switchWorkspace(SCRATCH_ID);
  refreshRecent();
}

export async function reopenTask(taskId: string) {
  const stored = await loadStoredTask(taskId);
  if (stored) openLoadedTask(parsePackage(stored.bytes));
}

export async function deleteRecentTask(taskId: string) {
  await forgetTask(taskId);
  refreshRecent();
}

export function resetToStarter() {
  const task = activeTask.value;
  if (!task) return;
  const { entry, files } = starterWorkspaceFiles(task);
  editor.replaceCode(files[entry] ?? "");
  showToast(t("resetDone"));
}

function prepareRuntime() {
  runtimeReady ??= downloadRuntime((fraction) => (downloadProgress.value = fraction))
    .then(() => {
      warmUp();
    })
    .catch((error) => {
      runtimeReady = null;
      throw error;
    })
    .finally(() => (downloadProgress.value = null));
  return runtimeReady;
}

export function codeChanged(code: string) {
  workspace.files[workspace.entry] = code;
  hasUnsavedEdit = true;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flushSave, AUTOSAVE_DELAY_MS);
}

function flushSave() {
  clearTimeout(saveTimer);
  if (!hasUnsavedEdit) return Promise.resolve();
  hasUnsavedEdit = false;
  workspace.updatedAt = lastSavedAt = Date.now();
  return saveWorkspace(workspace).catch(() => {
    if (storageFailureShown) return;
    storageFailureShown = true;
    showToast(t("storageUnavailable"));
  });
}

// With the site open in two tabs, the tab being used takes over the other tab's latest code.
async function adoptNewerSave() {
  const saved = await loadWorkspace(workspace.id).catch(() => undefined);
  if (!saved || saved.updatedAt <= lastSavedAt || hasUnsavedEdit) return;
  workspace = saved;
  lastSavedAt = saved.updatedAt;
  fileName.value = saved.entry;
  diskHandle = null;
  editor.replaceCode(saved.files[saved.entry] ?? "");
  hasUnsavedEdit = false;
}

export async function saveInBrowser() {
  hasUnsavedEdit = true;
  await flushSave();
  if (!storageFailureShown) showToast(t("savedInBrowser"));
}

function zipFiles(files: Record<string, string>) {
  const entries = Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)]));
  return new Blob([zipSync(entries) as Uint8Array<ArrayBuffer>], { type: "application/zip" });
}

// One file saves under its own name. Several go in a zip named after the task, names untouched.
export async function saveFile() {
  await flushSave();
  const isSingle = Object.keys(workspace.files).length === 1;
  const baseName = activeTask.value?.manifest.name ?? workspace.entry.replace(/\.py$/, "");
  try {
    const content = isSingle ? editor.code : zipFiles({ ...workspace.files, [workspace.entry]: editor.code });
    const saved = await saveToDisk(isSingle ? workspace.entry : `${baseName}.zip`, content, diskHandle);
    if (!saved) return;
    diskHandle = saved.handle;
    if (isSingle && !workspace.taskId && saved.name !== workspace.entry) renameEntry(saved.name, { keepHandle: true });
    showToast(t("savedToDisk", { name: saved.name }));
  } catch {
    showToast(t("saveFailed"));
  }
}

export async function openFile(file: File) {
  if (file.name.toLowerCase().endsWith(".pytask")) return openTaskFile(file);
  try {
    const opened = await readCodeFile(file);
    editor.replaceCode(opened.text.replace(/^﻿/, ""));
    if (!workspace.taskId) renameEntry(opened.name.endsWith(".py") ? opened.name : "main.py");
    showToast(t(opened.encoding === "utf-8" ? "opened" : "openedCp1251", { name: opened.name }));
  } catch (error) {
    showToast(t(error instanceof FileTooLargeError ? "fileTooLarge" : "fileFailed"));
  }
}

export function cleanFileName(name: string) {
  const cleaned = name.trim().replace(/[/\\:*?"<>|]/g, "").replace(/^\.+/, "");
  if (!cleaned) return null;
  return cleaned.endsWith(".py") ? cleaned : `${cleaned}.py`;
}

export function renameEntry(name: string, { keepHandle = false } = {}) {
  if (name === workspace.entry) return;
  const { [workspace.entry]: code = "", ...others } = workspace.files;
  workspace.files = { ...others, [name]: code };
  workspace.entry = name;
  fileName.value = name;
  if (!keepHandle) diskHandle = null;
  hasUnsavedEdit = true;
  flushSave();
}

function describeResult(result: RunResult) {
  if (result.kind === "exit") return result.stopped ? t("stopped") : t("exited", { status: result.status });
  if (result.kind === "killed") return t("stopped");
  return t("crashed");
}

function requestPersistence() {
  if (persistRequested) return;
  persistRequested = true;
  navigator.storage?.persist?.().catch(() => {});
}

function cancelActivity() {
  active?.kill();
  activeCheck?.cancel();
  startCancelled = true;
}

export async function run() {
  if (!canRun) return;
  if (activeCheck) {
    activeCheck.cancel();
    await activeCheck.finished;
  }
  if (active) {
    active.kill();
    await active.finished;
  }
  // The button changes before anything slow, so a quick second press can't restart the program.
  consoleUsed.value = true;
  runState.value = "starting";
  views.onRunStarted();
  terminal.clear();
  startCancelled = false;
  await flushSave();
  requestPersistence();

  editor.showErrorLine(null);
  const startedAt = performance.now();

  try {
    await prepareRuntime();
  } catch {
    terminal.writeStatus(t("downloadFailed"));
    runState.value = "idle";
    return;
  }
  if (startCancelled) {
    terminal.writeStatus(t("stopped"));
    runState.value = "idle";
    return;
  }

  // Taken before anything async, so a second press can't grab the same interpreter.
  const interpreter = takeInterpreter();
  active = interpreter;
  const entry = workspace.entry;
  const files = { ...workspace.files, [entry]: editor.code };

  terminal.setInputEnabled(true);
  const finished = interpreter.start(
    { entry, files },
    {
      onOutput: (text, stream) => terminal.writeOutput(text, stream),
      onInputRequest: () => terminal.focusInput(),
      onStarted: () => {
        runState.value = "running";
      },
    },
  );

  await interpreter.booted;
  runWaitMs.value = performance.now() - startedAt;

  const result = await finished;
  interpreter.dispose();
  // Booted only now, so that a spare doesn't compete with the student's program for the CPU.
  warmUpWhenIdle();
  if (active !== interpreter) return;
  active = null;
  runState.value = "idle";
  terminal.setInputEnabled(false);
  terminal.writeStatus(describeResult(result));
  if (result.kind === "exit") editor.showErrorLine(result.errorLine);
}

export async function check() {
  const task = activeTask.value;
  if (!canRun || !task || runState.value !== "idle") return;
  const id = workspace.id;
  runState.value = "checking";
  checkProgress.value = { done: 0, total: 0, results: [] };
  views.onCheckStarted();
  editor.showErrorLine(null);
  startCancelled = false;
  await flushSave();
  try {
    await prepareRuntime();
  } catch {
    showToast(t("downloadFailed"));
    runState.value = "idle";
    return;
  }
  if (startCancelled) {
    checkProgress.value = checkResults.get(id) ?? null;
    runState.value = "idle";
    return;
  }

  const handle = runChecks(task, { ...workspace.files, [workspace.entry]: editor.code }, workspace.entry, (progress) => {
    if (workspace.id === id) checkProgress.value = progress;
  });
  activeCheck = handle;
  const report = await handle.finished.catch(() => {
    showToast(t("taskBroken"));
    return null;
  });
  activeCheck = null;
  if (report) checkResults.set(id, report);
  if (!report && workspace.id === id) checkProgress.value = checkResults.get(id) ?? null;
  runState.value = "idle";
  warmUpWhenIdle();
}

export function stop() {
  if (activeCheck) activeCheck.cancel();
  else if (active) active.stop();
  else startCancelled = true;
}

export function sendInputLine(line: string) {
  active?.sendLine(line);
}

export function sendEof() {
  active?.sendEof();
}

export function heapMb() {
  return active?.heapMb ?? null;
}
