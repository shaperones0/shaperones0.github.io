// Turns a task statement into safe HTML: math, highlighted code and tables of test examples.
import { pythonLanguage } from "@codemirror/lang-python";
import { highlightCode } from "@lezer/highlight";
import DOMPurify from "dompurify";
import { Marked, type Token, type Tokens } from "marked";
import type { Task, TestCase } from "../tasks/package";
import { highlightStyle } from "./editor";

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

const COPY_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M5 1.5A1.5 1.5 0 0 1 6.5 0h7A1.5 1.5 0 0 1 15 1.5v9a1.5 1.5 0 0 1-1.5 1.5H12v-1.5h1.5v-9h-7V3H5V1.5ZM2.5 4h7A1.5 1.5 0 0 1 11 5.5v9A1.5 1.5 0 0 1 9.5 16h-7A1.5 1.5 0 0 1 1 14.5v-9A1.5 1.5 0 0 1 2.5 4Zm0 1.5v9h7v-9h-7Z"/></svg>';

export type RenderMath = (tex: string, displayMode: boolean) => string;

export interface Labels {
  input: string;
  output: string;
  copy: string;
}

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

export function testsTableHtml(tests: Pick<TestCase, "input" | "output">[], labels: Labels) {
  const cell = (text: string) => `<td><pre><code>${escapeHtml(text.replace(/\n$/, ""))}</code></pre></td>`;
  const rows = tests.map((test) => `<tr>${cell(test.input)}${cell(test.output ?? "")}</tr>`).join("");
  return `<table class="tests-table"><thead><tr><th>${escapeHtml(labels.input)}</th><th>${escapeHtml(labels.output)}</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function parseTestFence(text: string) {
  const [input, output = ""] = text.split(/^---[ \t]*$/m);
  return { input: input.replace(/\n$/, ""), output: output.replace(/^\n/, "") };
}

const isTestFence = (token: Token): token is Tokens.Code => token.type === "code" && (token as Tokens.Code).lang?.trim() === "test";

// Test blocks that follow one another become rows of a single table.
function mergeTestFences(tokens: Token[], labels: Labels) {
  const merged: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!isTestFence(tokens[i])) {
      merged.push(tokens[i]);
      continue;
    }
    const run = [tokens[i] as Tokens.Code];
    while (true) {
      const gap = tokens[i + 1]?.type === "space" ? 1 : 0;
      const next = tokens[i + 1 + gap];
      if (!next || !isTestFence(next)) break;
      run.push(next);
      i += 1 + gap;
    }
    const html = testsTableHtml(run.map((fence) => parseTestFence(fence.text)), labels);
    merged.push({ type: "html", block: true, raw: html, text: html, pre: false } as Tokens.HTML);
  }
  return merged;
}

function codeBlockHtml(code: string, language: string) {
  let html = "";
  const putText = (text: string, classes: string) => {
    html += classes ? `<span class="${classes}">${escapeHtml(text)}</span>` : escapeHtml(text);
  };
  const putBreak = () => {
    html += "\n";
  };
  if (language === "python" || language === "py") {
    highlightCode(code, pythonLanguage.parser.parse(code), highlightStyle, putText, putBreak);
  } else {
    html = escapeHtml(code);
  }
  const lineCount = code.split("\n").length;
  // Numbers sit in their own unselectable column, so that selecting or copying skips them.
  const numbers = Array.from({ length: lineCount }, (_, index) => index + 1).join("\n");
  const gutter = lineCount > 1 ? `<span class="code-numbers" aria-hidden="true">${numbers}</span>` : "";
  return `<pre class="code-block">${gutter}<code>${html}</code></pre>`;
}

// Inline math can't touch spaces at its edges, so "costs $5 or $6" stays plain text.
const INLINE_MATH = /^\$(?!\s)((?:\\.|[^$\\\n`])*?(?:\\.|[^\s$\\`]))\$(?!\d)/;
const BLOCK_MATH = /^\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/;
const INLINE_DISPLAY_MATH = /^\$\$((?:\\.|[^$\\])+?)\$\$/;
// Where the Markdown parser should stop to try math. A block only starts a line: stopping at
// every dollar would split paragraphs there and rejoin them with line breaks.
const BLOCK_MATH_START = /(^|\n)\$\$/;
const INLINE_MATH_START = /(^|[^\\])\$/;

function createMarked(renderMath: RenderMath | null) {
  const marked = new Marked({
    renderer: {
      code({ text, lang }) {
        return codeBlockHtml(text, lang?.trim().split(/\s+/)[0].toLowerCase() ?? "");
      },
    },
  });
  if (!renderMath) return marked;
  const math = (name: string, level: "block" | "inline", pattern: RegExp, start: RegExp, displayMode: boolean) => ({
    name,
    level,
    start: (source: string) => {
      const found = start.exec(source);
      return found ? found.index + found[1].length : undefined;
    },
    tokenizer(source: string) {
      const match = pattern.exec(source);
      return match ? { type: name, raw: match[0], tex: match[1].trim() } : undefined;
    },
    renderer: (token: Tokens.Generic) => renderMath(token.tex, displayMode),
  });
  marked.use({
    extensions: [
      math("mathBlock", "block", BLOCK_MATH, BLOCK_MATH_START, true),
      math("mathDisplay", "inline", INLINE_DISPLAY_MATH, INLINE_MATH_START, true),
      math("mathInline", "inline", INLINE_MATH, INLINE_MATH_START, false),
    ],
  });
  return marked;
}

export function addCopyButtons(root: ParentNode, label: string) {
  for (const pre of root.querySelectorAll("pre")) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "copy-button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.innerHTML = COPY_ICON;
    pre.append(button);
  }
}

export function renderStatement(task: Task, source: string, labels: Labels, renderMath: RenderMath | null) {
  const marked = createMarked(renderMath);
  const tokens = mergeTestFences(marked.lexer(source), labels);
  const html = marked.parser(tokens);
  const clean = DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true });

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
  addCopyButtons(clean, labels.copy);
  const holder = document.createElement("div");
  holder.append(clean);
  return holder.innerHTML;
}

export function testsTableWithButtons(tests: TestCase[], labels: Labels) {
  const holder = document.createElement("div");
  holder.innerHTML = testsTableHtml(tests, labels);
  addCopyButtons(holder, labels.copy);
  return holder.innerHTML;
}
