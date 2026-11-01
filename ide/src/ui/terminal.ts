// The console: program output, plus an input field that sits right after the last output,
// so a typed answer appears next to its prompt in green italic.
import { STREAM_STDERR } from "../runtime/layout";

const MAX_CHUNK_CHARS = 64 * 1024;
const MAX_TOTAL_CHARS = 2 * 1024 * 1024;

export type TextKind = "stdout" | "stderr" | "stdin" | "meta";

export interface TerminalOptions {
  parent: HTMLElement;
  label: string;
  onLine(line: string): void;
  onEof(): void;
  onInterrupt(): void;
}

export class Terminal {
  readonly element = document.createElement("div");
  private output = document.createElement("span");
  private field = document.createElement("input");
  private lastChunk: { kind: TextKind; node: Text } | null = null;
  private totalChars = 0;

  constructor(private options: TerminalOptions) {
    this.element.className = "terminal";
    this.element.setAttribute("role", "log");
    this.field.className = "terminal-input";
    this.field.type = "text";
    this.field.hidden = true;
    this.field.setAttribute("aria-label", options.label);
    for (const [name, value] of Object.entries({ autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false", enterkeyhint: "send" })) {
      this.field.setAttribute(name, value);
    }
    this.field.addEventListener("keydown", (event) => this.onKeyDown(event));
    this.field.addEventListener("input", () => this.fitField());
    this.field.addEventListener("paste", (event) => this.onPaste(event));
    this.element.append(this.output, this.field);
    this.element.addEventListener("click", () => {
      if (!this.field.hidden && !getSelection()?.toString()) this.field.focus();
    });
    options.parent.append(this.element);
  }

  private onKeyDown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      this.submit(this.field.value);
    } else if (event.ctrlKey && event.code === "KeyD") {
      event.preventDefault();
      this.options.onEof();
    } else if (event.ctrlKey && event.code === "KeyC" && !this.field.selectionEnd) {
      event.preventDefault();
      this.options.onInterrupt();
    }
  }

  // Pasting several lines answers one input() per line, and leaves the last one to edit.
  private onPaste(event: ClipboardEvent) {
    const text = event.clipboardData?.getData("text") ?? "";
    if (!text.includes("\n")) return;
    event.preventDefault();
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const last = lines.pop()!;
    lines[0] = this.field.value + lines[0];
    lines.forEach((line) => this.submit(line));
    this.field.value = last;
    this.fitField();
  }

  private submit(line: string) {
    this.field.value = "";
    this.fitField();
    this.write(line + "\n", "stdin");
    this.options.onLine(line);
  }

  private fitField() {
    this.field.style.width = `${Math.max(this.field.value.length + 2, 3)}ch`;
    this.scrollToEnd();
  }

  private scrollToEnd() {
    this.element.scrollTop = this.element.scrollHeight;
  }

  write(text: string, kind: TextKind) {
    if (!text) return;
    const stickToEnd = this.element.scrollHeight - this.element.scrollTop - this.element.clientHeight < 40;
    if (this.lastChunk?.kind === kind && this.lastChunk.node.length < MAX_CHUNK_CHARS) {
      this.lastChunk.node.appendData(text);
    } else {
      const span = document.createElement("span");
      span.className = `terminal-${kind}`;
      const node = document.createTextNode(text);
      span.append(node);
      this.output.append(span);
      this.lastChunk = { kind, node };
    }
    this.totalChars += text.length;
    while (this.totalChars > MAX_TOTAL_CHARS && this.output.firstChild !== this.output.lastChild) {
      const oldest = this.output.firstChild!;
      this.totalChars -= oldest.textContent!.length;
      oldest.remove();
    }
    if (stickToEnd) this.scrollToEnd();
  }

  writeOutput(text: string, stream: number) {
    this.write(text, stream === STREAM_STDERR ? "stderr" : "stdout");
  }

  // Writes a status line, starting on a fresh line if the program left one unfinished.
  writeStatus(text: string) {
    const unfinished = this.lastChunk && !this.lastChunk.node.data.endsWith("\n");
    this.write(`${unfinished ? "\n" : ""}${text}\n`, "meta");
  }

  clear() {
    this.output.replaceChildren();
    this.lastChunk = null;
    this.totalChars = 0;
  }

  setInputEnabled(enabled: boolean) {
    this.field.hidden = !enabled;
    if (!enabled) this.field.value = "";
    this.fitField();
  }

  focusInput() {
    if (!this.field.hidden) this.field.focus({ preventScroll: true });
    this.scrollToEnd();
  }

  get text() {
    return this.output.textContent ?? "";
  }
}
