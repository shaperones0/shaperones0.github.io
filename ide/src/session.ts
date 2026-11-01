// Ties one workspace to the editor, the console and the interpreter.
import { signal } from "@preact/signals";
import { FileTooLargeError, readCodeFile, saveToDisk } from "./disk";
import { t } from "./i18n";
import { downloadRuntime, takeInterpreter, warmUp, warmUpWhenIdle } from "./runtime/pool";
import type { Interpreter, RunResult } from "./runtime/run";
import type { CodeEditor } from "./ui/editor";
import type { Terminal } from "./ui/terminal";
import { loadWorkspace, newWorkspace, saveWorkspace, SCRATCH_ID, type Workspace } from "./workspaces";

const AUTOSAVE_DELAY_MS = 300;
const TOAST_MS = 4000;

export type RunState = "idle" | "starting" | "running";

export const canRun = window.crossOriginIsolated;
export const runState = signal<RunState>("idle");
export const downloadProgress = signal<number | null>(null);
export const consoleUsed = signal(false);
export const fileName = signal("main.py");
export const toast = signal<string | null>(null);
export const runWaitMs = signal<number | null>(null);

let workspace: Workspace = newWorkspace(SCRATCH_ID);
let editor: CodeEditor;
let terminal: Terminal;
let active: Interpreter | null = null;
let runtimeReady: Promise<void> | null = null;
let saveTimer = 0;
let lastSavedAt = 0;
let hasUnsavedEdit = false;
let diskHandle: FileSystemFileHandle | null = null;
let persistRequested = false;
let storageFailureShown = false;
let toastTimer = 0;
let onRunStarted: () => void = () => {};
let startCancelled = false;

export function showToast(message: string) {
  toast.value = message;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.value = null), TOAST_MS);
}

export async function loadInitialWorkspace() {
  try {
    workspace = (await loadWorkspace(SCRATCH_ID)) ?? workspace;
    lastSavedAt = workspace.updatedAt;
  } catch {
    showToast(t("storageUnavailable"));
  }
  fileName.value = workspace.entry;
  return workspace.files[workspace.entry] ?? "";
}

export function attach(views: { editor: CodeEditor; terminal: Terminal; onRunStarted(): void }) {
  editor = views.editor;
  terminal = views.terminal;
  onRunStarted = views.onRunStarted;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushSave();
    else adoptNewerSave();
  });
  addEventListener("pagehide", flushSave);
  if (canRun) prepareRuntime().catch(() => {});
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

export async function saveFile() {
  await flushSave();
  try {
    const saved = await saveToDisk(workspace.entry, editor.code, diskHandle);
    if (!saved) return;
    diskHandle = saved.handle;
    if (saved.name !== workspace.entry) renameEntry(saved.name, { keepHandle: true });
    showToast(t("savedToDisk", { name: saved.name }));
  } catch {
    showToast(t("saveFailed"));
  }
}

export async function openFile(file: File) {
  try {
    const opened = await readCodeFile(file);
    editor.replaceCode(opened.text.replace(/^﻿/, ""));
    renameEntry(opened.name.endsWith(".py") ? opened.name : "main.py");
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

export async function run() {
  if (!canRun) return;
  if (active) {
    active.kill();
    await active.finished;
  }
  // The button changes before anything slow, so a quick second press can't restart the program.
  consoleUsed.value = true;
  runState.value = "starting";
  onRunStarted();
  terminal.clear();
  await flushSave();
  if (!persistRequested) {
    persistRequested = true;
    navigator.storage?.persist?.().catch(() => {});
  }

  editor.showErrorLine(null);
  const startedAt = performance.now();
  startCancelled = false;

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
  interpreter.start(
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

  const result = await interpreter.finished;
  // Booted only now, so that a spare doesn't compete with the student's program for the CPU.
  warmUpWhenIdle();
  if (active !== interpreter) return;
  active = null;
  runState.value = "idle";
  terminal.setInputEnabled(false);
  terminal.writeStatus(describeResult(result));
  if (result.kind === "exit") editor.showErrorLine(result.errorLine);
}

export function stop() {
  if (active) active.stop();
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
