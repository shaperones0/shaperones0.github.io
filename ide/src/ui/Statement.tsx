import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n";
import { showToast } from "../session";
import { language } from "../settings";
import { loadGroupTests } from "../tasks/check";
import { localized, type Task, type TestCase } from "../tasks/package";
import { renderStatement, testsTableWithButtons, type Labels, type RenderMath } from "./markdown";

const COPIED_MS = 1500;
const CHECK_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M6.2 11.6 2.6 8l-1.1 1.1 4.7 4.7 8.3-8.3-1.1-1.1z"/></svg>';

const labels = (): Labels => ({ input: t("exampleInput"), output: t("exampleOutput"), copy: t("copy") });

let mathLoader: Promise<RenderMath> | null = null;

// Null if it can't load, for example offline. Formulas then stay as plain text.
function loadMath(): Promise<RenderMath | null> {
  mathLoader ??= import("./math").then((module) => module.renderMath);
  return mathLoader.catch(() => {
    mathLoader = null;
    return null;
  });
}

async function copyBlock(button: HTMLElement) {
  const code = button.parentElement?.querySelector("code");
  if (!code) return;
  try {
    await navigator.clipboard.writeText((code.textContent ?? "").replace(/\n$/, ""));
  } catch {
    showToast(t("copyFailed"));
    return;
  }
  const original = button.innerHTML;
  button.dataset.copied = "true";
  button.innerHTML = CHECK_ICON;
  setTimeout(() => {
    delete button.dataset.copied;
    button.innerHTML = original;
  }, COPIED_MS);
}

function ClosedExamples({ task }: { task: Task }) {
  const [groups, setGroups] = useState<{ name: string; collapsed: boolean; tests: TestCase[] }[]>([]);
  useEffect(() => {
    let current = true;
    (async () => {
      const shown = [];
      for (const [index, group] of task.groups.entries()) {
        if (group.inline || (group.display !== "listed" && group.display !== "collapsed")) continue;
        shown.push({ name: group.name, collapsed: group.display === "collapsed", tests: await loadGroupTests(task, index) });
      }
      if (current) setGroups(shown);
    })().catch(() => {});
    return () => {
      current = false;
    };
  }, [task]);

  return (
    <>
      {groups.map((group) => {
        const table = <div dangerouslySetInnerHTML={{ __html: testsTableWithButtons(group.tests, labels()) }} />;
        return group.collapsed ? (
          <details key={group.name} class="test-group">
            <summary>{t("moreTests", { count: group.tests.length })}</summary>
            {table}
          </details>
        ) : (
          <div key={group.name} class="test-group">{table}</div>
        );
      })}
    </>
  );
}

export function Statement({ task }: { task: Task }) {
  const lang = language.value;
  const source = task.statements[lang] ?? task.statements.ru ?? task.statements.en ?? "";
  const [html, setHtml] = useState("");

  useEffect(() => {
    let current = true;
    (async () => {
      const renderMath = source.includes("$") ? await loadMath() : null;
      if (current) setHtml(renderStatement(task, source, labels(), renderMath));
    })();
    return () => {
      current = false;
    };
  }, [task, source, lang]);

  const onClick = (event: MouseEvent) => {
    const button = (event.target as Element).closest<HTMLElement>(".copy-button");
    if (button && !button.dataset.copied) copyBlock(button);
  };

  return (
    <article class="statement" onClick={onClick}>
      <h1>{localized(task.manifest.title, lang)}</h1>
      <div dangerouslySetInnerHTML={{ __html: html }} />
      <ClosedExamples task={task} />
    </article>
  );
}
