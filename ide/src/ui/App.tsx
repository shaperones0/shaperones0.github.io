import { useSignal, useSignalEffect } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { editorPhrases, t } from "../i18n";
import {
  activeTask,
  activeTaskHasTests,
  attach,
  canRun,
  check,
  checkProgress,
  cleanFileName,
  codeChanged,
  consoleUsed,
  downloadProgress,
  fileName,
  heapMb,
  levelBlock,
  openFile,
  renameEntry,
  resetToStarter,
  run,
  runState,
  runWaitMs,
  saveFile,
  saveInBrowser,
  sendEof,
  sendInputLine,
  showToast,
  stop,
  toast,
} from "../session";
import { cycleTheme, language, theme, toggleLanguage } from "../settings";
import { CheckResults } from "./CheckResults";
import { CodeEditor } from "./editor";
import { Statement } from "./Statement";
import { Terminal } from "./terminal";
import { OpenTaskDialog, WorkspaceCurtain, WorkspaceTabs } from "./Workspaces";

const NARROW_QUERY = "(max-width: 799px)";
const CONSOLE_HEIGHT_KEY = "ide-console-height";
const STATEMENT_WIDTH_KEY = "ide-statement-width";
const MIN_PANE_PX = 80;
const MIN_COLUMN_PX = 260;
const isTouch = matchMedia("(pointer: coarse)").matches;
const showDebug = new URLSearchParams(location.search).has("debug");

const KEY_BAR_KEYS = [":", "(", ")", "[", "]", "=", '"', "'", "+", "-", "*", "/", "<", ">", ",", ".", "#", "_"];

type NarrowView = "statement" | "code" | "console" | "check";
type BottomView = "console" | "check";

function safeRead(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeWrite(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function useMediaQuery(query: string) {
  const list = useRef(matchMedia(query)).current;
  const matches = useSignal(list.matches);
  useEffect(() => {
    const update = () => (matches.value = list.matches);
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, []);
  return matches;
}

// Follows the visible area, so the on-screen keyboard never covers the key bar or the input.
function useVisibleHeight() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      document.documentElement.style.setProperty("--app-height", `${viewport.height}px`);
      scrollTo(0, 0);
    };
    update();
    viewport.addEventListener("resize", update);
    return () => viewport.removeEventListener("resize", update);
  }, []);
}

// Open files by dropping them anywhere. Listens first, so the editor doesn't take the drop as text.
function useFileDrop() {
  const dragging = useSignal(false);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files");
    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth++;
      dragging.value = true;
    };
    const onOver = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    const onLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(depth - 1, 0);
      if (!depth) dragging.value = false;
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      depth = 0;
      dragging.value = false;
      const file = event.dataTransfer?.files[0];
      if (!file) return;
      if (/\.(pytask|py|pyw|txt)$/i.test(file.name)) openFile(file);
      else showToast(t("dropUnsupported"));
    };
    const listeners = { dragenter: onEnter, dragover: onOver, dragleave: onLeave, drop: onDrop };
    for (const [name, listener] of Object.entries(listeners)) addEventListener(name, listener as EventListener, true);
    return () => {
      for (const [name, listener] of Object.entries(listeners)) removeEventListener(name, listener as EventListener, true);
    };
  }, []);
  return dragging;
}

function FileName() {
  const editing = useSignal(false);
  const finish = (value: string | null) => {
    editing.value = false;
    const name = value === null ? null : cleanFileName(value);
    if (name) renameEntry(name);
  };
  // A task chose this name so that files stay findable, so students can't change it.
  if (activeTask.value) return <span class="file-name">{fileName.value}</span>;
  if (!editing.value) {
    return (
      <button class="file-name" title={t("rename")} onClick={() => (editing.value = true)}>
        {fileName.value}
      </button>
    );
  }
  return (
    <input
      class="file-name-input"
      aria-label={t("rename")}
      ref={(element) => {
        if (element && document.activeElement !== element) {
          element.focus();
          element.select();
        }
      }}
      value={fileName.value}
      autocapitalize="off"
      autocorrect="off"
      spellcheck={false}
      onBlur={(event) => finish(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          event.preventDefault();
          finish(null);
        }
      }}
    />
  );
}

function themeLabel() {
  return t(theme.value === "system" ? "themeSystem" : theme.value === "light" ? "themeLight" : "themeDark");
}

function FileActions({ onOpen, onOpenTask }: { onOpen(): void; onOpenTask(): void }) {
  return (
    <>
      <button onClick={onOpenTask}>{t("openTask")}</button>
      <button onClick={saveFile}>{t("save")}</button>
      <button onClick={onOpen}>{t("open")}</button>
      {activeTask.value && <button onClick={resetToStarter}>{t("resetToStarter")}</button>}
      <button onClick={cycleTheme}>{themeLabel()}</button>
      <button onClick={toggleLanguage}>{t("language")}</button>
    </>
  );
}

function KeyBar({ editor }: { editor: CodeEditor }) {
  // Acting on pointerdown and cancelling it keeps focus, and so the keyboard, in the editor.
  const press = (action: () => void) => ({
    onPointerDown: (event: PointerEvent) => {
      event.preventDefault();
      action();
    },
  });
  return (
    <div class="key-bar" role="toolbar">
      <button class="key-wide" aria-label="Tab" {...press(() => editor.indent())}>⇥</button>
      <button class="key-wide" aria-label="Shift+Tab" {...press(() => editor.dedent())}>⇤</button>
      {KEY_BAR_KEYS.map((key) => (
        <button key={key} {...press(() => editor.insert(key))}>{key}</button>
      ))}
    </div>
  );
}

function DebugLine() {
  const heap = useSignal<number | null>(null);
  const memory = useSignal<string>("");
  useEffect(() => {
    const timer = setInterval(() => (heap.value = heapMb()), 500);
    const measure = (performance as unknown as { measureUserAgentSpecificMemory?(): Promise<{ bytes: number }> }).measureUserAgentSpecificMemory;
    measure?.call(performance).then(({ bytes }) => (memory.value = `${Math.round(bytes / 1e6)} MB`)).catch(() => {});
    return () => clearInterval(timer);
  }, []);
  return (
    <div class="debug-line">
      {runWaitMs.value !== null ? `run wait ${Math.round(runWaitMs.value)} ms; ` : ""}
      {heap.value !== null ? `heap ${heap.value} MB; ` : ""}
      {memory.value ? `page memory ${memory.value}` : ""}
    </div>
  );
}

// Drags a pane's size with pointer capture, and saves the result.
function startDrag(event: PointerEvent, onMove: (move: PointerEvent) => void, onDone: () => void) {
  event.preventDefault();
  const handle = event.currentTarget as HTMLElement;
  handle.setPointerCapture(event.pointerId);
  const up = () => {
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", up);
    onDone();
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", up);
}

export function App({ initial }: { initial: { id: string; code: string } }) {
  useVisibleHeight();
  const dragging = useFileDrop();
  const isNarrow = useMediaQuery(NARROW_QUERY);
  const narrowView = useSignal<NarrowView>(activeTask.peek() ? "statement" : "code");
  const bottomView = useSignal<BottomView>("console");
  const bottomOpen = useSignal(false);
  const statementOpen = useSignal(true);
  const menuOpen = useSignal(false);
  const curtainOpen = useSignal(false);
  const taskDialogOpen = useSignal(false);
  const editorFocused = useSignal(false);
  const consoleHeight = useSignal(Number(safeRead(CONSOLE_HEIGHT_KEY)) || 240);
  const statementWidth = useSignal(Number(safeRead(STATEMENT_WIDTH_KEY)) || 0);
  const editorHost = useRef<HTMLDivElement>(null);
  const terminalHost = useRef<HTMLDivElement>(null);
  const editorRef = useRef<CodeEditor | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const editor = new CodeEditor({
      parent: editorHost.current!,
      documentId: initial.id,
      code: initial.code,
      language: language.peek(),
      phrases: editorPhrases,
      wrapLines: isTouch,
      label: t("editorLabel"),
      onChange: codeChanged,
      onFocusChange: (focused) => (editorFocused.value = focused),
    });
    editorRef.current = editor;
    const terminal = new Terminal({
      parent: terminalHost.current!,
      label: t("inputLabel"),
      onLine: sendInputLine,
      onEof: sendEof,
      onInterrupt: stop,
    });
    attach({
      editor,
      terminal,
      onRunStarted: () => {
        bottomOpen.value = true;
        bottomView.value = "console";
        narrowView.value = "console";
      },
      onCheckStarted: () => {
        bottomOpen.value = true;
        bottomView.value = "check";
        narrowView.value = "check";
      },
      onTaskOpened: () => {
        statementOpen.value = true;
        narrowView.value = "statement";
      },
    });
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (event.key === "F5") {
        event.preventDefault();
        run();
      } else if (mod && event.code === "KeyS") {
        event.preventDefault();
        if (event.shiftKey) saveFile();
        else saveInBrowser();
      } else if (mod && event.code === "KeyO") {
        event.preventDefault();
        fileInput.current?.click();
      }
    };
    addEventListener("keydown", onKeyDown);
    return () => removeEventListener("keydown", onKeyDown);
  }, []);

  useSignalEffect(() => {
    const current = language.value;
    editorRef.current?.setLanguage(current);
    document.title = `${fileName.value} — Python IDE`;
  });

  // A tab without its own content shouldn't stay selected after switching to Scratch.
  useSignalEffect(() => {
    if (!activeTask.value && narrowView.peek() === "statement") narrowView.value = "code";
    if (!activeTaskHasTests.value && narrowView.peek() === "check") narrowView.value = "console";
    if (!activeTaskHasTests.value && bottomView.peek() === "check") bottomView.value = "console";
  });

  const startConsoleResize = (event: PointerEvent) => {
    startDrag(
      event,
      (move) => {
        const bounds = columnRef.current!.getBoundingClientRect();
        consoleHeight.value = Math.min(Math.max(bounds.bottom - move.clientY, MIN_PANE_PX), bounds.height - MIN_PANE_PX);
      },
      () => safeWrite(CONSOLE_HEIGHT_KEY, String(Math.round(consoleHeight.value))),
    );
  };

  const startStatementResize = (event: PointerEvent) => {
    startDrag(
      event,
      (move) => {
        const bounds = layoutRef.current!.getBoundingClientRect();
        statementWidth.value = Math.min(Math.max(move.clientX - bounds.left, MIN_COLUMN_PX), bounds.width - MIN_COLUMN_PX);
      },
      () => safeWrite(STATEMENT_WIDTH_KEY, String(Math.round(statementWidth.value))),
    );
  };

  const narrow = isNarrow.value;
  const task = activeTask.value;
  const canCheck = activeTaskHasTests.value;
  const busy = runState.value !== "idle";
  const compactButtons = narrow && canCheck;
  const hasBottom = consoleUsed.value || checkProgress.value !== null;
  const showStatement = Boolean(task) && (narrow ? narrowView.value === "statement" : statementOpen.value);
  const showCode = !narrow || narrowView.value === "code";
  const showBottom = narrow ? narrowView.value === "console" || narrowView.value === "check" : hasBottom && bottomOpen.value;
  const shownBottomView: BottomView = narrow ? (narrowView.value === "check" ? "check" : "console") : bottomView.value;
  const progress = downloadProgress.value;
  const openPicker = () => {
    taskDialogOpen.value = false;
    menuOpen.value = false;
    fileInput.current?.click();
  };
  const openTaskDialog = () => {
    menuOpen.value = false;
    taskDialogOpen.value = true;
  };

  return (
    <div class="app">
      <header class="toolbar">
        {narrow && (
          <button class="menu-button" aria-label={t("workspaces")} onClick={() => (curtainOpen.value = true)}>☰</button>
        )}
        {busy ? (
          <button class="primary stop" aria-label={t("stop")} onClick={stop}>■ {!compactButtons && t("stop")}</button>
        ) : (
          <>
            <button class="primary" aria-label={t("run")} disabled={!canRun} onClick={run}>▶ {!compactButtons && t("run")}</button>
            {canCheck && (
              <button class="check-button" aria-label={t("check")} disabled={!canRun} onClick={check}>✓ {!compactButtons && t("check")}</button>
            )}
          </>
        )}
        <FileName />
        {!narrow && task && !statementOpen.value && (
          <button onClick={() => (statementOpen.value = true)}>{t("statement")}</button>
        )}
        {!narrow && hasBottom && !bottomOpen.value && (
          <button onClick={() => (bottomOpen.value = true)}>{t("console")}</button>
        )}
        <span class="toolbar-status" role="status">
          {progress !== null
            ? t("downloading", { percent: Math.round(progress * 100) })
            : runState.value === "starting"
              ? t("starting")
              : ""}
        </span>
        {narrow ? (
          <div class="menu">
            <button class="menu-button" aria-label={t("more")} aria-expanded={menuOpen.value} onClick={() => (menuOpen.value = !menuOpen.value)}>⋮</button>
            {menuOpen.value && (
              <div class="menu-items" onClick={() => (menuOpen.value = false)}>
                <FileActions onOpen={openPicker} onOpenTask={openTaskDialog} />
              </div>
            )}
          </div>
        ) : (
          <div class="toolbar-actions">
            <FileActions onOpen={openPicker} onOpenTask={openTaskDialog} />
          </div>
        )}
        <input
          ref={fileInput}
          type="file"
          hidden
          accept={isTouch ? undefined : ".py,.pyw,.txt,.pytask"}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) openFile(file);
            event.currentTarget.value = "";
          }}
        />
      </header>

      {!canRun && (
        <p class="banner" role="alert">
          {t(window.coiStatus === "no-service-worker" ? "isolationUnsupported" : "isolationFailed")}
        </p>
      )}

      {!narrow && <WorkspaceTabs />}

      {narrow && (
        <div class="view-tabs" role="tablist">
          {task && (
            <button role="tab" aria-selected={narrowView.value === "statement"} onClick={() => (narrowView.value = "statement")}>{t("statement")}</button>
          )}
          <button role="tab" aria-selected={narrowView.value === "code"} onClick={() => (narrowView.value = "code")}>{t("code")}</button>
          <button role="tab" aria-selected={narrowView.value === "console"} onClick={() => (narrowView.value = "console")}>{t("console")}</button>
          {canCheck && checkProgress.value && (
            <button role="tab" aria-selected={narrowView.value === "check"} onClick={() => (narrowView.value = "check")}>{t("checkTab")}</button>
          )}
        </div>
      )}

      <main class={`layout ${task && !narrow ? "layout-split" : "layout-centered"}`} ref={layoutRef}>
        {task && (
          <section
            class="statement-pane"
            hidden={!showStatement}
            style={!narrow && statementWidth.value ? { flexBasis: `${statementWidth.value}px` } : undefined}
          >
            {!narrow && (
              <button class="pane-close" aria-label={t("closeStatement")} title={t("closeStatement")} onClick={() => (statementOpen.value = false)}>×</button>
            )}
            <Statement task={task} />
          </section>
        )}
        {task && !narrow && statementOpen.value && (
          <div class="column-splitter" role="separator" aria-orientation="vertical" onPointerDown={startStatementResize} />
        )}
        <div class="code-column" ref={columnRef} hidden={narrow && !showCode && !showBottom}>
          <div class="pane editor-pane" ref={editorHost} hidden={!showCode} />
          {!narrow && showBottom && (
            <div class="splitter" role="separator" aria-orientation="horizontal" onPointerDown={startConsoleResize} />
          )}
          <div
            class="pane console-pane"
            hidden={!showBottom}
            style={narrow ? undefined : { height: `${consoleHeight.value}px` }}
          >
            {!narrow && (
              <div class="pane-header">
                {canCheck && checkProgress.value ? (
                  <div class="pane-tabs" role="tablist">
                    <button role="tab" aria-selected={bottomView.value === "console"} onClick={() => (bottomView.value = "console")}>{t("console")}</button>
                    <button role="tab" aria-selected={bottomView.value === "check"} onClick={() => (bottomView.value = "check")}>{t("checkTab")}</button>
                  </div>
                ) : (
                  <span class="pane-title">{t("console")}</span>
                )}
                <button class="pane-close-inline" aria-label={t("closeConsole")} title={t("closeConsole")} onClick={() => (bottomOpen.value = false)}>×</button>
              </div>
            )}
            <div class="terminal-host" ref={terminalHost} hidden={shownBottomView !== "console"} />
            {shownBottomView === "check" && <CheckResults />}
          </div>
        </div>
      </main>

      {isTouch && showCode && editorFocused.value && editorRef.current && <KeyBar editor={editorRef.current} />}
      {showDebug && <DebugLine />}
      {toast.value && <div class="toast" role="status">{toast.value}</div>}
      {dragging.value && <div class="drop-overlay">{t("dropHere")}</div>}
      {curtainOpen.value && <WorkspaceCurtain onClose={() => (curtainOpen.value = false)} />}
      {taskDialogOpen.value && <OpenTaskDialog onClose={() => (taskDialogOpen.value = false)} onPickFile={openPicker} />}
      {levelBlock.value && (
        <div class="curtain-backdrop dialog-backdrop">
          <div class="dialog" role="alertdialog">
            <h2>{levelBlock.value.title}</h2>
            <p>{t("levelTooLow", { level: levelBlock.value.minLevel })}</p>
            <div class="dialog-actions">
              <span class="dialog-spacer" />
              <button class="primary" onClick={() => (levelBlock.value = null)}>{t("ok")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

