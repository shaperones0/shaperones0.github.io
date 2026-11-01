// Reads a .pytask package: a zip built by tools/pytask.py.
import { unzipSync } from "fflate";
import type { Comparison } from "./protect";

const FORMAT = 1;
const MAX_UNPACKED_BYTES = 128 * 1024 * 1024;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export type Display = "listed" | "collapsed" | "on-fail" | "hidden";
export type Protection = "plain" | "obfuscated" | "hashed";
export type Localized = string | { ru?: string; en?: string };

export interface TestCase {
  input: string;
  output?: string;
  outputHash?: string;
  files?: Record<string, string>;
  expectFiles?: Record<string, string>;
  expectFileHashes?: Record<string, string>;
}

export interface TestGroup {
  name: string;
  display: Display;
  protection: Protection;
  inline?: boolean;
  tests?: TestCase[];
  sealed?: string;
}

export interface Manifest {
  format: number;
  id: string;
  version: number;
  name?: string;
  title: Localized;
  minLevel: number;
  usesFiles: boolean;
  comparison: Comparison;
  tolerance?: number;
  timeLimit: number;
}

export interface Task {
  manifest: Manifest;
  groups: TestGroup[];
  statements: { ru?: string; en?: string };
  assets: Map<string, Uint8Array<ArrayBuffer>>;
  starter: Record<string, string>;
  sealedCheck?: string;
  bytes: Uint8Array<ArrayBuffer>;
}

export class TaskFormatError extends Error {}
export class NewerFormatError extends Error {}

export const isValidTaskId = (id: string) => ID_PATTERN.test(id);

export function localized(value: Localized, language: "ru" | "en") {
  if (typeof value === "string") return value;
  return value[language] ?? value.ru ?? value.en ?? "";
}

export function parsePackage(bytes: Uint8Array<ArrayBuffer>): Task {
  let files: Record<string, Uint8Array>;
  try {
    let total = 0;
    files = unzipSync(bytes, {
      filter(file) {
        total += file.originalSize;
        if (total > MAX_UNPACKED_BYTES) throw new TaskFormatError("package too large");
        return !file.name.endsWith("/");
      },
    });
  } catch {
    throw new TaskFormatError("not a zip");
  }
  const text = (name: string) => (files[name] ? new TextDecoder().decode(files[name]) : undefined);

  let manifest: Manifest;
  let groups: TestGroup[];
  try {
    manifest = JSON.parse(text("manifest.json") ?? "");
    groups = JSON.parse(text("tests.json") ?? "[]");
  } catch {
    throw new TaskFormatError("bad manifest");
  }
  if (manifest.format > FORMAT) throw new NewerFormatError();
  if (manifest.format !== FORMAT || !isValidTaskId(manifest.id) || !Number.isInteger(manifest.version) || !Array.isArray(groups)) {
    throw new TaskFormatError("bad manifest");
  }

  const statements = { ru: text("statement.ru.md"), en: text("statement.en.md") };
  if (!statements.ru && !statements.en) throw new TaskFormatError("no statement");

  const assets = new Map<string, Uint8Array<ArrayBuffer>>();
  const starter: Record<string, string> = {};
  for (const [name, data] of Object.entries(files)) {
    if (name.startsWith("assets/")) assets.set(name, data as Uint8Array<ArrayBuffer>);
    if (name.startsWith("starter/")) starter[name.slice("starter/".length)] = new TextDecoder().decode(data);
  }
  return { manifest, groups, statements, assets, starter, sealedCheck: text("check.sealed"), bytes };
}

export function hasTests(task: Task) {
  return task.groups.some((group) => group.sealed || group.tests?.length);
}

// A lone program takes the task's suggested name; with several files it stays main.py.
export function starterWorkspaceFiles(task: Task) {
  const files: Record<string, string> = { "main.py": "", ...task.starter };
  const names = Object.keys(files);
  const { name } = task.manifest;
  if (names.length > 1 || !name) return { entry: "main.py", files };
  const entry = `${name}.py`;
  return { entry, files: { [entry]: files["main.py"] } };
}
