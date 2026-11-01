// Runs a program against a task's tests. Expected outputs stay on the page and never reach the
// worker running student code, so the program can't read them through `import js`.
import { takeInterpreter } from "../runtime/pool";
import { STREAM_STDERR } from "../runtime/layout";
import type { Interpreter, RunResult } from "../runtime/run";
import type { Display, Task, TestCase, TestGroup } from "./package";
import { normalize, outputHash, outputsMatch, unseal } from "./protect";

const MAX_OUTPUT_CHARS = 16 * 1024 * 1024;
const encoder = new TextEncoder();

export type Verdict = "passed" | "wrong" | "error" | "timeout" | "crash" | "too-much-output";

export interface TestResult {
  group: string;
  display: Display;
  verdict: Verdict;
  // Only filled in where the group's display setting allows showing them.
  input?: string;
  expected?: string;
  actual?: string;
  errors?: string;
}

export interface CheckProgress {
  done: number;
  total: number;
  results: TestResult[];
}

export interface CheckHandle {
  cancel(): void;
  finished: Promise<CheckProgress | null>;
}

export async function loadGroupTests(task: Task, index: number): Promise<TestCase[]> {
  const group: TestGroup = task.groups[index];
  if (group.tests) return group.tests;
  return unseal<TestCase[]>(task.manifest.id, index, group.sealed!);
}

interface Attempt {
  result: RunResult | { kind: "timeout" } | { kind: "too-much-output" };
  stdout: string;
  stderr: string;
}

function runOnce(
  interpreter: Interpreter,
  files: Record<string, string>,
  entry: string,
  test: TestCase,
  timeLimitMs: number,
): Promise<Attempt> {
  let stdout = "";
  let stderr = "";
  let timer = 0;
  let cut: "timeout" | "too-much-output" | null = null;
  const collect = Object.keys(test.expectFiles ?? test.expectFileHashes ?? {});
  const end = (reason: "timeout" | "too-much-output") => {
    cut = reason;
    interpreter.kill();
  };
  return interpreter
    .start(
      { entry, files: { ...files, ...test.files }, stdin: encoder.encode(test.input) as Uint8Array<ArrayBuffer>, collect },
      {
        onOutput(text, stream) {
          if (stream === STREAM_STDERR) {
            stderr = (stderr + text).slice(-8000);
            return;
          }
          stdout += text;
          if (stdout.length > MAX_OUTPUT_CHARS) end("too-much-output");
        },
        onInputRequest() {},
        // Package loading doesn't count against the program's time.
        onStarted() {
          timer = window.setTimeout(() => end("timeout"), timeLimitMs);
        },
      },
    )
    .then((result) => {
      clearTimeout(timer);
      return { result: cut ? { kind: cut } : result, stdout, stderr };
    });
}

async function outputIsCorrect(task: Task, position: string, test: TestCase, attempt: Attempt, produced: Record<string, string | null>) {
  const { id, comparison, tolerance } = task.manifest;
  const matches = async (actual: string, expected: string | undefined, hash: string | undefined, where: string) => {
    if (expected !== undefined) return outputsMatch(comparison, actual, expected, tolerance);
    return (await outputHash(id, where, normalize(comparison, actual))) === hash;
  };
  if (test.output !== undefined || test.outputHash !== undefined) {
    if (!(await matches(attempt.stdout, test.output, test.outputHash, position))) return false;
  }
  for (const name of Object.keys(test.expectFiles ?? test.expectFileHashes ?? {})) {
    const actual = produced[name];
    if (actual === null || actual === undefined) return false;
    if (!(await matches(actual, test.expectFiles?.[name], test.expectFileHashes?.[name], `${position}:${name}`))) return false;
  }
  return true;
}

function verdictOf(attempt: Attempt, correct: boolean): Verdict {
  const { result } = attempt;
  if (result.kind === "timeout" || result.kind === "too-much-output") return result.kind;
  if (result.kind === "crash" || result.kind === "killed") return "crash";
  if (result.status !== 0) return "error";
  return correct ? "passed" : "wrong";
}

function revealed(group: TestGroup, test: TestCase, attempt: Attempt, verdict: Verdict, alreadyShown: boolean) {
  const details = {
    input: test.input,
    expected: test.output,
    actual: attempt.stdout.slice(0, 64 * 1024),
    errors: attempt.stderr,
  };
  if (group.display === "listed" || group.display === "collapsed") return details;
  if (group.display === "on-fail" && verdict !== "passed" && !alreadyShown) return details;
  return {};
}

export function runChecks(
  task: Task,
  files: Record<string, string>,
  entry: string,
  onProgress: (progress: CheckProgress) => void,
): CheckHandle {
  let cancelled = false;
  let interpreter: Interpreter | null = null;

  const work = async (): Promise<CheckProgress | null> => {
    const loaded = await Promise.all(task.groups.map((_, index) => loadGroupTests(task, index)));
    const total = loaded.reduce((sum, tests) => sum + tests.length, 0);
    const results: TestResult[] = [];
    onProgress({ done: 0, total, results: [] });

    for (const [groupIndex, tests] of loaded.entries()) {
      const group = task.groups[groupIndex];
      let shownFailure = false;
      for (const [testIndex, test] of tests.entries()) {
        if (cancelled) return null;
        // One interpreter serves many tests, since booting one for each takes minutes on a phone.
        interpreter ??= takeInterpreter();
        const current = interpreter;
        const attempt = await runOnce(current, files, entry, test, task.manifest.timeLimit * 1000);
        if (cancelled) return null;
        const produced = attempt.result.kind === "exit" ? attempt.result.files ?? {} : {};
        const correct = await outputIsCorrect(task, `${groupIndex}.${testIndex}`, test, attempt, produced);
        const verdict = verdictOf(attempt, correct);
        results.push({
          group: group.name,
          display: group.display,
          verdict,
          ...revealed(group, test, attempt, verdict, shownFailure),
        });
        if (verdict !== "passed") shownFailure = true;
        if (current.isDead) interpreter = null;
        onProgress({ done: results.length, total, results: [...results] });
      }
    }
    interpreter?.dispose();
    return { done: total, total, results };
  };

  return {
    cancel() {
      cancelled = true;
      interpreter?.kill();
    },
    finished: work(),
  };
}
