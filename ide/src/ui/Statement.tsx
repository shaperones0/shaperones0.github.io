import DOMPurify from "dompurify";
import { Marked } from "marked";
import { useEffect, useMemo, useState } from "preact/hooks";
import { t } from "../i18n";
import { language } from "../settings";
import { loadGroupTests } from "../tasks/check";
import { localized, type Task, type TestCase } from "../tasks/package";

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

const imageUrls = new WeakMap<Task, Map<string, string>>();

function imageUrl(task: Task, path: string) {
  let urls = imageUrls.get(task);
  if (!urls) imageUrls.set(task, (urls = new Map()));
  const name = path.replace(/^\.\//, "");
  if (!urls.has(name)) {
    const bytes = task.assets.get(name);
    const type = IMAGE_TYPES[name.split(".").pop()!.toLowerCase()];
    if (!bytes || !type) return null;
    urls.set(name, URL.createObjectURL(new Blob([bytes], { type })));
  }
  return urls.get(name)!;
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!);

function exampleHtml(input: string, output: string) {
  return `<div class="example">
    <div><div class="example-label">${escapeHtml(t("exampleInput"))}</div><pre><code>${escapeHtml(input)}</code></pre></div>
    <div><div class="example-label">${escapeHtml(t("exampleOutput"))}</div><pre><code>${escapeHtml(output)}</code></pre></div>
  </div>`;
}

function renderMarkdown(task: Task, source: string) {
  const marked = new Marked({
    renderer: {
      code({ text, lang }) {
        if (lang?.trim() !== "test") return false;
        const [input, output = ""] = text.split(/^---[ \t]*$/m);
        return exampleHtml(input.replace(/\n$/, ""), output.replace(/^\n/, ""));
      },
    },
  });
  const clean = DOMPurify.sanitize(marked.parse(source, { async: false }), { RETURN_DOM_FRAGMENT: true });

  // Only images inside the package load, which also keeps a statement from calling out to anywhere.
  for (const image of clean.querySelectorAll("img")) {
    const url = imageUrl(task, image.getAttribute("src") ?? "");
    if (url) {
      image.src = url;
      image.draggable = false;
    } else {
      image.remove();
    }
  }
  for (const link of clean.querySelectorAll("a")) {
    if (/^https?:/i.test(link.getAttribute("href") ?? "")) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    } else {
      link.removeAttribute("href");
    }
  }
  const holder = document.createElement("div");
  holder.append(clean);
  return holder.innerHTML;
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
        const examples = group.tests.map((test, index) => (
          <div key={index} dangerouslySetInnerHTML={{ __html: exampleHtml(test.input, test.output ?? "") }} />
        ));
        return group.collapsed ? (
          <details key={group.name} class="test-group">
            <summary>{t("moreTests", { count: group.tests.length })}</summary>
            {examples}
          </details>
        ) : (
          <div key={group.name} class="test-group">{examples}</div>
        );
      })}
    </>
  );
}

export function Statement({ task }: { task: Task }) {
  const lang = language.value;
  const source = task.statements[lang] ?? task.statements.ru ?? task.statements.en ?? "";
  const html = useMemo(() => renderMarkdown(task, source), [task, source, lang]);
  return (
    <article class="statement">
      <h1>{localized(task.manifest.title, lang)}</h1>
      <div dangerouslySetInnerHTML={{ __html: html }} />
      <ClosedExamples task={task} />
    </article>
  );
}
