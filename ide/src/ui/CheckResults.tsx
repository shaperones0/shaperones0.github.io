import { t } from "../i18n";
import { checkProgress, runState } from "../session";
import type { TestResult, Verdict } from "../tasks/check";

const VERDICT_KEY = {
  passed: "verdictPassed",
  wrong: "verdictWrong",
  error: "verdictError",
  timeout: "verdictTimeout",
  crash: "verdictCrash",
  "too-much-output": "verdictTooMuchOutput",
  "check-failed": "verdictCheckFailed",
} as const satisfies Record<Verdict, string>;

function Detail({ label, text }: { label: string; text?: string }) {
  if (text === undefined || text === "") return null;
  return (
    <div class="result-detail">
      <div class="example-label">{label}</div>
      <pre>{text}</pre>
    </div>
  );
}

function ResultRow({ result, number }: { result: TestResult; number: number }) {
  const passed = result.verdict === "passed";
  const hasDetails = result.input !== undefined;
  const summary = (
    <>
      <span class={passed ? "mark-pass" : "mark-fail"} aria-hidden="true">{passed ? "✓" : "✗"}</span>
      {" "}
      {t(result.display === "hidden" || result.display === "on-fail" ? "testClosed" : "testNumber", { number })}
      {": "}
      {t(VERDICT_KEY[result.verdict])}
    </>
  );
  if (!hasDetails) return <li class="result">{summary}</li>;
  return (
    <li class="result">
      <details open={!passed}>
        <summary>{summary}</summary>
        <Detail label={t("exampleInput")} text={result.input} />
        <Detail label={t("resultExpected")} text={result.expected} />
        <Detail label={t("resultActual")} text={result.actual} />
        <Detail label={t("resultErrors")} text={result.errors} />
      </details>
    </li>
  );
}

export function CheckResults() {
  const progress = checkProgress.value;
  if (!progress) return <div class="check-results empty">{t("checkEmpty")}</div>;
  const { done, total, results } = progress;
  const running = runState.value === "checking";
  const passed = results.filter((result) => result.verdict === "passed").length;
  const allPassed = !running && total > 0 && passed === total;
  return (
    <div class="check-results">
      <p class={`check-summary ${allPassed ? "all-passed" : ""}`} role="status">
        {running ? t("checkRunning", { done, total }) : allPassed ? t("checkAllPassed", { total }) : t("checkSome", { passed, total })}
      </p>
      <ol class="results">
        {results.map((result, index) => (
          <ResultRow key={index} result={result} number={index + 1} />
        ))}
      </ol>
    </div>
  );
}
