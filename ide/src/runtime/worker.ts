// Hosts one interpreter for one program, then gets thrown away. See run.ts for the page side.
import type { PyodideAPI } from "pyodide";
import type { PyProxy } from "pyodide/ffi";
import {
  CTRL,
  FRAME_HEADER,
  PYODIDE_PATH,
  RING_SIZE,
  STDIN_DATA,
  STDIN_EMPTY,
  STDIN_EOF,
  STREAM_STDERR,
  STREAM_STDOUT,
  type ProgramRequest,
  type WorkerCommand,
  type WorkerEvent,
} from "./layout";

const WORKSPACE = "/workspace";

const DRIVER = `
import builtins, importlib, io, os, shutil, sys, time, traceback, types
import _ide

_default_recursion_limit = sys.getrecursionlimit()
_base_path = list(sys.path)
_original_builtins = dict(vars(builtins))
_base_modules = set(sys.modules)

time.sleep = _ide.sleep

def _error_line(tb, entry):
    line = None
    while tb:
        if tb.tb_frame.f_code.co_filename == entry:
            line = tb.tb_lineno
        tb = tb.tb_next
    return line

# Undoes what an earlier program in this interpreter may have changed. Installed packages stay
# imported, because numpy can't be imported twice.
def _reset():
    os.chdir("/")
    for name, module in list(sys.modules.items()):
        if name not in _base_modules and not str(getattr(module, "__file__", "") or "").startswith("/lib"):
            del sys.modules[name]
    importlib.invalidate_caches()
    shutil.rmtree("${WORKSPACE}", ignore_errors=True)
    sys.setrecursionlimit(_default_recursion_limit)
    sys.path[:] = _base_path
    sys.argv[:] = [""]
    time.sleep = _ide.sleep
    namespace = vars(builtins)
    namespace.clear()
    namespace.update(_original_builtins)
    sys.stdout, sys.stderr = sys.__stdout__, sys.__stderr__
    # A new reader, so input a previous program left unread can't reach this one.
    sys.stdin = sys.__stdin__ = io.TextIOWrapper(io.BufferedReader(io.FileIO(0, closefd=False)), encoding="utf-8")

def _run(entry):
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
    os.chdir("${WORKSPACE}")
    sys.path.insert(0, "${WORKSPACE}")
    module = types.ModuleType("__main__")
    module.__file__ = entry
    sys.modules["__main__"] = module
    status, stopped, error_line = 0, False, None
    try:
        with open(entry, encoding="utf-8") as f:
            source = f.read()
        exec(compile(source, entry, "exec"), module.__dict__)
    except SystemExit as e:
        if e.code is None or isinstance(e.code, int):
            status = e.code or 0
        else:
            print(e.code, file=sys.stderr)
            status = 1
    except KeyboardInterrupt:
        status, stopped = 130, True
    except BaseException as e:
        # Drop this driver's own frame, so tracebacks only show the student's code.
        tb = e.__traceback__.tb_next if e.__traceback__ else None
        traceback.print_exception(type(e), e, tb)
        status = 1
        error_line = _error_line(tb, entry)
        if isinstance(e, SyntaxError) and e.filename == entry:
            error_line = e.lineno
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()
        except Exception:
            pass
    return [status, stopped, error_line]
`;

const send = (event: WorkerEvent) => postMessage(event);

type PyProxyDict = PyProxy & { get(name: string): (...args: unknown[]) => PyProxy & { toJs(): unknown } };

let pyodide: PyodideAPI;
let ctrl: Int32Array<SharedArrayBuffer>;
let ringBytes: Uint8Array<SharedArrayBuffer>;
let stdinBytes: Uint8Array<SharedArrayBuffer>;
let bootPromise: Promise<void>;
let driver: PyProxyDict;

// The build allows a 4 GB heap, and a phone's OS kills the tab long before that. Emscripten
// treats a failed grow as out of memory, so going over the limit becomes a MemoryError.
function limitHeap(limitMb: number) {
  const grow = WebAssembly.Memory.prototype.grow;
  WebAssembly.Memory.prototype.grow = function (pages: number) {
    const size = this.buffer.byteLength + pages * 65536;
    if (size > limitMb * 1024 * 1024) throw new RangeError("heap limit reached");
    const previous = grow.call(this, pages);
    Atomics.store(ctrl, CTRL.HEAP_MB, Math.round(size / (1024 * 1024)));
    return previous;
  };
}

function writeFrame(stream: number, bytes: Uint8Array) {
  for (let offset = 0; offset < bytes.length; ) {
    const count = Math.min(bytes.length - offset, RING_SIZE / 2);
    const needed = FRAME_HEADER + count;
    // A full ring blocks the program, so a print flood can't exhaust memory.
    while (true) {
      const tail = Atomics.load(ctrl, CTRL.OUT_TAIL);
      if (RING_SIZE - ((Atomics.load(ctrl, CTRL.OUT_HEAD) - tail) | 0) >= needed) break;
      Atomics.wait(ctrl, CTRL.OUT_TAIL, tail, 50);
      pyodide.checkInterrupt();
    }
    const head = Atomics.load(ctrl, CTRL.OUT_HEAD);
    const put = (byte: number, at: number) => (ringBytes[(head + at) & (RING_SIZE - 1)] = byte);
    put(stream, 0);
    for (let i = 0; i < 4; i++) put((count >>> (8 * i)) & 255, 1 + i);
    for (let i = 0; i < count; i++) put(bytes[offset + i], FRAME_HEADER + i);
    Atomics.store(ctrl, CTRL.OUT_HEAD, (head + needed) | 0);
    offset += count;
  }
}

function readInteractiveLine() {
  Atomics.store(ctrl, CTRL.STDIN_STATE, STDIN_EMPTY);
  send({ type: "stdin-request" });
  while (true) {
    Atomics.wait(ctrl, CTRL.STDIN_STATE, STDIN_EMPTY, 50);
    pyodide.checkInterrupt();
    const state = Atomics.load(ctrl, CTRL.STDIN_STATE);
    if (state === STDIN_EOF) return null as unknown as string;
    if (state === STDIN_DATA) return stdinBytes.slice(0, Atomics.load(ctrl, CTRL.STDIN_LEN));
  }
}

function preloadedReader(data: Uint8Array) {
  let position = 0;
  return (buffer: Uint8Array) => {
    const count = Math.min(buffer.length, data.length - position);
    buffer.set(data.subarray(position, position + count));
    position += count;
    return count;
  };
}

// Replaces time.sleep, which can't be interrupted and would keep running through Stop.
function sleep(seconds: number) {
  const end = performance.now() + seconds * 1000;
  for (let left = end - performance.now(); left > 0; left = end - performance.now()) {
    Atomics.wait(ctrl, CTRL.SLEEP, 0, Math.min(left, 50));
    pyodide.checkInterrupt();
  }
}

async function boot() {
  const started = performance.now();
  const { loadPyodide } = await import(/* @vite-ignore */ `${PYODIDE_PATH}pyodide.mjs`);
  pyodide = await loadPyodide({ indexURL: new URL(PYODIDE_PATH, location.origin).href });
  // Not a tty: otherwise input() writes its prompt to stderr. The driver sets line buffering.
  pyodide.setStdout({ write: (bytes) => (writeFrame(STREAM_STDOUT, bytes), bytes.length), isatty: false });
  pyodide.setStderr({ write: (bytes) => (writeFrame(STREAM_STDERR, bytes), bytes.length), isatty: false });
  pyodide.registerJsModule("_ide", { sleep });
  driver = pyodide.toPy({});
  pyodide.runPython(DRIVER, { globals: driver });
  send({ type: "ready", bootMs: performance.now() - started });
}

function readCollected(names: string[]) {
  const files: Record<string, string | null> = {};
  for (const name of names) {
    try {
      files[name] = pyodide.FS.readFile(`${WORKSPACE}/${name}`, { encoding: "utf8" });
    } catch {
      files[name] = null;
    }
  }
  return files;
}

async function runProgram({ entry, files, stdin, collect = [] }: ProgramRequest) {
  await bootPromise;
  if (stdin) pyodide.setStdin({ read: preloadedReader(stdin), isatty: false });
  else pyodide.setStdin({ stdin: readInteractiveLine, isatty: true });

  // A failed load isn't fatal: the import then fails in the program, with a normal traceback.
  await pyodide
    .loadPackagesFromImports(Object.values(files).join("\n"), { messageCallback: () => {}, errorCallback: () => {} })
    .catch(() => {});

  const run = driver.get("_run");
  driver.get("_reset")();
  pyodide.FS.mkdirTree(WORKSPACE);
  for (const [name, text] of Object.entries(files)) {
    pyodide.FS.writeFile(`${WORKSPACE}/${name}`, text, { encoding: "utf8" });
  }
  send({ type: "started" });

  try {
    const [status, stopped, errorLine] = run(entry).toJs() as [number, boolean, number | null];
    send({ type: "done", status, stopped, errorLine: errorLine ?? null, files: readCollected(collect) });
  } catch (error) {
    // Stop retries its interrupt, and the retry can land while the driver handles the first.
    if (!String(error).includes("KeyboardInterrupt")) throw error;
    send({ type: "done", status: 130, stopped: true, errorLine: null });
  }
}

onmessage = ({ data }: MessageEvent<WorkerCommand>) => {
  const fail = (error: unknown) => {
    send({ type: "fatal", message: String((error as Error)?.message ?? error).slice(0, 500) });
  };
  if (data.type === "boot") {
    ctrl = new Int32Array(data.shared.ctrl);
    ringBytes = new Uint8Array(data.shared.ring);
    stdinBytes = new Uint8Array(data.shared.stdin);
    limitHeap(data.heapLimitMb);
    bootPromise = boot().then(() => pyodide.setInterruptBuffer(new Uint8Array(data.shared.interrupt)));
    bootPromise.catch(fail);
  } else {
    runProgram(data).catch(fail);
  }
};
