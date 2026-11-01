// Keeps one interpreter booted ahead of time, so pressing Run doesn't wait for a boot.
import { PYODIDE_PATH } from "./layout";
import { Interpreter } from "./run";

// Decompressed sizes, used because progress is counted after the browser unpacks each file.
const RUNTIME_FILES: Record<string, number> = {
  "pyodide.mjs": 17931,
  "pyodide-lock.json": 119077,
  "pyodide.asm.mjs": 1250344,
  "pyodide.asm.wasm": 9598218,
  "python_stdlib.zip": 2545637,
};

async function isCached(file: string) {
  return Boolean(await caches.match(new URL(PYODIDE_PATH + file, location.origin).href));
}

// Downloads the runtime while reporting progress. The service worker keeps each file, so the
// interpreter then finds them cached. Does nothing noticeable on later visits.
export async function downloadRuntime(onProgress: (fraction: number) => void) {
  const files = Object.keys(RUNTIME_FILES);
  const cached = await Promise.all(files.map(isCached));
  const missing = files.filter((_, i) => !cached[i]);
  if (!missing.length) return;
  onProgress(0);

  const total = missing.reduce((sum, file) => sum + RUNTIME_FILES[file], 0);
  let received = 0;
  await Promise.all(
    missing.map(async (file) => {
      const response = await fetch(PYODIDE_PATH + file);
      if (!response.ok || !response.body) throw new Error(`${file}: HTTP ${response.status}`);
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        onProgress(Math.min(received / total, 1));
      }
    }),
  );
}

let spare: Interpreter | null = null;

export function warmUp() {
  if (spare) return;
  const interpreter = new Interpreter();
  spare = interpreter;
  // A spare that dies on its own is replaced when the next program asks for one.
  interpreter.finished.then(() => {
    if (spare === interpreter) spare = null;
  });
}

export function warmUpWhenIdle() {
  if ("requestIdleCallback" in window) requestIdleCallback(warmUp, { timeout: 2000 });
  else setTimeout(warmUp, 500);
}

export function takeInterpreter() {
  const interpreter = spare ?? new Interpreter();
  spare = null;
  return interpreter;
}
