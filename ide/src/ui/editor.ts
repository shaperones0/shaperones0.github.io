// Level 1's editor: CodeMirror behaving like IDLE, with no completion on purpose.
import { defaultKeymap, history, historyKeymap, indentLess, indentMore, insertNewlineAndIndent, isolateHistory } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { bracketMatching, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { gotoLine, highlightSelectionMatches, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorSelection, EditorState, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";

const INDENT = 4;
const DEDENT_KEYWORDS = /^\s*(return|pass|break|continue|raise)\b/;

// IDLE's colors, read from CSS so that they follow the theme.
export const highlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword, tags.bool, tags.null, tags.self], color: "var(--syntax-keyword)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--syntax-string)" },
  { tag: tags.comment, color: "var(--syntax-comment)" },
  { tag: tags.function(tags.definition(tags.variableName)), color: "var(--syntax-definition)" },
  { tag: tags.definition(tags.className), color: "var(--syntax-definition)" },
  { tag: tags.function(tags.variableName), color: "var(--syntax-call)" },
  { tag: tags.number, color: "var(--syntax-number)" },
]);

const setErrorLine = StateEffect.define<number | null>();
const errorLineMark = Decoration.line({ class: "cm-errorLine" });

// Marks the line a program failed on, until the code changes.
const errorLineField = StateField.define({
  create: () => Decoration.none,
  update(decorations, transaction) {
    if (transaction.docChanged) return Decoration.none;
    for (const effect of transaction.effects) {
      if (effect.is(setErrorLine)) {
        const line = effect.value;
        const valid = line !== null && line >= 1 && line <= transaction.state.doc.lines;
        return valid ? Decoration.set(errorLineMark.range(transaction.state.doc.line(line).from)) : Decoration.none;
      }
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function smartEnter(view: EditorView) {
  const { state } = view;
  const { main } = state.selection;
  const line = state.doc.lineAt(main.head);
  const isAtLineEnd = main.empty && !line.text.slice(main.head - line.from).trim();
  if (state.selection.ranges.length > 1 || !isAtLineEnd || !DEDENT_KEYWORDS.test(line.text)) {
    return insertNewlineAndIndent(view);
  }
  const indent = line.text.length - line.text.trimStart().length;
  const insert = "\n" + " ".repeat(Math.max(indent - INDENT, 0));
  view.dispatch({
    changes: { from: main.head, to: line.to, insert },
    selection: { anchor: main.head + insert.length },
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}

function smartTab(view: EditorView) {
  const { state } = view;
  if (state.selection.ranges.some((range) => !range.empty)) return indentMore(view);
  view.dispatch(
    state.changeByRange((range) => {
      const column = range.head - state.doc.lineAt(range.head).from;
      const insert = " ".repeat(INDENT - (column % INDENT));
      return {
        changes: { from: range.head, insert },
        range: EditorSelection.cursor(range.head + insert.length),
      };
    }),
    { scrollIntoView: true, userEvent: "input" },
  );
  return true;
}

// In leading spaces, Backspace removes a whole indent level.
function smartBackspace(view: EditorView) {
  const { state } = view;
  const { main } = state.selection;
  if (state.selection.ranges.length > 1 || !main.empty) return false;
  const line = state.doc.lineAt(main.head);
  const before = line.text.slice(0, main.head - line.from);
  if (!before || before.trim()) return false;
  const remove = before.length % INDENT || INDENT;
  view.dispatch({
    changes: { from: main.head - remove, to: main.head },
    scrollIntoView: true,
    userEvent: "delete.backward",
  });
  return true;
}

function selectedLines(doc: Text, state: EditorState) {
  const numbers = new Set<number>();
  for (const range of state.selection.ranges) {
    const last = doc.lineAt(range.to);
    const end = range.empty || range.to > last.from ? last.number : last.number - 1;
    for (let number = doc.lineAt(range.from).number; number <= end; number++) numbers.add(number);
  }
  return [...numbers].map((number) => doc.line(number));
}

function commentRegion(view: EditorView) {
  const changes = selectedLines(view.state.doc, view.state).map((line) => ({ from: line.from, insert: "##" }));
  view.dispatch({ changes, userEvent: "input" });
  return true;
}

function uncommentRegion(view: EditorView) {
  const changes = selectedLines(view.state.doc, view.state).flatMap((line) => {
    const match = /^(\s*)(##?)/.exec(line.text);
    if (!match) return [];
    const from = line.from + match[1].length;
    return [{ from, to: from + match[2].length }];
  });
  view.dispatch({ changes, userEvent: "delete" });
  return true;
}

export interface EditorOptions {
  parent: HTMLElement;
  documentId: string;
  code: string;
  language: string;
  phrases: Record<string, Record<string, string>>;
  wrapLines: boolean;
  label: string;
  onChange(code: string): void;
  onFocusChange(focused: boolean): void;
}

export class CodeEditor {
  private view: EditorView;
  private phrases = new Compartment();
  private allPhrases: Record<string, Record<string, string>>;
  private extensions: Extension[];
  private documentId: string;
  private language: string;
  private states = new Map<string, EditorState>();

  constructor(options: EditorOptions) {
    this.allPhrases = options.phrases;
    this.documentId = options.documentId;
    this.language = options.language;
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      history(),
      indentOnInput(),
      indentUnit.of(" ".repeat(INDENT)),
      EditorState.tabSize.of(INDENT),
      bracketMatching(),
      python(),
      syntaxHighlighting(highlightStyle),
      search(),
      highlightSelectionMatches(),
      errorLineField,
      this.phrases.of(EditorState.phrases.of(options.phrases[options.language])),
      keymap.of([
        { key: "Enter", run: smartEnter },
        { key: "Tab", run: smartTab, shift: indentLess },
        { key: "Backspace", run: smartBackspace },
        { key: "Mod-]", run: indentMore },
        { key: "Mod-[", run: indentLess },
        { key: "Alt-3", run: commentRegion },
        { key: "Alt-4", run: uncommentRegion },
        { key: "Mod-h", run: openSearchPanel },
        { key: "Alt-g", run: gotoLine },
        ...searchKeymap,
        ...historyKeymap,
        ...defaultKeymap,
      ]),
      EditorView.contentAttributes.of({
        spellcheck: "false",
        autocorrect: "off",
        autocapitalize: "off",
        "aria-label": options.label,
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) options.onChange(update.state.doc.toString());
        if (update.focusChanged) options.onFocusChange(update.view.hasFocus);
      }),
    ];
    if (options.wrapLines) extensions.push(EditorView.lineWrapping);
    this.extensions = extensions;

    this.view = new EditorView({ parent: options.parent, state: EditorState.create({ doc: options.code, extensions }) });
  }

  // Keeps each workspace's undo history for this visit, unless its code changed elsewhere.
  showDocument(id: string, code: string) {
    this.states.set(this.documentId, this.view.state);
    const known = this.states.get(id);
    this.view.setState(known?.doc.toString() === code ? known : EditorState.create({ doc: code, extensions: this.extensions }));
    this.documentId = id;
    this.setLanguage(this.language);
  }

  get code() {
    return this.view.state.doc.toString();
  }

  // Replaces the text as its own undo step, so Ctrl+Z brings exactly the old code back.
  replaceCode(code: string) {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: code },
      annotations: isolateHistory.of("full"),
    });
  }

  setLanguage(language: string) {
    this.language = language;
    this.view.dispatch({ effects: this.phrases.reconfigure(EditorState.phrases.of(this.allPhrases[language])) });
  }

  showErrorLine(line: number | null) {
    const effects: StateEffect<unknown>[] = [setErrorLine.of(line)];
    if (line !== null && line >= 1 && line <= this.view.state.doc.lines) {
      effects.push(EditorView.scrollIntoView(this.view.state.doc.line(line).from, { y: "center" }));
    }
    this.view.dispatch({ effects });
  }

  focus() {
    this.view.focus();
  }

  // Used by the on-screen key bar.
  insert(text: string) {
    this.view.dispatch(this.view.state.replaceSelection(text), { scrollIntoView: true, userEvent: "input" });
  }

  indent() {
    smartTab(this.view);
  }

  dedent() {
    indentLess(this.view);
  }
}
