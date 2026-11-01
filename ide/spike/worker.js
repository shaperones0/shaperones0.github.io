// Runs one student program, then exits. See runner.js for the shared memory layout.
import { loadPyodide } from "../pyodide/314.0.7/pyodide.mjs";
import { CTRL, RING_SIZE, STDIN_DATA, STDIN_EOF, STDIN_EMPTY, FRAME_HEADER } from "./layout.js";

const DRIVER = `
import os, sys, time, traceback, types
import _ide

time.sleep = _ide.sleep

def _run():
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
    os.chdir("/workspace")
    sys.path.insert(0, "/workspace")
    module = types.ModuleType("__main__")
    module.__file__ = "main.py"
    sys.modules["__main__"] = module
    status = 0
    try:
        with open("main.py", encoding="utf-8") as f:
            source = f.read()
        exec(compile(source, "main.py", "exec"), module.__dict__)
    except SystemExit as e:
        status = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
    except BaseException as e:
        # Drop this driver's own frame, so tracebacks only show the student's code.
        tb = e.__traceback__.tb_next if e.__traceback__ else None
        traceback.print_exception(type(e), e, tb)
        status = 1
    sys.stdout.flush()
    sys.stderr.flush()
    return status

_run()
`;

let pyodide, ctrl, ringBytes, stdinBytes;

function writeFrame(stream, bytes) {
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
    let head = Atomics.load(ctrl, CTRL.OUT_HEAD);
    const put = (byte, at) => (ringBytes[(head + at) & (RING_SIZE - 1)] = byte);
    put(stream, 0);
    for (let i = 0; i < 4; i++) put((count >>> (8 * i)) & 255, 1 + i);
    for (let i = 0; i < count; i++) put(bytes[offset + i], FRAME_HEADER + i);
    Atomics.store(ctrl, CTRL.OUT_HEAD, (head + needed) | 0);
    offset += count;
  }
}

function readInteractiveLine() {
  Atomics.store(ctrl, CTRL.STDIN_STATE, STDIN_EMPTY);
  postMessage({ type: "stdin-request" });
  while (true) {
    Atomics.wait(ctrl, CTRL.STDIN_STATE, STDIN_EMPTY, 50);
    pyodide.checkInterrupt();
    const state = Atomics.load(ctrl, CTRL.STDIN_STATE);
    if (state === STDIN_EOF) return null;
    if (state === STDIN_DATA) return stdinBytes.slice(0, Atomics.load(ctrl, CTRL.STDIN_LEN));
  }
}

// Replaces time.sleep, which can't be interrupted and would keep running through Stop.
function sleep(seconds) {
  const end = performance.now() + seconds * 1000;
  for (let left = end - performance.now(); left > 0; left = end - performance.now()) {
    Atomics.wait(ctrl, CTRL.SLEEP, 0, Math.min(left, 50));
    pyodide.checkInterrupt();
  }
}

function preloadedReader(data) {
  let position = 0;
  return (buffer) => {
    const count = Math.min(buffer.length, data.length - position);
    buffer.set(data.subarray(position, position + count));
    position += count;
    return count;
  };
}

function listFiles() {
  const files = {};
  for (const name of pyodide.FS.readdir("/workspace")) {
    if (name === "." || name === ".." || name === "main.py") continue;
    files[name] = pyodide.FS.readFile(`/workspace/${name}`, { encoding: "utf8" });
  }
  return files;
}

onmessage = async ({ data: { code, stdin, shared } }) => {
  const started = performance.now();
  ctrl = new Int32Array(shared.ctrl);
  ringBytes = new Uint8Array(shared.ring);
  stdinBytes = new Uint8Array(shared.stdin);

  try {
    pyodide = await loadPyodide({ indexURL: new URL("../pyodide/314.0.7/", import.meta.url).href });
    pyodide.setInterruptBuffer(new Uint8Array(shared.interrupt));
    // Not a tty: otherwise input() writes its prompt to stderr. The driver sets line buffering.
    pyodide.setStdout({ write: (bytes) => (writeFrame(1, bytes), bytes.length), isatty: false });
    pyodide.setStderr({ write: (bytes) => (writeFrame(2, bytes), bytes.length), isatty: false });
    pyodide.registerJsModule("_ide", { sleep });
    if (stdin) pyodide.setStdin({ read: preloadedReader(stdin), isatty: false });
    else pyodide.setStdin({ stdin: readInteractiveLine, isatty: true });
    await pyodide.loadPackagesFromImports(code, { messageCallback: () => {}, errorCallback: () => {} });

    pyodide.FS.mkdirTree("/workspace");
    pyodide.FS.writeFile("/workspace/main.py", code, { encoding: "utf8" });
    postMessage({ type: "ready", bootMs: performance.now() - started });

    const status = pyodide.runPython(DRIVER, { globals: pyodide.toPy({}) });
    postMessage({ type: "done", status: status ?? 0, files: listFiles() });
  } catch (error) {
    postMessage({ type: "fatal", message: String(error?.message ?? error).slice(0, 500) });
  }
};
