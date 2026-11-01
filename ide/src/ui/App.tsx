import { useSignal, useSignalEffect } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { editorPhrases, t } from "../i18n";
import {
  attach,
  canRun,
  cleanFileName,
  codeChanged,
  consoleUsed,
  downloadProgress,
  fileName,
  heapMb,
  openFile,
  renameEntry,
  run,
  runState,
  runWaitMs,
  saveFile,
  saveInBrowser,
  sendEof,
  sendInputLine,
  stop,
  toast,
} from "../session";
import { cycleTheme, language, theme, toggleLanguage } from "../settings";
import { CodeEditor } from "./editor";
import { Terminal } from "./terminal";

const NARROW_QUERY = "(max-width: 799px)";
const CONSOLE_HEIGHT_KEY = "ide-console-height";
const MIN_PANE_PX = 80;
const isTouch = matchMedia("(pointer: coarse)").matches;
const showDebug = new URLSearchParams(location.search).has("debug");

const KEY_BAR_KEYS = [":", "(", ")", "[", "]", "=", '"', "'", "+", "-", "*", "/", "<", ">", ",", ".", "#", "_"];

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

function FileName() {
  const editing = useSignal(false);
  const finish = (value: string | null) => {
    editing.value = false;
    const name = value === null ? null : cleanFileName(value);
    if (name) renameEntry(name);
  };
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

function FileActions({ onOpen }: { onOpen(): void }) {
  return (
    <>
      <button onClick={saveFile}>{t("save")}</button>
      <button onClick={onOpen}>{t("open")}</button>
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

export function App({ initialCode }: { initialCode: string }) {
  useVisibleHeight();
  const isNarrow = useMediaQuery(NARROW_QUERY);
  const view = useSignal<"code" | "console">("code");
  const consoleOpen = useSignal(false);
  const menuOpen = useSignal(false);
  const editorFocused = useSignal(false);
  const consoleHeight = useSignal(Number(safeRead(CONSOLE_HEIGHT_KEY)) || 240);
  const editorHost = useRef<HTMLDivElement>(null);
  const terminalHost = useRef<HTMLDivElement>(null);
  const editorRef = useRef<CodeEditor | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const editor = new CodeEditor({
      parent: editorHost.current!,
      code: initialCode,
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
        consoleOpen.value = true;
        view.value = "console";
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

  const startResize = (event: PointerEvent) => {
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const onMove = (move: PointerEvent) => {
      const bounds = mainRef.current!.getBoundingClientRect();
      consoleHeight.value = Math.min(Math.max(bounds.bottom - move.clientY, MIN_PANE_PX), bounds.height - MIN_PANE_PX);
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      safeWrite(CONSOLE_HEIGHT_KEY, String(Math.round(consoleHeight.value)));
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  };

  const narrow = isNarrow.value;
  const running = runState.value !== "idle";
  const showCode = !narrow || view.value === "code";
  const showConsole = narrow ? view.value === "console" : consoleUsed.value && consoleOpen.value;
  const progress = downloadProgress.value;
  const openPicker = () => {
    menuOpen.value = false;
    fileInput.current?.click();
  };

  return (
    <div class="app">
      <header class="toolbar">
        {running ? (
          <button class="primary stop" onClick={stop}>■ {t("stop")}</button>
        ) : (
          <button class="primary" disabled={!canRun} onClick={run}>▶ {t("run")}</button>
        )}
        <FileName />
        {!narrow && consoleUsed.value && !consoleOpen.value && (
          <button onClick={() => (consoleOpen.value = true)}>{t("console")}</button>
        )}
        <span class="toolbar-status" role="status">
          {progress !== null ? t("downloading", { percent: Math.round(progress * 100) }) : runState.value === "starting" ? t("starting") : ""}
        </span>
        {narrow ? (
          <div class="menu">
            <button aria-label={t("more")} aria-expanded={menuOpen.value} onClick={() => (menuOpen.value = !menuOpen.value)}>⋮</button>
            {menuOpen.value && (
              <div class="menu-items" onClick={() => (menuOpen.value = false)}>
                <FileActions onOpen={openPicker} />
              </div>
            )}
          </div>
        ) : (
          <div class="toolbar-actions">
            <FileActions onOpen={openPicker} />
          </div>
        )}
        <input
          ref={fileInput}
          type="file"
          hidden
          accept={isTouch ? undefined : ".py,.pyw,.txt"}
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

      {narrow && (
        <div class="view-tabs" role="tablist">
          <button role="tab" aria-selected={view.value === "code"} onClick={() => (view.value = "code")}>{t("code")}</button>
          <button role="tab" aria-selected={view.value === "console"} onClick={() => (view.value = "console")}>{t("console")}</button>
        </div>
      )}

      <main class="workspace" ref={mainRef}>
        <div class="pane editor-pane" ref={editorHost} hidden={!showCode} />
        {!narrow && showConsole && (
          <div class="splitter" role="separator" aria-orientation="horizontal" onPointerDown={startResize} />
        )}
        <div
          class="pane console-pane"
          hidden={!showConsole}
          style={narrow ? undefined : { height: `${consoleHeight.value}px` }}
        >
          {!narrow && (
            <button class="console-close" aria-label={t("closeConsole")} title={t("closeConsole")} onClick={() => (consoleOpen.value = false)}>×</button>
          )}
          <div class="terminal-host" ref={terminalHost} />
        </div>
      </main>

      {isTouch && showCode && editorFocused.value && editorRef.current && <KeyBar editor={editorRef.current} />}
      {showDebug && <DebugLine />}
      {toast.value && <div class="toast" role="status">{toast.value}</div>}
    </div>
  );
}

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
